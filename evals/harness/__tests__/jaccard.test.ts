import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { tokenize, jaccardSimilarity, ngramSimilarity, textSimilarity, jaccardRankings } from "../jaccard.js";
import { parseBeirDir } from "../../datasets/beir.js";
import type { BeirDataset } from "../../datasets/types.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../../datasets/__fixtures__/mini");

describe("jaccard baseline — primitives", () => {
  it("tokenizes like cognitive-core (lowercase, punctuation->space, keep _)", () => {
    expect(tokenize("Hello, World! foo_bar")).toEqual(["hello", "world", "foo_bar"]);
  });

  it("token Jaccard", () => {
    // {a,b,c} vs {b,c,d}: inter 2, union 4 -> 0.5
    expect(jaccardSimilarity("a b c", "b c d")).toBeCloseTo(0.5, 10);
    expect(jaccardSimilarity("x y", "p q")).toBe(0);
  });

  it("trigram Jaccard of identical text is 1", () => {
    expect(ngramSimilarity("abcabc", "abcabc")).toBeCloseTo(1, 10);
  });

  it("textSimilarity is bounded [0,1] and 1 for identical text", () => {
    const s = textSimilarity("database migration", "database migration");
    expect(s).toBeCloseTo(1, 10);
    const t = textSimilarity("database migration", "vector search");
    expect(t).toBeGreaterThanOrEqual(0);
    expect(t).toBeLessThan(1);
  });
});

describe("jaccard baseline — rankings over the mini fixture", () => {
  let dataset: BeirDataset;

  beforeAll(async () => {
    dataset = { name: "mini", ...(await parseBeirDir(FIXTURE)) };
  });

  it("ranks the lexically-relevant doc first", () => {
    const rankings = jaccardRankings(dataset, 3);
    // q2 "What is BM25 used for?" -> doc2 shares the most tokens (bm25, is, used)
    expect(rankings.get("q2")?.[0]?.docId).toBe("doc2");
    // q1 "How do transformers work in NLP?" -> doc1 retrieved (shares nlp + trigrams)
    expect(rankings.get("q1")?.map((r) => r.docId)).toContain("doc1");
  });

  it("only returns positive-score docs", () => {
    for (const ranked of jaccardRankings(dataset, 10).values()) {
      for (const r of ranked) expect(r.score).toBeGreaterThan(0);
    }
  });
});
