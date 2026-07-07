/**
 * LongMemEval retrieval-only grader — minimem's hybrid search scored against
 * turn/session evidence labels (recall@k / MRR), via swarmkit-eval's memory-QA
 * harness. No LLM answering, no extraction: this is the raw-turn retrieval floor.
 *
 *   npx tsx evals/longmemeval/retrieval.ts --arms none --sample 50 --ks 5,10,20
 *   npx tsx evals/longmemeval/retrieval.ts --arms none,local --sample 100 --k 10 --out lme-retrieval.md
 *
 * Arms: none (BM25) | local (embeddinggemma hybrid RRF) | nomic (ollama hybrid RRF).
 * The first arm is the A/B baseline when 2+ arms are given.
 */

import fs from "node:fs/promises";

import {
  evaluateMemoryQARetrieval,
  compareMemoryQARetrieval,
  formatMemoryQARetrievalAB,
  type MemoryQARetrievalReport,
} from "swarmkit-eval";

import { loadLongMemEvalCached, sampleInstances } from "./dataset.js";
import { createMinimemSearch, type Embeddings } from "./minimem-search.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

const KNOWN_ARMS: Embeddings[] = ["none", "local", "nomic"];

function parseArms(spec: string | boolean | undefined): Embeddings[] {
  if (!spec || spec === true) return ["none"];
  const arms = String(spec)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Embeddings[];
  for (const a of arms) {
    if (!KNOWN_ARMS.includes(a)) throw new Error(`Unknown arm '${a}'. Use ${KNOWN_ARMS.join("|")}.`);
  }
  return arms;
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function formatReport(report: MemoryQARetrievalReport): string {
  const cats = Object.keys(report.byCategory).sort();
  const lines = [
    `${report.provider} — recall@${report.k} ${pct(report.overall.recallAtK)}  ` +
      `MRR ${report.overall.mrr.toFixed(3)}  (n=${report.overall.n})`,
    `  ${"category".padEnd(28)} ${"recall".padStart(7)} ${"mrr".padStart(6)}   n`,
  ];
  for (const c of cats) {
    const s = report.byCategory[c]!;
    lines.push(`  ${c.padEnd(28)} ${pct(s.recallAtK).padStart(7)} ${s.mrr.toFixed(3).padStart(6)}   ${s.n}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const arms = parseArms(args.arms);
  const k = args.k ? Number(args.k) : 10;
  const ks = args.ks ? String(args.ks).split(",").map(Number) : [k];
  const sample = args.sample ? Number(args.sample) : undefined;

  const log = (m: string) => process.stderr.write(`[lme] ${m}\n`);

  const all = loadLongMemEvalCached();
  const instances = sampleInstances(all, sample);
  log(`loaded ${all.length} instances, using ${instances.length} (arms: ${arms.join(", ")}, ks: ${ks.join(",")})`);

  const sections: string[] = [`# LongMemEval retrieval (n=${instances.length})\n`];

  // reports[arm][k] — for A/B and the summary table.
  const reports = new Map<Embeddings, Map<number, MemoryQARetrievalReport>>();

  for (const arm of arms) {
    let builtCount = 0;
    const searcher = createMinimemSearch(arm, {
      onIndexBuilt: () => {
        builtCount++;
        if (builtCount % 25 === 0) log(`  [${arm}] indexed ${builtCount}/${instances.length}`);
      },
    });
    try {
      const perK = new Map<number, MemoryQARetrievalReport>();
      for (const kk of ks) {
        const started = Date.now();
        const report = await evaluateMemoryQARetrieval(instances, arm, searcher.search, { k: kk });
        perK.set(kk, report);
        log(`  [${arm}] k=${kk}: recall ${pct(report.overall.recallAtK)} MRR ${report.overall.mrr.toFixed(3)} (${((Date.now() - started) / 1000).toFixed(1)}s)`);
      }
      reports.set(arm, perK);
      sections.push(`## arm: ${arm}\n`);
      for (const kk of ks) sections.push("```\n" + formatReport(perK.get(kk)!) + "\n```\n");
    } finally {
      await searcher.close();
    }
  }

  // A/B vs the first arm at each k.
  if (arms.length >= 2) {
    const base = arms[0]!;
    sections.push(`## A/B vs ${base}\n`);
    for (const arm of arms.slice(1)) {
      for (const kk of ks) {
        const ab = compareMemoryQARetrieval(reports.get(base)!.get(kk)!, reports.get(arm)!.get(kk)!);
        sections.push("```\n" + formatMemoryQARetrievalAB(ab) + "\n```\n");
      }
    }
  }

  // Compact overall summary.
  const summary = ["## summary (recall@k)\n", "```", `${"arm".padEnd(10)} ${ks.map((kk) => `k=${kk}`.padStart(8)).join(" ")}`];
  for (const arm of arms) {
    const row = ks.map((kk) => pct(reports.get(arm)!.get(kk)!.overall.recallAtK).padStart(8)).join(" ");
    summary.push(`${arm.padEnd(10)} ${row}`);
  }
  summary.push("```\n");
  sections.push(summary.join("\n"));

  const md = sections.join("\n");
  if (args.out) {
    await fs.writeFile(String(args.out), md + "\n");
    log(`wrote ${String(args.out)}`);
  } else {
    process.stdout.write(md + "\n");
  }
}

main().catch((err) => {
  process.stderr.write(`[lme] error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
