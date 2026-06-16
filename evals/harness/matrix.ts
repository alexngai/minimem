/**
 * Config-matrix runner (W5a).
 *
 * Materializes a corpus ONCE, then runs each config over the same minimem index
 * (all P0 configs are search-time, so embeddings are computed once and reused
 * via the content-hash cache). Configs that need vectors are skipped — and
 * logged, never silently dropped — when no embedding provider is available.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { MinimemConfig } from "../../src/index.js";
import type { BeirDataset } from "../datasets/types.js";
import { materializeCorpus } from "./materialize.js";
import { openIndex, runQueries, type HybridConfig } from "./run.js";
import { jaccardRankings } from "./jaccard.js";
import { scoreRankings, type ScoreOptions } from "./metrics.js";
import type { ConfigResult } from "./report.js";

export interface ConfigSpec {
  name: string;
  kind: "minimem" | "jaccard";
  /** minimem hybrid knobs (search-time). */
  hybrid?: HybridConfig;
}

/** A minimem config uses vector search unless its vectorWeight is 0. */
export function needsVector(spec: ConfigSpec): boolean {
  if (spec.kind !== "minimem") return false;
  return (spec.hybrid?.vectorWeight ?? 0.7) > 0;
}

/**
 * The P0 config matrix (docs/RETRIEVAL-EVAL-P0.md §8). Each row maps to a
 * product decision: lexical baseline, the FTS-mode fix, fusion choice, and the
 * pure-signal ablations.
 */
export const P0_CONFIGS: ConfigSpec[] = [
  { name: "jaccard", kind: "jaccard" },
  { name: "bm25-only-and", kind: "minimem", hybrid: { vectorWeight: 0, textWeight: 1, ftsQueryMode: "and" } },
  { name: "bm25-only-or", kind: "minimem", hybrid: { vectorWeight: 0, textWeight: 1, ftsQueryMode: "or" } },
  { name: "vector-only", kind: "minimem", hybrid: { vectorWeight: 1, textWeight: 0 } },
  { name: "hybrid-weighted-70-30", kind: "minimem", hybrid: { vectorWeight: 0.7, textWeight: 0.3, fusion: "weighted" } },
  { name: "hybrid-rrf", kind: "minimem", hybrid: { fusion: "rrf" } },
  { name: "hybrid-rrf-or", kind: "minimem", hybrid: { fusion: "rrf", ftsQueryMode: "or" } },
];

/** Subset runnable with no embedding provider (lexical + BM25 only). */
export const BM25_CONFIGS: ConfigSpec[] = P0_CONFIGS.filter((c) => !needsVector(c));

export interface RunMatrixOptions {
  embedding: MinimemConfig["embedding"];
  configs?: ConfigSpec[];
  /** Headline k for the report (default 10). */
  k?: number;
  /** k values to score (default [1,5,10,20]). */
  ks?: number[];
  /** Reuse an existing materialized dir; otherwise a temp dir is created. */
  memoryDir?: string;
  scoreOpts?: Partial<ScoreOptions>;
  log?: (msg: string) => void;
}

export interface MatrixOutcome {
  results: ConfigResult[];
  skipped: Array<{ name: string; reason: string }>;
  memoryDir: string;
}

export async function runMatrix(dataset: BeirDataset, opts: RunMatrixOptions): Promise<MatrixOutcome> {
  const log = opts.log ?? (() => {});
  const k = opts.k ?? 10;
  const ks = opts.ks ?? [1, 5, 10, 20];
  const topK = Math.max(k, ...ks);
  const configs = opts.configs ?? P0_CONFIGS;
  const hasEmbeddings = opts.embedding.provider !== "none";
  const scoreOpts: ScoreOptions = { ks, mrrK: Math.min(10, topK), seed: 0x5eed, ...opts.scoreOpts };

  const memoryDir =
    opts.memoryDir ??
    (await fs.mkdtemp(path.join(os.tmpdir(), `minimem-matrix-${dataset.name}-`)));
  const maps = await materializeCorpus(dataset.corpus, memoryDir);
  log(`materialized ${dataset.corpus.size} docs -> ${memoryDir}`);

  const results: ConfigResult[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const spec of configs) {
    if (spec.kind === "jaccard") {
      const ranks = jaccardRankings(dataset, topK);
      results.push({
        dataset: dataset.name,
        config: spec.name,
        score: scoreRankings(ranks, dataset.qrels, scoreOpts),
        meta: { kind: "jaccard" },
      });
      log(`scored ${spec.name} (lexical)`);
      continue;
    }

    if (needsVector(spec) && !hasEmbeddings) {
      skipped.push({ name: spec.name, reason: "needs embeddings; embedding.provider is 'none'" });
      log(`SKIP ${spec.name}: needs embeddings (provider 'none')`);
      continue;
    }

    const mm = await openIndex({
      memoryDir,
      embedding: opts.embedding,
      hybrid: spec.hybrid,
      requireVector: needsVector(spec),
    });
    try {
      const ranks = await runQueries(mm, dataset, maps, { k: topK });
      results.push({
        dataset: dataset.name,
        config: spec.name,
        score: scoreRankings(ranks, dataset.qrels, scoreOpts),
        meta: { kind: "minimem", ...flattenHybrid(spec.hybrid) },
      });
      log(`scored ${spec.name}`);
    } finally {
      mm.close();
    }
  }

  return { results, skipped, memoryDir };
}

function flattenHybrid(h?: HybridConfig): Record<string, string | number> {
  if (!h) return {};
  const out: Record<string, string | number> = {};
  for (const [key, val] of Object.entries(h)) {
    if (val !== undefined) out[key] = val as string | number;
  }
  return out;
}
