/**
 * Model-free retrieval metrics computed from qrels (W4).
 *
 * nDCG uses linear gain and a log2(rank+1) discount — the trec_eval /
 * pytrec_eval `ndcg_cut` convention BEIR reports. Validate once against
 * pytrec_eval (see validate-pytrec.md); thereafter these are self-contained.
 *
 * All functions are pure (no node:sqlite), so they run under vitest.
 */

import type { RankedDoc } from "./run.js";

/** Seeded PRNG (mulberry32) — reproducible bootstrap, no Math.random. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Discounted cumulative gain over an ordered list of (graded) relevances. */
export function dcg(rels: number[], k: number): number {
  let sum = 0;
  const lim = Math.min(k, rels.length);
  for (let i = 0; i < lim; i++) {
    sum += rels[i] / Math.log2(i + 2); // 1-based rank (i+1) -> log2(rank+1)
  }
  return sum;
}

export function ndcgAtK(ranked: string[], qrel: Map<string, number>, k: number): number {
  const gains = ranked.slice(0, k).map((id) => Math.max(0, qrel.get(id) ?? 0));
  const ideal = [...qrel.values()].filter((r) => r > 0).sort((a, b) => b - a);
  const idcg = dcg(ideal, k);
  return idcg === 0 ? 0 : dcg(gains, k) / idcg;
}

export function recallAtK(ranked: string[], qrel: Map<string, number>, k: number): number {
  const relevant = new Set(
    [...qrel.entries()].filter(([, r]) => r > 0).map(([id]) => id),
  );
  if (relevant.size === 0) return 0;
  let found = 0;
  for (const id of ranked.slice(0, k)) if (relevant.has(id)) found++;
  return found / relevant.size;
}

export function reciprocalRankAtK(ranked: string[], qrel: Map<string, number>, k: number): number {
  const lim = Math.min(k, ranked.length);
  for (let i = 0; i < lim; i++) {
    if ((qrel.get(ranked[i]) ?? 0) > 0) return 1 / (i + 1);
  }
  return 0;
}

export function hitAtK(ranked: string[], qrel: Map<string, number>, k: number): number {
  const lim = Math.min(k, ranked.length);
  for (let i = 0; i < lim; i++) {
    if ((qrel.get(ranked[i]) ?? 0) > 0) return 1;
  }
  return 0;
}

export function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length;
}

/** Percentile bootstrap 95% CI of the mean, over queries. */
export function bootstrapCI(
  values: number[],
  rng: () => number,
  iterations = 1000,
): [number, number] {
  if (values.length === 0) return [0, 0];
  const means: number[] = [];
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[Math.floor(rng() * values.length)];
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const lo = means[Math.floor(0.025 * iterations)];
  const hi = means[Math.min(iterations - 1, Math.floor(0.975 * iterations))];
  return [lo, hi];
}

export interface MetricStat {
  mean: number;
  ci95: [number, number];
}

export interface AggregateScore {
  numQueries: number;
  ndcg: Record<number, MetricStat>;
  recall: Record<number, MetricStat>;
  hit: Record<number, MetricStat>;
  /** MRR truncated at mrrK. */
  mrr: MetricStat;
  mrrK: number;
}

export interface ScoreOptions {
  ks?: number[];
  mrrK?: number;
  bootstrap?: number;
  seed?: number;
}

function byK(ks: number[], f: (k: number) => MetricStat): Record<number, MetricStat> {
  const out: Record<number, MetricStat> = {};
  for (const k of ks) out[k] = f(k);
  return out;
}

/**
 * Score per-query rankings against qrels. Scores only queries that have at
 * least one judged relevant doc (BEIR convention); a query with no ranking
 * scores 0 across the board (penalizing misses, not skipping them).
 */
export function scoreRankings(
  rankings: Map<string, RankedDoc[]>,
  qrels: Map<string, Map<string, number>>,
  opts?: ScoreOptions,
): AggregateScore {
  const ks = opts?.ks ?? [1, 5, 10, 20];
  const mrrK = opts?.mrrK ?? 10;
  const iterations = opts?.bootstrap ?? 1000;
  const rng = mulberry32(opts?.seed ?? 0x9e3779b9);

  const qids = [...qrels.keys()].filter((q) => (qrels.get(q)?.size ?? 0) > 0);

  const ndcgV: Record<number, number[]> = {};
  const recallV: Record<number, number[]> = {};
  const hitV: Record<number, number[]> = {};
  for (const k of ks) {
    ndcgV[k] = [];
    recallV[k] = [];
    hitV[k] = [];
  }
  const mrrV: number[] = [];

  for (const qid of qids) {
    const ranked = (rankings.get(qid) ?? []).map((r) => r.docId);
    const qrel = qrels.get(qid)!;
    for (const k of ks) {
      ndcgV[k].push(ndcgAtK(ranked, qrel, k));
      recallV[k].push(recallAtK(ranked, qrel, k));
      hitV[k].push(hitAtK(ranked, qrel, k));
    }
    mrrV.push(reciprocalRankAtK(ranked, qrel, mrrK));
  }

  const stat = (values: number[]): MetricStat => ({
    mean: mean(values),
    ci95: bootstrapCI(values, rng, iterations),
  });

  return {
    numQueries: qids.length,
    ndcg: byK(ks, (k) => stat(ndcgV[k])),
    recall: byK(ks, (k) => stat(recallV[k])),
    hit: byK(ks, (k) => stat(hitV[k])),
    mrr: stat(mrrV),
    mrrK,
  };
}
