/**
 * Run minimem's BEIR retrieval evals through **swarmkit-eval** (design §3c/§4d, D6/D15 — minimem as the
 * client of the package). The mapping:
 *   - the corpus index is a swarmkit `ResourceSpec` (built once per arm, scope `[benchmark, arm]`, so each
 *     search-config arm gets its own minimem instance over the materialized corpus);
 *   - each judged query is a cell; the minimem-search adapter fills `RawRun.ranked`;
 *   - scoring is `{ kind: "retrieval", k }` (qrels → nDCG@k / Recall@k / MRR / Precision@k).
 * Everything else (matrix, store/resume, the shared-resource lifecycle, aggregation, paired CIs) is the
 * package. This file owns only the minimem-specific seams.
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BenchmarkAdapter,
  ExecutionAdapter,
  ResourceSpec,
  EvalTask,
  RunContext,
} from "swarmkit-eval";
import type { Minimem, MinimemConfig } from "../../src/index.js";
import type { BeirDataset } from "../datasets/types.js";
import { materializeCorpus, type CorpusMaps } from "../harness/materialize.js";
import { openIndex, type HybridConfig } from "../harness/run.js";

/** Per-arm minimem configuration — the independent variable (a search strategy). */
export interface BeirArmConfig {
  hybrid?: HybridConfig;
  embedding?: MinimemConfig["embedding"];
}

/** What the corpus ResourceSpec hands every query-cell: an opened minimem index + the path→doc map. */
interface CorpusValue {
  mm: Minimem;
  maps: CorpusMaps;
}

/**
 * A swarmkit-eval {@link BenchmarkAdapter} for a BEIR dataset, driven by minimem. The expensive corpus
 * index is a {@link ResourceSpec} built once per arm and shared by every query-cell.
 */
export function beirBenchmark(
  dataset: BeirDataset,
  arms: Record<string, BeirArmConfig>,
  k = 10,
): BenchmarkAdapter {
  const id = `beir/${dataset.name}`;
  const corpus: ResourceSpec = {
    id: "corpus",
    scope: ["benchmark", "arm"], // one minimem index per search-config arm; shared across that arm's queries
    cacheKey: (cell) => `${dataset.name}:${cell.arm.id}`,
    async build(ctx) {
      const armCfg = arms[ctx.cell.arm.id] ?? {};
      const memoryDir = await mkdtemp(join(tmpdir(), `beir-${dataset.name}-${ctx.cell.arm.id}-`));
      const maps = await materializeCorpus(dataset.corpus, memoryDir);
      const mm = await openIndex({
        memoryDir,
        embedding: armCfg.embedding ?? { provider: "none" },
        hybrid: armCfg.hybrid,
        requireVector: false,
      });
      const value: CorpusValue = { mm, maps };
      return {
        value,
        async stop() {
          mm.close();
        },
      };
    },
  };

  return {
    id,
    execution: "native",
    grader: { kind: "retrieval", k },
    resources: [corpus],
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
        if (relevant.length === 0) continue; // judged-positive queries only (BEIR convention; matches minimem)
        tasks.push({ id: qid, benchmark: id, prompt: qtext, relevance: { relevant, grades } });
      }
      return tasks;
    },
  };
}

/**
 * The minimem search SUT: per query-cell, search the shared index and aggregate chunk hits → a doc
 * ranking (max chunk score per doc, top-k) — the same chunk→doc reduction minimem's `runQueries` uses, so
 * the rankings (hence the metrics) match a native minimem eval run.
 */
export function minimemRetrievalAdapter(k = 10): ExecutionAdapter {
  const overfetch = Math.min(200, Math.max(k * 10, 50));
  return {
    id: "minimem-search",
    placement: "backend",
    async run(cell, ctx: RunContext) {
      const { mm, maps } = ctx.resources!.corpus!.value as CorpusValue;
      const hits = await mm.search(cell.task.prompt, { maxResults: overfetch, minScore: 0, skipStaleCheck: true });
      const byDoc = new Map<string, number>();
      for (const hit of hits) {
        const docId = maps.pathToId.get(hit.path);
        if (docId === undefined) continue;
        const prev = byDoc.get(docId);
        if (prev === undefined || hit.score > prev) byDoc.set(docId, hit.score);
      }
      const ranked = [...byDoc.entries()]
        .map(([docId, score]) => ({ docId, score }))
        .sort((a, b) => b.score - a.score)
        .slice(0, k)
        .map((d, i) => ({ id: d.docId, score: d.score, rank: i + 1 }));
      return {
        output: "",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        trajectory: [],
        durationMs: 0,
        ranked,
      };
    },
  };
}
