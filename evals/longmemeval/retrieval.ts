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
  instanceToDocuments,
  scopedTurnId,
  compareMemoryQARetrieval,
  formatMemoryQARetrievalAB,
  type MemQAInstance,
  type MemoryQARetrievalReport,
} from "swarmkit-eval";

import { loadLongMemEvalCached, sampleInstances } from "./dataset.js";
import { createMinimemSearch, type Embeddings, type MinimemSearch } from "./minimem-search.js";

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

interface Acc {
  hits: number;
  rr: number;
  n: number;
}
const emptyAcc = (): Acc => ({ hits: 0, rr: 0, n: 0 });
const finalizeAcc = (a: Acc) => ({ recallAtK: a.n ? a.hits / a.n : 0, mrr: a.n ? a.rr / a.n : 0, n: a.n });

/**
 * Score recall@k / MRR for every k in `ks` with ONE retrieval per instance.
 *
 * Unlike calling `evaluateMemoryQARetrieval` once per k (which relies on the
 * adapter keeping every index resident so later k's reuse them — a memory bomb
 * for the `local`/`nomic` arms, each of which holds a loaded embedding model),
 * this retrieves a single deep ranked list per instance, EVICTS the index
 * immediately (freeing the model), and derives every k from that one list.
 * Live embedding models are thus bounded to ~1. Mirrors the grader's evidence
 * matching (turn ids via `scopedTurnId`, else session ids) exactly.
 */
async function scoreSweep(
  instances: MemQAInstance[],
  provider: string,
  searcher: MinimemSearch,
  ks: number[],
): Promise<Map<number, MemoryQARetrievalReport>> {
  const maxK = Math.max(...ks);
  const overall = new Map<number, Acc>(ks.map((k) => [k, emptyAcc()]));
  const byCat = new Map<string, Map<number, Acc>>();

  for (const instance of instances) {
    const docs = instanceToDocuments(instance);
    const docToSession = new Map(docs.map((d) => [d.id, d.sessionId]));

    for (const q of instance.questions) {
      const hasTurnEvidence = q.evidenceTurnIds.length > 0;
      const hasSessionEvidence = q.evidenceSessionIds.length > 0;
      if (!hasTurnEvidence && !hasSessionEvidence) continue;

      const ranked = await searcher.search(q.question, docs, { maxResults: maxK });
      const evTurns = new Set(q.evidenceTurnIds.map((id) => scopedTurnId(instance.id, id)));
      const evSessions = new Set(q.evidenceSessionIds);

      // First matching rank in the shared ranked list; recall@k = (rank<=k).
      let matchRank = 0;
      for (let i = 0; i < ranked.length; i++) {
        const id = ranked[i]!.id;
        const matchTurn = hasTurnEvidence && evTurns.has(id);
        const matchSession = !hasTurnEvidence && hasSessionEvidence && evSessions.has(docToSession.get(id) ?? "");
        if (matchTurn || matchSession) {
          matchRank = i + 1;
          break;
        }
      }

      const catAccs = byCat.get(q.category) ?? new Map<number, Acc>(ks.map((k) => [k, emptyAcc()]));
      byCat.set(q.category, catAccs);
      for (const k of ks) {
        const hit = matchRank > 0 && matchRank <= k;
        for (const acc of [overall.get(k)!, catAccs.get(k)!]) {
          acc.n++;
          if (hit) {
            acc.hits++;
            acc.rr += 1 / matchRank;
          }
        }
      }
    }
    // Free the embedding model before moving to the next instance.
    await searcher.evict(instance.id);
  }

  const out = new Map<number, MemoryQARetrievalReport>();
  for (const k of ks) {
    const byCategory: Record<string, ReturnType<typeof finalizeAcc>> = {};
    for (const [cat, accs] of byCat) byCategory[cat] = finalizeAcc(accs.get(k)!);
    out.set(k, { provider, k, overall: finalizeAcc(overall.get(k)!), byCategory });
  }
  return out;
}

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
      const started = Date.now();
      // One retrieval per instance (evicted immediately) → all ks derived from it.
      const perK = await scoreSweep(instances, arm, searcher, ks);
      reports.set(arm, perK);
      for (const kk of ks) {
        const r = perK.get(kk)!;
        log(`  [${arm}] k=${kk}: recall ${pct(r.overall.recallAtK)} MRR ${r.overall.mrr.toFixed(3)}`);
      }
      log(`  [${arm}] done in ${((Date.now() - started) / 1000).toFixed(0)}s`);
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
