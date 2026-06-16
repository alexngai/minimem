/**
 * Offline smoke test for the retrieval harness (W3).
 *
 * Uses node:test (NOT vitest) because it exercises node:sqlite + sqlite-vec,
 * which don't run under this repo's vitest setup. Runs fully offline with
 * BM25-only (provider "none") against the committed `mini` fixture.
 *
 * Run with:
 *   npx tsx --test evals/harness/__tests__/harness.smoke.test.ts
 */

import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBeirDir } from "../../datasets/beir.js";
import type { BeirDataset } from "../../datasets/types.js";
import { materializeCorpus, type CorpusMaps } from "../materialize.js";
import { openIndex, runQueries } from "../run.js";
import type { Minimem } from "../../../src/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../../datasets/__fixtures__/mini");

describe("eval harness (offline, BM25-only)", () => {
  let dataset: BeirDataset;
  let dir: string;
  let mm: Minimem;
  let maps: CorpusMaps;

  before(async () => {
    dataset = { name: "mini", ...(await parseBeirDir(FIXTURE)) };
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-harness-"));
    maps = await materializeCorpus(dataset.corpus, dir);
    // OR mode so a multi-word query still matches (the fixture is tiny).
    // RRF fusion fuses by rank position, so it is unaffected by minimem's
    // (currently inverted) bm25RankToScore — see the W3 finding. This test
    // validates the harness plumbing under a correct fusion, not the scorer.
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

  it("materializes one memory file per corpus doc", async () => {
    assert.equal(maps.idToPath.size, 3);
    assert.equal(maps.idToPath.get("doc2"), "memory/doc2.md");
    const files = (await fs.readdir(path.join(dir, "memory"))).sort();
    assert.deepEqual(files, ["doc1.md", "doc2.md", "doc3.md"]);
  });

  it("retrieves the relevant doc and aggregates chunks->docs", async () => {
    const rankings = await runQueries(mm, dataset, maps, { k: 3 });

    // q2 "What is BM25 used for?" -> doc2 is the relevant doc (qrels score 2).
    const q2 = rankings.get("q2");
    assert.ok(q2 && q2.length > 0, "q2 returns ranked docs");
    assert.equal(q2[0].docId, "doc2", "relevant doc ranks #1 for q2");

    // q1 "How do transformers work in NLP?" -> doc1 is relevant (qrels score 2).
    const q1 = rankings.get("q1");
    assert.ok(q1, "q1 returns ranked docs");
    assert.ok(
      q1.map((r) => r.docId).includes("doc1"),
      "q1 retrieves the relevant doc1",
    );

    // every returned id maps to a real corpus doc (no stray files leaked).
    for (const ranked of rankings.values()) {
      for (const r of ranked) {
        assert.ok(dataset.corpus.has(r.docId), `${r.docId} is a corpus doc`);
      }
    }
  });
});
