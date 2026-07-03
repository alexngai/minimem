/**
 * Unified cost comparison across arms.
 *
 * Reads the per-arm result files written by run.ts (default
 * `results/full-<arm>.json`) and prints a side-by-side token table: ingest,
 * answer, and judge tokens per arm, both absolute (full LOCOMO) and normalized
 * (per conversation / per question).
 *
 * Token counts are the objective comparison. A dollar estimate is printed only
 * if prices are provided via env (per 1M tokens):
 *   LLM_PRICE_IN_PER_M   input/prompt price
 *   LLM_PRICE_OUT_PER_M  output/completion price
 * Judge tokens (total only) are billed at the input price (judge completions
 * are ~1 word), and any arm/phase without a prompt/completion split is billed
 * at the input price.
 *
 * Usage:
 *   npx tsx evals/locomo/cost-report.ts                       # results/full-*.json
 *   npx tsx evals/locomo/cost-report.ts --glob 'results/x-*.json' --out results/cost.md
 */

import fs from "node:fs/promises";
import path from "node:path";

interface Usage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
}
interface CostSummary {
  count: number;
  totalTokens: number;
}
interface SystemBlock {
  score: {
    overallAccuracy: number;
    overallN: number;
    overallCorrect: number;
    ci95: [number, number];
    ingestCost: CostSummary;
    answerCost: CostSummary;
  };
  judgeCost: CostSummary;
  qa: { usage: Usage }[];
}
interface ReportFile {
  config?: unknown;
  systems: Record<string, SystemBlock>;
}

interface ArmCost {
  system: string;
  nConv: number;
  nQA: number;
  accuracy: number;
  ingestTotal: number;
  ingestPrompt: number;
  ingestCompletion: number;
  answerTotal: number;
  answerPrompt: number;
  answerCompletion: number;
  judgeTotal: number;
  grandTotal: number;
}

const PRICE_IN = num(process.env.LLM_PRICE_IN_PER_M);
const PRICE_OUT = num(process.env.LLM_PRICE_OUT_PER_M);
const HAS_PRICING = PRICE_IN !== undefined && PRICE_OUT !== undefined;

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function summarizeArm(system: string, b: SystemBlock): ArmCost {
  const nConv = b.score.ingestCost.count;
  const nQA = b.qa.length;
  const ingestTotal = b.score.ingestCost.totalTokens;
  // Ingest prompt/completion split isn't persisted in CostSummary, so we treat
  // ingest as input-priced (extraction is overwhelmingly prompt tokens).
  const ingestPrompt = ingestTotal;
  const ingestCompletion = 0;

  let answerPrompt = 0;
  let answerCompletion = 0;
  let answerTotal = 0;
  for (const r of b.qa) {
    answerPrompt += r.usage.promptTokens ?? 0;
    answerCompletion += r.usage.completionTokens ?? 0;
    answerTotal += r.usage.totalTokens ?? 0;
  }
  const judgeTotal = b.judgeCost.totalTokens;
  const grandTotal = ingestTotal + answerTotal + judgeTotal;

  return {
    system,
    nConv,
    nQA,
    accuracy: b.score.overallAccuracy,
    ingestTotal,
    ingestPrompt,
    ingestCompletion,
    answerTotal,
    answerPrompt,
    answerCompletion,
    judgeTotal,
    grandTotal,
  };
}

/** Estimated USD; judge + ingest billed at input price (see header). */
function dollars(a: ArmCost): number {
  if (!HAS_PRICING) return 0;
  const inTok = a.ingestPrompt + a.answerPrompt + a.judgeTotal;
  const outTok = a.ingestCompletion + a.answerCompletion;
  return (inTok / 1e6) * (PRICE_IN as number) + (outTok / 1e6) * (PRICE_OUT as number);
}

function fmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

function buildTable(arms: ArmCost[]): string {
  const lines: string[] = [];
  const priceNote = HAS_PRICING
    ? ` (in $${PRICE_IN}/M, out $${PRICE_OUT}/M)`
    : " (set LLM_PRICE_IN_PER_M / LLM_PRICE_OUT_PER_M for $ estimate)";
  lines.push(`# LOCOMO cost comparison${priceNote}`);
  lines.push("");
  const header = [
    "arm",
    "acc%",
    "conv",
    "QA",
    "ingest tok",
    "ingest/conv",
    "answer tok",
    "answer/q",
    "judge/q",
    "TOTAL tok",
    ...(HAS_PRICING ? ["est $"] : []),
  ];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const a of arms) {
    const row = [
      a.system,
      (a.accuracy * 100).toFixed(1),
      String(a.nConv),
      String(a.nQA),
      fmt(a.ingestTotal),
      fmt(a.nConv ? a.ingestTotal / a.nConv : 0),
      fmt(a.answerTotal),
      fmt(a.nQA ? a.answerTotal / a.nQA : 0),
      fmt(a.nQA ? a.judgeTotal / a.nQA : 0),
      fmt(a.grandTotal),
      ...(HAS_PRICING ? [`$${dollars(a).toFixed(2)}`] : []),
    ];
    lines.push(`| ${row.join(" | ")} |`);
  }
  lines.push("");
  lines.push(
    "> Token counts are the objective axis. Ingest tokens for extraction arms " +
      "(mem0, cogcore-memory) are the one-time cost of building memory; retrieval-only " +
      "arms (minimem-alone, cogcore-retrieval) have zero ingest LLM cost.",
  );
  return lines.join("\n");
}

async function main() {
  const glob = arg("--glob");
  const dir = path.resolve("evals/locomo/results");
  let files: string[];
  if (glob) {
    files = [path.resolve(glob)];
  } else {
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    files = entries.filter((f) => f.startsWith("full-") && f.endsWith(".json")).map((f) => path.join(dir, f));
  }
  if (files.length === 0) {
    process.stderr.write(`No result files found (looked in ${dir} for full-*.json).\n`);
    process.exit(1);
  }

  const arms: ArmCost[] = [];
  for (const f of files) {
    try {
      const data = JSON.parse(await fs.readFile(f, "utf-8")) as ReportFile;
      for (const [sys, block] of Object.entries(data.systems)) {
        arms.push(summarizeArm(sys, block));
      }
    } catch (e) {
      process.stderr.write(`skip ${f}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }

  // Stable ladder order when present.
  const order = ["minimem-alone", "cogcore-retrieval", "cogcore-memory", "mem0", "letta"];
  arms.sort((a, b) => {
    const ia = order.indexOf(a.system);
    const ib = order.indexOf(b.system);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const table = buildTable(arms);
  process.stdout.write(table + "\n");

  const out = arg("--out");
  if (out) {
    const outPath = path.resolve(out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, table + "\n", "utf-8");
    process.stderr.write(`\nWrote ${outPath}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
