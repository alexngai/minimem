/**
 * CI gate (offline, BM25-only): run the fixture matrix THROUGH swarmkit-eval and check the committed
 * nDCG@10 baseline — minimem's regression guard, now on the package (replaces the retired
 * harness/__tests__/matrix.smoke.test.ts). Also pins the FTS-mode finding (AND collapses to 0 on NL
 * queries). node:test (not vitest) because it exercises node:sqlite + sqlite-vec.
 *
 *   npx tsx --test evals/swarmkit/__tests__/gate.smoke.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runEval,
  InProcessBackend,
  LocalResultStore,
  buildReport,
  checkGate,
  type EvalConfig,
  type Baseline,
} from "swarmkit-eval";
import { parseBeirDir } from "../../datasets/beir.js";
import { MINIMEM_CONFIGS, needsVector, configArms, beirBenchmark, rankingAdapter } from "../beir-swarmkit.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../../datasets/__fixtures__/mini");
const BASELINE = path.join(HERE, "../../baselines/mini.json");

describe("swarmkit-eval gate (offline, BM25-only fixture)", () => {
  it("runs the fixture matrix through swarmkit-eval and passes the nDCG@10 gate", async () => {
    const dataset = { name: "mini", ...(await parseBeirDir(FIXTURE)) };
    const configs = MINIMEM_CONFIGS.filter((c) => !needsVector(c)); // jaccard + bm25-only-{and,or}
    const benchmark = beirBenchmark(dataset, configs, { k: 10 });
    const store = await fs.mkdtemp(path.join(os.tmpdir(), "swk-gate-"));
    const config: EvalConfig = {
      runId: "mini",
      configVersion: "v0",
      benchmark: benchmark.id,
      arms: configArms(configs),
      models: [{ name: "none" }],
      seeds: [1],
      backend: "in-process",
      concurrency: { cells: 4, modelConnections: 1, resources: 2 },
      retry: { maxAttempts: 1, baseDelayMs: 0 },
      output: { dir: store, trace: false },
    };

    const results = await runEval(config, {
      benchmark,
      backend: new InProcessBackend(),
      store: new LocalResultStore(store),
      adapter: rankingAdapter(),
    });
    const report = buildReport(results, config, { baselineArmId: "jaccard" });

    const baseline = JSON.parse(await fs.readFile(BASELINE, "utf-8")) as Baseline;
    const gate = checkGate(report.aggregates, baseline, {
      baseline: BASELINE,
      thresholds: [{ metric: "ndcg@10", direction: "not-decrease", tolerance: 0.02 }],
    });
    assert.ok(gate.passed, `gate failed: ${JSON.stringify(gate.violations)}`);

    // Pin the known fixture behaviour (the W3 FTS-mode finding).
    const ndcg = (arm: string) =>
      report.aggregates.find((a) => a.armId === arm)?.metrics?.["ndcg@10"]?.mean ?? -1;
    assert.ok(ndcg("bm25-only-or") > 0.8, "bm25-only-or recovers on NL queries");
    assert.equal(ndcg("bm25-only-and"), 0, "bm25-only-and collapses to 0 on NL queries");
  });
});
