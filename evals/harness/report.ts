/**
 * Report formatting (W4) — JSON + Markdown for a config × metric comparison.
 *
 * Each result is one (dataset, config) scored run. Markdown groups by dataset,
 * one row per config, with a Δ column showing nDCG@k vs a reference config
 * (e.g. "jaccard" baseline or "hybrid"). Pure formatting, no I/O.
 */

import type { AggregateScore, MetricStat } from "./metrics.js";

export interface ConfigResult {
  dataset: string;
  config: string;
  score: AggregateScore;
  /** Optional run metadata surfaced in the report header. */
  meta?: Record<string, string | number>;
}

function fmtStat(s: MetricStat): string {
  return `${s.mean.toFixed(3)} [${s.ci95[0].toFixed(2)},${s.ci95[1].toFixed(2)}]`;
}

function fmtDelta(d: number): string {
  const sign = d > 0 ? "+" : "";
  return `${sign}${(d * 100).toFixed(1)}pp`;
}

export interface ReportOptions {
  /** k for the headline nDCG/Recall/Hit columns (default 10). */
  k?: number;
  /** Config name to diff every row against in the Δ column (e.g. "jaccard"). */
  reference?: string;
}

export function formatMarkdown(results: ConfigResult[], opts?: ReportOptions): string {
  const k = opts?.k ?? 10;
  const lines: string[] = [];
  lines.push(`# Retrieval eval — nDCG@${k} / Recall@${k} / MRR / Hit@${k}`);
  lines.push("");
  lines.push("Metrics show mean [95% bootstrap CI] over judged queries.");
  lines.push("");

  const datasets = [...new Set(results.map((r) => r.dataset))];
  for (const dataset of datasets) {
    const rows = results.filter((r) => r.dataset === dataset);
    const n = rows[0]?.score.numQueries ?? 0;
    lines.push(`## ${dataset} (${n} queries)`);
    lines.push("");

    const ref = opts?.reference ? rows.find((r) => r.config === opts.reference) : undefined;
    const refNdcg = ref?.score.ndcg[k]?.mean;

    const header = ["Config", `nDCG@${k}`, `Recall@${k}`, `MRR@${rows[0]?.score.mrrK ?? 10}`, `Hit@${k}`];
    if (refNdcg !== undefined) header.push(`ΔnDCG vs ${opts!.reference}`);
    lines.push(`| ${header.join(" | ")} |`);
    lines.push(`|${header.map(() => "---").join("|")}|`);

    for (const r of rows) {
      const cells = [
        r.config,
        fmtStat(r.score.ndcg[k]),
        fmtStat(r.score.recall[k]),
        fmtStat(r.score.mrr),
        fmtStat(r.score.hit[k]),
      ];
      if (refNdcg !== undefined) {
        cells.push(r.config === opts!.reference ? "—" : fmtDelta(r.score.ndcg[k].mean - refNdcg));
      }
      lines.push(`| ${cells.join(" | ")} |`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function toJSON(results: ConfigResult[]): string {
  return JSON.stringify(
    results.map((r) => ({
      dataset: r.dataset,
      config: r.config,
      meta: r.meta ?? {},
      numQueries: r.score.numQueries,
      mrrK: r.score.mrrK,
      ndcg: r.score.ndcg,
      recall: r.score.recall,
      hit: r.score.hit,
      mrr: r.score.mrr,
    })),
    null,
    2,
  );
}
