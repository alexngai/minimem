/**
 * Regression gate (W5a). Compares a matrix run's nDCG@k against a committed
 * baseline and fails if any config drops beyond a tolerance. Used by the free
 * CI gate (BM25-only on the fixture) to guard against silent retrieval
 * regressions.
 */

import type { ConfigResult } from "./report.js";

/** Baseline map: "dataset::config" -> nDCG@k mean. */
export type Baseline = Record<string, number>;

export function baselineKey(dataset: string, config: string): string {
  return `${dataset}::${config}`;
}

export interface GateResult {
  ok: boolean;
  failures: Array<{ key: string; baseline: number; actual: number; drop: number }>;
  /** Configs present in the run but absent from the baseline (new — not failures). */
  missing: string[];
}

export function checkRegression(
  results: ConfigResult[],
  baseline: Baseline,
  opts: { k: number; tolerance: number },
): GateResult {
  const failures: GateResult["failures"] = [];
  const missing: string[] = [];
  for (const r of results) {
    const key = baselineKey(r.dataset, r.config);
    const actual = r.score.ndcg[opts.k]?.mean ?? 0;
    const base = baseline[key];
    if (base === undefined) {
      missing.push(key);
      continue;
    }
    if (actual < base - opts.tolerance) {
      failures.push({ key, baseline: base, actual, drop: base - actual });
    }
  }
  return { ok: failures.length === 0, failures, missing };
}

/** Build a baseline map from results (to (re)generate the committed baseline). */
export function buildBaseline(results: ConfigResult[], k: number): Baseline {
  const b: Baseline = {};
  for (const r of results) b[baselineKey(r.dataset, r.config)] = r.score.ndcg[k]?.mean ?? 0;
  return b;
}
