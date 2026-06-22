/**
 * Run minimem's BEIR retrieval evals through **swarmkit-eval** (minimem as the client; design §3c/§4d,
 * D6/D15). This is minimem's PRIMARY eval path — it replaces the hand-rolled `evals/harness/`
 * matrix+metrics+report+gate with the package, keeping only minimem's domain pieces (corpus
 * materialization, the minimem index + `runQueries`, and the Jaccard baseline ranker).
 *
 * The mapping:
 *   - each search config (bm25 / vector / hybrid / jaccard) is an **Arm** (the independent variable);
 *   - the per-arm ranking set is a `ResourceSpec` — built once per arm (materialize + index + run all
 *     queries, or the Jaccard precompute), shared by every query-cell;
 *   - each judged query is a **cell**; the adapter looks up that query's ranking;
 *   - scoring is `{ kind: "retrieval", k, ks }` (qrels → nDCG/Recall/Precision/MRR/Hit, with per-arm CIs).
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BenchmarkAdapter, ExecutionAdapter, ResourceSpec, EvalTask, RunContext, Arm } from "swarmkit-eval";
import type { MinimemConfig } from "../../src/index.js";
import type { BeirDataset } from "../datasets/types.js";
import { materializeCorpus } from "../harness/materialize.js";
import { openIndex, runQueries, type HybridConfig, type RankedDoc } from "../harness/run.js";
import { jaccardRankings } from "../harness/jaccard.js";

/** One search configuration = one swarmkit arm. */
export interface RetrievalConfig {
  id: string;
  label: string;
  kind: "minimem" | "jaccard";
  hybrid?: HybridConfig;
}

/** The P0 config matrix as arms (mirrors the retired `harness/matrix.ts` P0_CONFIGS). */
export const MINIMEM_CONFIGS: RetrievalConfig[] = [
  { id: "jaccard", label: "Jaccard (lexical)", kind: "jaccard" },
  { id: "bm25-only-and", label: "BM25 (AND)", kind: "minimem", hybrid: { vectorWeight: 0, textWeight: 1, ftsQueryMode: "and" } },
  { id: "bm25-only-or", label: "BM25 (OR)", kind: "minimem", hybrid: { vectorWeight: 0, textWeight: 1, ftsQueryMode: "or" } },
  { id: "vector-only", label: "Vector", kind: "minimem", hybrid: { vectorWeight: 1, textWeight: 0 } },
  { id: "hybrid-weighted-70-30", label: "Hybrid weighted 70/30", kind: "minimem", hybrid: { vectorWeight: 0.7, textWeight: 0.3, fusion: "weighted" } },
  { id: "hybrid-rrf", label: "Hybrid RRF", kind: "minimem", hybrid: { fusion: "rrf" } },
  { id: "hybrid-rrf-or", label: "Hybrid RRF (OR)", kind: "minimem", hybrid: { fusion: "rrf", ftsQueryMode: "or" } },
];

/** A config needs an embedding provider iff it uses vector search. */
export function needsVector(c: RetrievalConfig): boolean {
  return c.kind === "minimem" && (c.hybrid?.vectorWeight ?? 0.7) > 0;
}

/** swarmkit arms for a set of configs (arm id = config id). */
export function configArms(configs: RetrievalConfig[]): Arm[] {
  return configs.map((c) => ({ id: c.id, label: c.label, scaffold: {} }));
}

export interface BeirBenchmarkOpts {
  embedding?: MinimemConfig["embedding"];
  /** Headline cutoff (default 10). */
  k?: number;
  /** Cutoffs to score at (default `[k]`; pass `[1,5,10,20]` for a full sweep). */
  ks?: number[];
}

interface RankingValue {
  rankings: Map<string, RankedDoc[]>;
}

/**
 * A swarmkit-eval {@link BenchmarkAdapter} for a BEIR dataset over a set of minimem search configs. Each
 * config's ranking set is a {@link ResourceSpec} built once (the expensive materialize + index + search,
 * or the Jaccard precompute) and shared by every query-cell.
 */
export function beirBenchmark(dataset: BeirDataset, configs: RetrievalConfig[], opts: BeirBenchmarkOpts = {}): BenchmarkAdapter {
  const id = `beir/${dataset.name}`;
  const k = opts.k ?? 10;
  const ks = opts.ks ?? [k];
  const topK = Math.max(k, ...ks);
  const embedding = opts.embedding ?? { provider: "none" };
  const byId = new Map(configs.map((c) => [c.id, c]));

  const rankings: ResourceSpec = {
    id: "rankings",
    scope: ["benchmark", "arm"], // one ranking set per config (arm); shared across that arm's query-cells
    // Folds the invalidation axes into the persistent ResourceCache key: dataset + corpus size +
    // arm (= search config) + embedding provider/model. NOT minimem's retrieval code version, so
    // clear the cache dir after changing chunking/scoring that would alter rankings.
    cacheKey: (cell) => `${dataset.name}:n${dataset.corpus.size}:${cell.arm.id}:${embedding.provider}:${embedding.model ?? "default"}`,
    async build(ctx) {
      const cfg = byId.get(ctx.cell.arm.id);
      if (!cfg) throw new Error(`no retrieval config for arm '${ctx.cell.arm.id}'`);
      if (cfg.kind === "jaccard") {
        // Pure lexical baseline — no index needed; minimem's exact jaccardRankings.
        return { value: { rankings: jaccardRankings(dataset, topK) } satisfies RankingValue, async stop() {} };
      }
      // Vector arms differ only in *search-time* fusion/fts-mode, so they share one per-dataset
      // index dir: the first vector arm embeds the corpus; the rest reuse it (sync is a no-op when
      // content hashes match — no re-embed). With a throttle-limited remote provider this turns 4×
      // corpus embedding into 1×. The dir is PERSISTENT (under .eval-cache, not /tmp) and keyed by
      // dataset+model, so a crashed/throttled run resumes from the content-hash embedding cache
      // instead of re-embedding from scratch — the one-time embedding cost is paid once. BM25/jaccard
      // arms get their own throwaway dir + `provider: "none"` (they never read vectors, so they can't
      // pollute the shared dir with un-embedded chunks, and skip the embed entirely). Relies on serial
      // resource builds so the first vector arm finishes before the others read it — see cli.ts.
      const armEmbedding = needsVector(cfg) ? embedding : ({ provider: "none" } as const);
      const memoryDir = needsVector(cfg)
        ? join(process.cwd(), ".eval-cache", "beir-vec-shared", `${dataset.name}-${(embedding.model ?? "default").replace(/[^A-Za-z0-9._-]/g, "_")}`)
        : await mkdtemp(join(tmpdir(), `beir-${dataset.name}-${cfg.id}-`));
      const maps = await materializeCorpus(dataset.corpus, memoryDir);
      const mm = await openIndex({ memoryDir, embedding: armEmbedding, hybrid: cfg.hybrid, requireVector: needsVector(cfg) });
      try {
        return { value: { rankings: await runQueries(mm, dataset, maps, { k: topK }) } satisfies RankingValue, async stop() {} };
      } finally {
        mm.close(); // rankings are computed; the index is no longer needed
      }
    },
  };

  return {
    id,
    execution: "native",
    grader: { kind: "retrieval", k, ks },
    resources: [rankings],
    async load(): Promise<EvalTask[]> {
      const tasks: EvalTask[] = [];
      for (const [qid, qtext] of dataset.queries) {
        const qrel = dataset.qrels.get(qid);
        if (!qrel || qrel.size === 0) continue;
        const grades: Record<string, number> = {};
        const relevant: string[] = [];
        for (const [docId, g] of qrel) {
          grades[docId] = g;
          if (g > 0) relevant.push(docId);
        }
        if (relevant.length === 0) continue; // judged-positive queries only (BEIR convention)
        tasks.push({ id: qid, benchmark: id, prompt: qtext, relevance: { relevant, grades } });
      }
      return tasks;
    },
  };
}

/** The retrieval SUT: look up this query's ranking from its arm's precomputed resource → `RawRun.ranked`. */
export function rankingAdapter(): ExecutionAdapter {
  return {
    id: "minimem-retrieval",
    placement: "backend",
    async run(cell, ctx: RunContext) {
      const { rankings } = ctx.resources!.rankings!.value as RankingValue;
      const ranked = (rankings.get(cell.task.id) ?? []).map((d, i) => ({ id: d.docId, score: d.score, rank: i + 1 }));
      return { output: "", usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, trajectory: [], durationMs: 0, ranked };
    },
  };
}
