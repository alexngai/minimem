/**
 * Acceptance test: reproduce minimem's scifact `bm25-only-or` nDCG@10 ≈ 0.656 (evals/results/scifact-bm25.md)
 * THROUGH swarmkit-eval — proving the retrieval seam (ResourceSpec corpus + retrieval grader) end-to-end
 * with minimem as an external client of the package.
 *
 *   npx tsx evals/swarmkit/run-scifact.ts
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEval, InProcessBackend, LocalResultStore, type EvalConfig } from "swarmkit-eval";
import { loadBeirDataset } from "../datasets/beir.js";
import { beirBenchmark, minimemRetrievalAdapter } from "./beir-swarmkit.js";

const ARM = "bm25-only-or";
const EXPECTED = 0.656; // minimem native run: evals/results/scifact-bm25.md
const K = 10;

async function main(): Promise<void> {
  const dataset = await loadBeirDataset("scifact");
  const benchmark = beirBenchmark(
    dataset,
    { [ARM]: { hybrid: { vectorWeight: 0, textWeight: 1, ftsQueryMode: "or" }, embedding: { provider: "none" } } },
    K,
  );
  const out = await mkdtemp(join(tmpdir(), "beir-scifact-run-"));
  const config: EvalConfig = {
    runId: "beir-scifact",
    configVersion: "v0",
    benchmark: benchmark.id,
    arms: [{ id: ARM, label: "BM25 (OR)", scaffold: {} }],
    models: [{ name: "bm25" }],
    seeds: [1],
    backend: "in-process",
    concurrency: { cells: 1, modelConnections: 1, resources: 1 }, // serial cells: one shared sqlite index
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    output: { dir: out, trace: false },
  };

  const t0 = Date.now();
  const results = await runEval(config, {
    benchmark,
    backend: new InProcessBackend(),
    store: new LocalResultStore(out),
    adapter: minimemRetrievalAdapter(K),
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);

  const scored = results.filter((r) => r.score?.metrics?.[`ndcg@${K}`] !== undefined);
  const meanOf = (key: string): number =>
    scored.reduce((s, r) => s + (r.score!.metrics![key] ?? 0), 0) / scored.length;
  const ndcg = meanOf(`ndcg@${K}`);

  console.log(
    `[beir/scifact ${ARM}] queries=${scored.length} nDCG@${K}=${ndcg.toFixed(3)} ` +
      `Recall@${K}=${meanOf(`recall@${K}`).toFixed(3)} MRR@${K}=${meanOf(`mrr@${K}`).toFixed(3)} ` +
      `Hit@${K}=${meanOf(`hit@${K}`).toFixed(3)} (expected nDCG≈${EXPECTED}) in ${secs}s`,
  );

  const ok = Math.abs(ndcg - EXPECTED) <= 0.01;
  console.log(
    ok
      ? `✅ reproduces minimem's scifact ${ARM} nDCG@${K} through swarmkit-eval`
      : `❌ nDCG@${K} ${ndcg.toFixed(3)} is off from ${EXPECTED} by ${(ndcg - EXPECTED).toFixed(3)}`,
  );
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
