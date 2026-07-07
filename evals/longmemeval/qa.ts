/**
 * LongMemEval full QA harness — ingest → retrieve → GPT-5.5 answer → mem0-judge,
 * with abstention scoring, on swarmkit-eval's memory-QA harness.
 *
 *   npx tsx evals/longmemeval/qa.ts --arms local --per-category 10 --k 10 --out lme-qa.md
 *   npx tsx evals/longmemeval/qa.ts --arms none,local --per-category 8 --concurrency 4
 *
 * Per question: build a minimem index over the haystack turns, retrieve top-k,
 * evict the index (frees the embedding model before the LLM phase), have GPT-5.5
 * answer from the retrieved excerpts, then judge.
 *   - answerable questions → mem0 J-judge (generous, LoCoMo-leaderboard prompt)
 *   - abstention questions (`*_abs`) → scored on refusal, not gold-match
 *
 * Retrieval index builds are serialized inside the adapter (embedding safety);
 * the LLM answer+judge calls run concurrently up to --concurrency.
 */

import fs from "node:fs/promises";

import {
  instanceToDocuments,
  sampleMemoryQAStratified,
  buildMemoryQAReport,
  formatMemoryQA,
  judgeMemoryQACorrect,
  isMemoryQARefusal,
  pairedMemoryQAAccuracy,
  type MemQADocument,
  type MemoryQARecord,
  type MemoryQAReport,
  type SampledMemQuestion,
} from "swarmkit-eval";

import { loadLongMemEvalCached } from "./dataset.js";
import { createMinimemSearch, type Embeddings } from "./minimem-search.js";
import { LlmClient } from "../locomo/llm.js";

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
  if (!spec || spec === true) return ["local"];
  const arms = String(spec).split(",").map((s) => s.trim()).filter(Boolean) as Embeddings[];
  for (const a of arms) {
    if (!KNOWN_ARMS.includes(a)) throw new Error(`Unknown arm '${a}'. Use ${KNOWN_ARMS.join("|")}.`);
  }
  return arms;
}

/** LongMemEval answer prompt: excerpts carry `[speaker @ date]`; the question has
 *  its own ask-date (temporal reasoning). Instruct "Not mentioned" so absent-info
 *  and abstention questions produce a refusal the scorer can detect. */
function buildLmeAnswerPrompt(question: string, questionDate: string | undefined, excerpts: MemQADocument[]): string {
  const body = excerpts.map((e) => `- ${e.text}`).join("\n");
  return [
    "You are answering a question using ONLY the memory excerpts below, drawn from the user's past chat sessions.",
    "Each excerpt is prefixed with its speaker (user/assistant) and the session date.",
    "Answer concisely and directly. Use the dates to reason about timing and ordering when relevant.",
    'If the excerpts do not contain enough information to answer, reply exactly: "Not mentioned".',
    "",
    questionDate ? `The question is asked on: ${questionDate}` : "",
    "Memory excerpts:",
    body,
    "",
    `Question: ${question}`,
    "Answer:",
  ]
    .filter((l) => l !== "")
    .join("\n");
}

/** Run a bounded-concurrency map over items. */
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) break;
      results[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return results;
}

async function runArm(
  arm: Embeddings,
  sampled: SampledMemQuestion[],
  llm: LlmClient,
  k: number,
  concurrency: number,
  log: (m: string) => void,
): Promise<MemoryQAReport> {
  const searcher = createMinimemSearch(arm);
  let done = 0;
  try {
    const records = await mapPool(sampled, concurrency, async ({ instance, question }) => {
      const docs = instanceToDocuments(instance);
      // Serialized build + retrieve, then free the embedding model immediately.
      const ranked = await searcher.search(question.question, docs, { maxResults: k });
      await searcher.evict(instance.id);

      const byId = new Map(docs.map((d) => [d.id, d]));
      const excerpts = ranked.slice(0, k).map((r) => byId.get(r.id)!).filter(Boolean);

      let answer = "";
      let judgedBy: MemoryQARecord["judgedBy"] = "error";
      let correct = false;
      try {
        const { text } = await llm.chat([
          { role: "user", content: buildLmeAnswerPrompt(question.question, question.date, excerpts) },
        ]);
        answer = text.trim();
        if (question.abstain) {
          correct = isMemoryQARefusal(answer);
          judgedBy = "abstain-sentinel";
        } else {
          correct = await judgeMemoryQACorrect(
            (p) => llm.complete(p),
            question.question,
            question.answer,
            answer,
          );
          judgedBy = "mem0-judge";
        }
      } catch (err) {
        log(`  [${arm}] error on ${question.id}: ${err instanceof Error ? err.message : String(err)}`);
      }

      done++;
      if (done % 10 === 0) log(`  [${arm}] ${done}/${sampled.length}`);
      const rec: MemoryQARecord = {
        id: question.id,
        category: question.category,
        question: question.question,
        answer,
        gold: question.answer,
        correct,
        judgedBy,
      };
      return rec;
    });
    return buildMemoryQAReport(arm, k, records);
  } finally {
    await searcher.close();
  }
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const arms = parseArms(args.arms);
  const k = args.k ? Number(args.k) : 10;
  const perCategory = args["per-category"] ? Number(args["per-category"]) : 10;
  const includeAbstain = args["no-abstain"] ? false : true;
  const concurrency = args.concurrency ? Number(args.concurrency) : 4;

  const log = (m: string) => process.stderr.write(`[lme-qa] ${m}\n`);

  const all = loadLongMemEvalCached();
  const sampled = sampleMemoryQAStratified(all, perCategory, { includeAbstain });
  const abstainN = sampled.filter((s) => s.question.abstain).length;
  log(
    `loaded ${all.length} instances → ${sampled.length} questions ` +
      `(perCategory=${perCategory}, abstain=${abstainN}, arms=${arms.join(",")}, k=${k}, conc=${concurrency})`,
  );

  const llm = new LlmClient({ maxCompletionTokens: 2048 });

  const reports = new Map<Embeddings, MemoryQAReport>();
  const sections: string[] = [`# LongMemEval QA (n=${sampled.length}, k=${k})\n`];

  for (const arm of arms) {
    const started = Date.now();
    const before = { ...llm.totals };
    const report = await runArm(arm, sampled, llm, k, concurrency, log);
    reports.set(arm, report);
    const tokens = llm.totals.totalTokens - before.totalTokens;
    const calls = llm.totals.calls - before.calls;
    log(
      `  [${arm}] overall ${pct(report.overall.accuracy)} ` +
        `(${((Date.now() - started) / 1000).toFixed(0)}s, ${calls} llm calls, ${tokens} tokens)`,
    );

    sections.push(`## arm: ${arm}\n`);
    sections.push("```\n" + formatMemoryQA(report) + "\n```\n");
    // Abstention questions are folded into their question_type category; report
    // their refusal accuracy explicitly.
    const absRecords = report.records.filter((r) => sampled.find((s) => s.question.id === r.id)?.question.abstain);
    if (absRecords.length > 0) {
      const refused = absRecords.filter((r) => isMemoryQARefusal(r.answer)).length;
      sections.push(
        `abstention: ${refused}/${absRecords.length} refused (${pct(refused / absRecords.length)})\n`,
      );
    }
    sections.push(`cost: ${calls} LLM calls, ${tokens} tokens\n`);
  }

  if (arms.length >= 2) {
    const base = arms[0]!;
    sections.push(`## A/B vs ${base} (paired McNemar)\n`);
    for (const arm of arms.slice(1)) {
      const p = pairedMemoryQAAccuracy(reports.get(base)!, reports.get(arm)!);
      sections.push(
        "```\n" +
          `${arm} vs ${base}: ${pct(reports.get(arm)!.overall.accuracy)} vs ${pct(reports.get(base)!.overall.accuracy)}  ` +
          `Δ ${p.delta >= 0 ? "+" : ""}${pct(p.delta)}\n` +
          `fixed(b)=${p.b} broke(c)=${p.c} χ²=${p.chi2.toFixed(2)} p=${p.p.toFixed(3)} ` +
          `${p.significant ? "(significant)" : "(n.s.)"} n=${p.n}\n` +
          "```\n",
      );
    }
  }

  // Summary table.
  const summary = ["## summary\n", "```", `${"arm".padEnd(10)} ${"accuracy".padStart(9)}`];
  for (const arm of arms) summary.push(`${arm.padEnd(10)} ${pct(reports.get(arm)!.overall.accuracy).padStart(9)}`);
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
  process.stderr.write(`[lme-qa] error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
