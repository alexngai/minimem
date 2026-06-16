import { describe, it, expect } from "vitest";

import {
  dcg,
  ndcgAtK,
  recallAtK,
  reciprocalRankAtK,
  hitAtK,
  mean,
  scoreRankings,
} from "../metrics.js";
import type { RankedDoc } from "../run.js";

const qrel = (entries: Record<string, number>) => new Map(Object.entries(entries));
const ranked = (...ids: string[]): RankedDoc[] => ids.map((docId, i) => ({ docId, score: 1 - i * 0.01 }));

describe("metrics — per query (hand-verified)", () => {
  it("dcg uses log2(rank+1) discount", () => {
    // 3/log2(2) + 2/log2(3) + 1/log2(4) = 3 + 1.261859 + 0.5
    expect(dcg([3, 2, 1], 3)).toBeCloseTo(4.761859, 5);
  });

  it("ndcg@k normalizes by the ideal ranking", () => {
    // ranking [a,b,c], rel a=2 c=1: DCG=2.5, IDCG=2.6309298 -> 0.9502340
    const nd = ndcgAtK(["a", "b", "c"], qrel({ a: 2, c: 1 }), 3);
    expect(nd).toBeCloseTo(0.95023, 4);
  });

  it("ndcg@k is 1.0 for a perfect ranking and 0 with no relevants", () => {
    expect(ndcgAtK(["a", "b"], qrel({ a: 2, b: 1 }), 2)).toBeCloseTo(1, 10);
    expect(ndcgAtK(["a", "b"], qrel({}), 2)).toBe(0);
  });

  it("recall@k = relevant retrieved / total relevant", () => {
    const q = qrel({ a: 2, c: 1 });
    expect(recallAtK(["a", "b", "c"], q, 1)).toBeCloseTo(0.5, 10);
    expect(recallAtK(["a", "b", "c"], q, 3)).toBeCloseTo(1, 10);
  });

  it("MRR = 1/rank of first relevant", () => {
    expect(reciprocalRankAtK(["b", "a", "c"], qrel({ a: 2, c: 1 }), 10)).toBeCloseTo(0.5, 10);
    expect(reciprocalRankAtK(["a"], qrel({ a: 1 }), 10)).toBeCloseTo(1, 10);
    expect(reciprocalRankAtK(["b", "c"], qrel({ a: 1 }), 10)).toBe(0);
  });

  it("hit@k is 1 iff a relevant doc is in the top k", () => {
    expect(hitAtK(["b", "a"], qrel({ a: 1 }), 2)).toBe(1);
    expect(hitAtK(["b", "a"], qrel({ a: 1 }), 1)).toBe(0);
  });

  it("mean handles empty", () => {
    expect(mean([])).toBe(0);
    expect(mean([1, 2, 3])).toBe(2);
  });
});

describe("metrics — scoreRankings aggregate", () => {
  const rankings = new Map<string, RankedDoc[]>([
    ["q1", ranked("a", "b", "c")], // a relevant @1
    ["q2", ranked("x", "y", "z")], // y relevant @2
  ]);
  const qrels = new Map<string, Map<string, number>>([
    ["q1", qrel({ a: 1 })],
    ["q2", qrel({ y: 1 })],
  ]);

  it("aggregates means over judged queries with CIs", () => {
    const s = scoreRankings(rankings, qrels, { ks: [1, 3], mrrK: 10, bootstrap: 500, seed: 7 });
    expect(s.numQueries).toBe(2);
    // recall@1: q1 hit (1.0), q2 miss (0.0) -> mean 0.5
    expect(s.recall[1].mean).toBeCloseTo(0.5, 10);
    // recall@3: both found -> 1.0
    expect(s.recall[3].mean).toBeCloseTo(1, 10);
    // MRR: q1 1/1, q2 1/2 -> mean 0.75
    expect(s.mrr.mean).toBeCloseTo(0.75, 10);
    // CI brackets the mean
    expect(s.mrr.ci95[0]).toBeLessThanOrEqual(s.mrr.mean);
    expect(s.mrr.ci95[1]).toBeGreaterThanOrEqual(s.mrr.mean);
  });

  it("is deterministic for a fixed seed", () => {
    const a = scoreRankings(rankings, qrels, { seed: 42, bootstrap: 300 });
    const b = scoreRankings(rankings, qrels, { seed: 42, bootstrap: 300 });
    expect(a).toEqual(b);
  });

  it("penalizes a missing ranking as zero (not skipped)", () => {
    const partial = new Map([["q1", ranked("a")]]); // q2 absent
    const s = scoreRankings(partial, qrels, { ks: [1], bootstrap: 200, seed: 1 });
    expect(s.numQueries).toBe(2); // still scores both judged queries
    expect(s.recall[1].mean).toBeCloseTo(0.5, 10); // q1 hit, q2 zero
  });
});
