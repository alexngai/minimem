/**
 * CI gate (W5a): the free, offline, BM25-only matrix run on the fixture, checked
 * against a committed nDCG@10 baseline. Guards against silent retrieval
 * regressions. Also pins the FTS-mode finding (AND collapses to 0 on NL queries).
 *
 * node:test (not vitest) — exercises node:sqlite + sqlite-vec.
 *   npx tsx --test evals/harness/__tests__/matrix.smoke.test.ts
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBeirDir } from "../../datasets/beir.js";
import { runMatrix, P0_CONFIGS } from "../matrix.js";
import { checkRegression, type Baseline } from "../gate.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../../datasets/__fixtures__/mini");
const BASELINE = path.join(HERE, "../../baselines/mini-bm25.json");

describe("CI gate: BM25-only matrix on the fixture", () => {
  it("runs the full matrix, skips vector configs, and meets the baseline", async () => {
    const dataset = { name: "mini", ...(await parseBeirDir(FIXTURE)) };

    const { results, skipped } = await runMatrix(dataset, {
      embedding: { provider: "none" },
      configs: P0_CONFIGS,
      k: 10,
    });

    // Vector configs are skipped (and reported) under provider "none".
    const skippedNames = skipped.map((s) => s.name).sort();
    assert.deepEqual(skippedNames, [
      "hybrid-rrf",
      "hybrid-rrf-or",
      "hybrid-weighted-70-30",
      "vector-only",
    ]);

    // The 3 lexical/BM25 configs ran.
    const ran = results.map((r) => r.config).sort();
    assert.deepEqual(ran, ["bm25-only-and", "bm25-only-or", "jaccard"]);

    // Regression gate vs the committed baseline.
    const baseline = JSON.parse(await fs.readFile(BASELINE, "utf-8")) as Baseline;
    const gate = checkRegression(results, baseline, { k: 10, tolerance: 0.02 });
    assert.ok(
      gate.ok,
      `nDCG@10 regression: ${gate.failures
        .map((f) => `${f.key} ${f.actual.toFixed(3)} < ${f.baseline.toFixed(3)}`)
        .join(", ")}`,
    );
    assert.deepEqual(gate.missing, [], "every run config should be in the baseline");

    // Pin the FTS-mode finding: AND collapses to 0 on NL queries; OR recovers.
    const byName = new Map(results.map((r) => [r.config, r.score.ndcg[10].mean]));
    assert.equal(byName.get("bm25-only-and"), 0, "AND mode returns nothing on NL queries");
    assert.ok((byName.get("bm25-only-or") ?? 0) > 0, "OR mode recovers matches");
  });
});
