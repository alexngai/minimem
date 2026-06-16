/**
 * End-to-end harness smoke (W3 + W4): materialize -> index -> run -> score ->
 * report, plus the Jaccard baseline. Offline, BM25-only (provider "none").
 *
 * node:test (not vitest) because it exercises node:sqlite + sqlite-vec.
 *   npx tsx --test evals/harness/__tests__/end-to-end.smoke.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBeirDir } from "../../datasets/beir.js";
import type { BeirDataset } from "../../datasets/types.js";
import { materializeCorpus, openIndex, runQueries, type CorpusMaps } from "../index.js";
import { jaccardRankings } from "../jaccard.js";
import { scoreRankings } from "../metrics.js";
import { formatMarkdown, toJSON, type ConfigResult } from "../report.js";
import type { Minimem } from "../../../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../../datasets/__fixtures__/mini");

describe("end-to-end: index -> run -> score -> report (offline)", () => {
  let dataset: BeirDataset;
  let dir: string;
  let mm: Minimem;
  let maps: CorpusMaps;

  before(async () => {
    dataset = { name: "mini", ...(await parseBeirDir(FIXTURE)) };
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-e2e-"));
    maps = await materializeCorpus(dataset.corpus, dir);
    mm = await openIndex({
      memoryDir: dir,
      embedding: { provider: "none" },
      hybrid: { ftsQueryMode: "or", fusion: "rrf" },
    });
  });

  after(async () => {
    mm?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("scores minimem + jaccard baseline and renders a report", async () => {
    const ks = [1, 3];
    const mmRankings = await runQueries(mm, dataset, maps, { k: 10 });
    const jacRankings = jaccardRankings(dataset, 10);

    const results: ConfigResult[] = [
      {
        dataset: dataset.name,
        config: "bm25-rrf",
        score: scoreRankings(mmRankings, dataset.qrels, { ks, mrrK: 10, bootstrap: 200, seed: 1 }),
      },
      {
        dataset: dataset.name,
        config: "jaccard",
        score: scoreRankings(jacRankings, dataset.qrels, { ks, mrrK: 10, bootstrap: 200, seed: 1 }),
      },
    ];

    for (const r of results) {
      assert.equal(r.score.numQueries, 2);
      for (const k of ks) {
        const nd = r.score.ndcg[k].mean;
        assert.ok(nd >= 0 && nd <= 1, `${r.config} nDCG@${k} in [0,1]`);
      }
    }

    const md = formatMarkdown(results, { k: 3, reference: "jaccard" });
    assert.ok(md.includes("nDCG@3"), "report has nDCG@3 column");
    assert.ok(md.includes("bm25-rrf") && md.includes("jaccard"), "report has both config rows");
    assert.ok(md.includes("mini (2 queries)"), "report has dataset header");
    assert.ok(md.includes("ΔnDCG vs jaccard"), "report has delta column");

    const json = JSON.parse(toJSON(results)) as Array<{ numQueries: number }>;
    assert.equal(json.length, 2);
    assert.equal(json[0].numQueries, 2);
  });
});
