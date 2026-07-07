/**
 * Metrics for the LOCOMO benchmark: per-category accuracy, the cost axis
 * (tokens + latency percentiles), and bootstrap confidence intervals.
 *
 * Accuracy follows the LOCOMO/mem0 convention: adversarial questions
 * (category 5) are excluded from the headline accuracy number.
 */

import type { LocomoCategory, QAResult, UsageStats } from "./types.js";

export interface CategoryAccuracy {
  category: LocomoCategory;
  n: number;
  correct: number;
  accuracy: number;
}

export interface CostSummary {
  count: number;
  totalTokens: number;
  meanTokens: number;
  latencyP50Ms: number;
  latencyP95Ms: number;
  meanLatencyMs: number;
}

export interface SystemScore {
  system: string;
  /** Excludes adversarial (category 5). */
  overallAccuracy: number;
  overallN: number;
  overallCorrect: number;
  ci95: [number, number];
  byCategory: CategoryAccuracy[];
  ingestCost: CostSummary;
  answerCost: CostSummary;
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1),
  );
  return sortedAsc[idx];
}

export function summarizeCost(usages: UsageStats[]): CostSummary {
  const count = usages.length;
  const totalTokens = usages.reduce((s, u) => s + (u.totalTokens ?? 0), 0);
  const latencies = usages.map((u) => u.latencyMs).sort((a, b) => a - b);
  const meanLatencyMs =
    count === 0 ? 0 : latencies.reduce((s, x) => s + x, 0) / count;
  return {
    count,
    totalTokens,
    meanTokens: count === 0 ? 0 : totalTokens / count,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    meanLatencyMs,
  };
}

/**
 * Seeded PRNG (mulberry32) so bootstrap CIs are reproducible.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Bootstrap 95% CI for the mean of a 0/1 flag array.
 */
export function bootstrapCI(
  flags: number[],
  { iterations = 2000, seed = 1 }: { iterations?: number; seed?: number } = {},
): [number, number] {
  if (flags.length === 0) return [0, 0];
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let i = 0; i < iterations; i++) {
    let sum = 0;
    for (let j = 0; j < flags.length; j++) {
      sum += flags[Math.floor(rand() * flags.length)];
    }
    means.push(sum / flags.length);
  }
  means.sort((a, b) => a - b);
  return [percentile(means, 2.5), percentile(means, 97.5)];
}

/**
 * Score one system's QA results. `ingestUsage` is the per-conversation ingest
 * accounting; answer cost is derived from the QA results themselves.
 */
export function scoreSystem(
  system: string,
  qa: QAResult[],
  ingestUsage: UsageStats[],
): SystemScore {
  // Headline accuracy excludes adversarial (category 5) and unjudged rows.
  const nonAdversarial = qa.filter((r) => r.categoryId !== 5 && r.correct !== null);

  const flags: number[] = nonAdversarial.map((r) => (r.correct ? 1 : 0));
  const correct = flags.reduce((s, x) => s + x, 0);
  const n = flags.length;

  const byCategoryMap = new Map<LocomoCategory, { n: number; correct: number }>();
  for (const r of qa) {
    if (r.correct === null) continue;
    const cur = byCategoryMap.get(r.category) ?? { n: 0, correct: 0 };
    cur.n += 1;
    cur.correct += r.correct ? 1 : 0;
    byCategoryMap.set(r.category, cur);
  }
  const byCategory: CategoryAccuracy[] = [...byCategoryMap.entries()].map(
    ([category, { n: cn, correct: cc }]) => ({
      category,
      n: cn,
      correct: cc,
      accuracy: cn === 0 ? 0 : cc / cn,
    }),
  );

  return {
    system,
    overallAccuracy: n === 0 ? 0 : correct / n,
    overallN: n,
    overallCorrect: correct,
    ci95: bootstrapCI(flags),
    byCategory,
    ingestCost: summarizeCost(ingestUsage),
    answerCost: summarizeCost(qa.map((r) => r.usage)),
  };
}
