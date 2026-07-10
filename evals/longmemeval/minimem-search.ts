/**
 * minimem retrieval adapter for swarmkit-eval's memory-QA grader.
 *
 * Bridges the store-neutral `MemQADocument[]` a benchmark instance produces
 * (`instanceToDocuments`) into a minimem index, exposes a `MemoryQASearchFn`
 * that returns ranked *document ids* (so the grader can score them against the
 * benchmark's evidence turn/session labels), and tears the indexes down.
 *
 * This is the RAW-TURN retrieval floor the cognitive-core arms sit on: it tests
 * minimem's hybrid (BM25 + vector RRF) search directly, with no LLM extraction
 * (extracted notes would carry note-ids, not turn-ids, so they can't be scored
 * against turn-level evidence labels — that's the QA harness's job, not this).
 *
 * Indexes are memoized per instance id, so a benchmark with many questions over
 * one shared haystack (LoCoMo) builds each index once; LongMemEval has one
 * question per instance so each is built once regardless.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MemQADocument, MemoryQARankedResult } from "swarmkit-eval";

import { Minimem } from "../../src/index.js";
import { acquireLocalEmbeddingLease, type LocalEmbeddingLease } from "../local-embedding-lock.js";

/**
 * Retrieval embedding backend (mirrors the cogcore arms):
 * - `none`   — BM25 full-text only (no embeddings, no external services)
 * - `local`  — minimem's node-llama-cpp model (embeddinggemma-300M), hybrid RRF
 * - `nomic`  — Ollama `nomic-embed-text` via the OpenAI-compatible endpoint,
 *              hybrid RRF (apples-to-apples with the mem0 arm)
 */
export type Embeddings = "none" | "local" | "nomic";

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

type MinimemArgs = Parameters<typeof Minimem.create>[0];

function embeddingConfig(embeddings: Embeddings): Pick<MinimemArgs, "embedding" | "hybrid"> {
  if (embeddings === "none") {
    return {
      embedding: { provider: "none" },
      hybrid: { enabled: true, vectorWeight: 0, textWeight: 1, ftsQueryMode: "or" },
    };
  }
  if (embeddings === "nomic") {
    return {
      embedding: {
        provider: "openai",
        model: "nomic-embed-text",
        openai: { baseUrl: `${OLLAMA_URL}/v1`, apiKey: "ollama" },
      },
      hybrid: { enabled: true, fusion: "rrf" },
    };
  }
  return {
    embedding: { provider: "local" },
    hybrid: { enabled: true, fusion: "rrf" },
  };
}

interface BuiltIndex {
  dir: string;
  mm: Minimem;
  lease: LocalEmbeddingLease | null;
  /** note basename → document id (resolve search hits back to the doc id). */
  byBase: Map<string, string>;
}

export interface MinimemSearch {
  /** The `MemoryQASearchFn` passed to `evaluateMemoryQARetrieval`. */
  search: (
    query: string,
    docs: MemQADocument[],
    opts: { maxResults: number },
  ) => Promise<MemoryQARankedResult[]>;
  /**
   * Close + delete a single instance's index, freeing its loaded embedding
   * model. The QA harness calls this right after retrieval so the (memory-heavy)
   * local model isn't held during the LLM answer/judge phase — bounding live
   * embedding models to ~1 even under concurrency.
   */
  evict: (instanceId: string) => Promise<void>;
  /** Tear down every index built during the run. */
  close: () => Promise<void>;
}

export interface MinimemSearchOptions {
  scratchRoot?: string;
  /**
   * Internal per-query fetch multiplier. minimem chunks note files, so several
   * hits can map to one document; we over-fetch then dedupe by document id to
   * still return `maxResults` distinct docs. Also bounded below by `minFetch`.
   */
  fetchMultiplier?: number;
  minFetch?: number;
  /** Optional progress hook: called with the built index count. */
  onIndexBuilt?: (instanceId: string, docCount: number) => void;
}

/** Build the minimem-backed `MemoryQASearchFn` for a given embedding backend. */
export function createMinimemSearch(
  embeddings: Embeddings,
  opts: MinimemSearchOptions = {},
): MinimemSearch {
  const scratchRoot = opts.scratchRoot ?? os.tmpdir();
  const fetchMultiplier = opts.fetchMultiplier ?? 4;
  const minFetch = opts.minFetch ?? 50;
  const built = new Map<string, BuiltIndex>();
  const inflight = new Map<string, Promise<BuiltIndex>>();

  async function buildIndex(instanceId: string, docs: MemQADocument[]): Promise<BuiltIndex> {
    const dir = await fs.mkdtemp(path.join(scratchRoot, "lme-mm-"));
    const notesDir = path.join(dir, "memory");
    await fs.mkdir(notesDir, { recursive: true });

    const byBase = new Map<string, string>();
    let n = 0;
    for (const doc of docs) {
      const base = `doc-${String(n).padStart(6, "0")}.md`;
      await fs.writeFile(path.join(notesDir, base), `${doc.text}\n`, "utf-8");
      byBase.set(base, doc.id);
      n++;
    }

    const lease = await acquireLocalEmbeddingLease(embeddings, {
      label: `longmemeval:${instanceId}`,
    });
    let mm: Minimem | null = null;
    try {
      mm = await Minimem.create({
        memoryDir: dir,
        dbPath: path.join(dir, "index.db"),
        ...embeddingConfig(embeddings),
        query: { maxResults: Math.max(minFetch, docs.length), minScore: 0 },
        watch: { enabled: false },
      });
      await mm.sync({ reason: "ingest" });

      const idx: BuiltIndex = { dir, mm, lease, byBase };
      built.set(instanceId, idx);
      opts.onIndexBuilt?.(instanceId, docs.length);
      return idx;
    } catch (err) {
      try {
        await mm?.close?.();
      } catch {
        // Preserve the original build failure.
      }
      await lease?.release();
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      throw err;
    }
  }

  /** Get (or build) an index, deduping concurrent requests for the same instance
   *  and serializing the actual build against every other build. */
  function getIndex(instanceId: string, docs: MemQADocument[]): Promise<BuiltIndex> {
    const existing = built.get(instanceId);
    if (existing) return Promise.resolve(existing);
    const pending = inflight.get(instanceId);
    if (pending) return pending;

    const p = buildIndex(instanceId, docs);
    inflight.set(instanceId, p);
    p.finally(() => inflight.delete(instanceId));
    return p;
  }

  async function search(
    query: string,
    docs: MemQADocument[],
    { maxResults }: { maxResults: number },
  ): Promise<MemoryQARankedResult[]> {
    const instanceId = docs[0]?.instanceId ?? "unknown";
    const idx = await getIndex(instanceId, docs);

    const fetch = Math.max(minFetch, maxResults * fetchMultiplier);
    const hits = await idx.mm.search(query, {
      maxResults: fetch,
      minScore: 0,
      skipStaleCheck: true,
    });

    // minimem chunks files → dedupe to the best-ranked chunk per document id.
    const seen = new Set<string>();
    const ranked: MemoryQARankedResult[] = [];
    for (const hit of hits) {
      const id = idx.byBase.get(path.basename(hit.path));
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ranked.push({ id, score: hit.score, rank: ranked.length + 1 });
    }
    return ranked;
  }

  async function evict(instanceId: string): Promise<void> {
    const idx = built.get(instanceId);
    if (!idx) return;
    built.delete(instanceId);
    try {
      await idx.mm.close?.();
    } finally {
      await idx.lease?.release();
    }
    await fs.rm(idx.dir, { recursive: true, force: true }).catch(() => {});
  }

  async function close(): Promise<void> {
    for (const idx of built.values()) {
      try {
        await idx.mm.close?.();
      } finally {
        await idx.lease?.release();
      }
      await fs.rm(idx.dir, { recursive: true, force: true }).catch(() => {});
    }
    built.clear();
  }

  return { search, evict, close };
}
