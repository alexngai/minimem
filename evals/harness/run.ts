/**
 * Run BEIR queries through a minimem index and return per-query document
 * rankings (for qrels-based scoring in the metrics layer, W4).
 *
 * Design notes:
 * - All P0 configs (fusion / fts-mode / weights) are search-time, so a single
 *   materialized corpus + index is reused across configs (embeddings are
 *   content-hash cached). Each config is a fresh `Minimem` whose `hybrid.*`
 *   fields differ; pointing it at the same memoryDir reuses the built index.
 * - minimem returns CHUNK-level hits; BEIR qrels are DOC-level. We over-fetch
 *   chunks and aggregate to docs by max-chunk score (see RETRIEVAL-EVAL.md §6-C).
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Minimem, type MinimemConfig } from "../../src/index.js";
import type { BeirDataset } from "../datasets/types.js";
import { materializeCorpus, type CorpusMaps } from "./materialize.js";

/** Hybrid knobs under test. Mirrors MinimemConfig["hybrid"]. */
export type HybridConfig = NonNullable<MinimemConfig["hybrid"]>;

export interface RankedDoc {
  docId: string;
  score: number;
}

export interface OpenIndexOptions {
  memoryDir: string;
  embedding: MinimemConfig["embedding"];
  hybrid?: HybridConfig;
  /** Require sqlite-vec to be loaded. Defaults to true unless provider is "none". */
  requireVector?: boolean;
}

/**
 * Open (and build, if needed) a minimem index over an already-materialized
 * corpus dir. Hard-fails if a capability the run depends on is unavailable, so
 * a degraded config never produces a silently-wrong number.
 */
export async function openIndex(opts: OpenIndexOptions): Promise<Minimem> {
  const mm = await Minimem.create({
    memoryDir: opts.memoryDir,
    embedding: opts.embedding,
    watch: { enabled: false },
    hybrid: opts.hybrid,
    query: { minScore: 0 },
    // Keep the whole corpus in the content-hash embedding cache (default prunes to 10k). The shared
    // vector dir is persistent, so this makes a crashed/throttled run resume without re-embedding.
    cache: { maxEntries: 5_000_000 },
    // Concurrent corpus embedding. Default 4 concurrent single-text requests — the
    // throttle-safe sweet spot for Bedrock Titan via LiteLLM (~520 emb/min, zero 429s;
    // higher just trips the account's TPS cap). Override per-backend via env, e.g. a real
    // OpenAI endpoint tolerates much more: MM_EMBED_CONCURRENCY=16 MM_EMBED_BATCH=16.
    indexing: {
      embedConcurrency: Number(process.env.MM_EMBED_CONCURRENCY) || 4,
      embedBatchSize: Number(process.env.MM_EMBED_BATCH) || 1,
    },
  });

  await mm.sync();
  const status = await mm.status();

  if (!status.ftsAvailable) {
    mm.close();
    throw new Error(
      "FTS5 unavailable — retrieval eval needs it (BM25/hybrid). Aborting rather than degrading silently.",
    );
  }
  const requireVector = opts.requireVector ?? opts.embedding.provider !== "none";
  if (requireVector && !status.vectorAvailable) {
    mm.close();
    throw new Error(
      "sqlite-vec unavailable — vector search would silently fall back. Aborting. " +
        "Set embedding.provider to 'none' for an intentional BM25-only run.",
    );
  }
  return mm;
}

export interface RunQueriesOptions {
  /** Top-k documents to return per query. */
  k?: number;
  /** Chunk over-fetch to recover top-k DOCS (bounded by minimem's 200 cap). */
  overfetch?: number;
}

/**
 * Run every query in the dataset and return ranked document ids per query.
 * Chunk hits are aggregated to documents by max-chunk score, then truncated to k.
 */
export async function runQueries(
  mm: Minimem,
  dataset: BeirDataset,
  maps: CorpusMaps,
  opts?: RunQueriesOptions,
): Promise<Map<string, RankedDoc[]>> {
  const k = opts?.k ?? 10;
  // Over-fetch chunks so a doc with several chunks doesn't crowd out top-k docs.
  // minimem caps internal candidates at 200, so that's the hard ceiling.
  const overfetch = Math.min(200, Math.max(opts?.overfetch ?? k * 10, 50));

  const rankings = new Map<string, RankedDoc[]>();

  for (const [qid, qtext] of dataset.queries) {
    // Corpus is static during a run and openIndex already synced, so skip the
    // per-query staleness sweep (otherwise it stats every corpus file each call).
    const hits = await mm.search(qtext, { maxResults: overfetch, minScore: 0, skipStaleCheck: true });

    // chunk -> doc: keep the best (max) chunk score per document.
    const byDoc = new Map<string, number>();
    for (const hit of hits) {
      const docId = maps.pathToId.get(hit.path);
      if (docId === undefined) continue; // stray non-corpus file (defensive)
      const prev = byDoc.get(docId);
      if (prev === undefined || hit.score > prev) byDoc.set(docId, hit.score);
    }

    const ranked = [...byDoc.entries()]
      .map(([docId, score]) => ({ docId, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, k);

    rankings.set(qid, ranked);
  }

  return rankings;
}

export interface RunDatasetOptions {
  embedding: MinimemConfig["embedding"];
  hybrid?: HybridConfig;
  k?: number;
  /** Reuse an existing materialized dir; otherwise a temp dir is created. */
  memoryDir?: string;
}

/**
 * Convenience for single-config use: materialize → build → run → rankings.
 * (The W5 config sweep materializes once and calls openIndex/runQueries per
 * config to reuse the index across configs.)
 */
export async function runDataset(
  dataset: BeirDataset,
  opts: RunDatasetOptions,
): Promise<{ rankings: Map<string, RankedDoc[]>; memoryDir: string; maps: CorpusMaps }> {
  const memoryDir =
    opts.memoryDir ??
    (await fs.mkdtemp(path.join(os.tmpdir(), `minimem-eval-${dataset.name}-`)));
  const maps = await materializeCorpus(dataset.corpus, memoryDir);
  const mm = await openIndex({ memoryDir, embedding: opts.embedding, hybrid: opts.hybrid });
  try {
    const rankings = await runQueries(mm, dataset, maps, { k: opts.k });
    return { rankings, memoryDir, maps };
  } finally {
    mm.close();
  }
}
