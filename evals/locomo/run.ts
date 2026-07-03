/**
 * LOCOMO harness runner (dry-run capable).
 *
 * Runs one or more system arms over one or more conversations, answering
 * questions and judging them with the mem0 J-judge, then reports per-category
 * accuracy and the cost axis (tokens + latency) plus a full-run extrapolation.
 *
 * Dry run (1 conversation, 30 stratified questions, minimem-alone arm):
 *   npx tsx evals/locomo/run.ts --conversations 1 --questions 30
 *
 * Flags:
 *   --conversations N   conversations to run (default 1)
 *   --questions N       max questions per conversation, stratified (0 = all; default 30)
 *   --systems a,b       arms: minimem-alone (default)
 *   --topk N            excerpts retrieved per question (default 8)
 *   --seed N            sampling seed (default 1)
 *   --out path.json     write raw results JSON
 */

import fs from "node:fs/promises";
import path from "node:path";

import { loadLocomo, turnCount } from "./dataset.js";
import { isRefusal, judgeAnswer } from "./judge.js";
import { LlmClient } from "./llm.js";
import { scoreSystem, summarizeCost } from "./metrics.js";
import { MinimemAloneAdapter } from "./adapters/minimem-alone.js";
import { CogcoreRetrievalAdapter } from "./adapters/cogcore-retrieval.js";
import { CogcoreMemoryAdapter } from "./adapters/cogcore-memory.js";
import { Mem0Adapter } from "./adapters/mem0.js";
import type {
  LocomoConversation,
  LocomoQuestion,
  MemorySystemAdapter,
  QAResult,
  UsageStats,
} from "./types.js";

interface Args {
  conversations: number;
  questions: number;
  systems: string[];
  topk: number;
  seed: number;
  concurrency: number;
  embeddings: "local" | "none";
  out?: string;
}

/**
 * Run `fn` over `items` with at most `limit` in flight. Results are returned in
 * input order; failures reject the whole batch.
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    conversations: Number(get("--conversations") ?? 1),
    questions: Number(get("--questions") ?? 30),
    systems: (get("--systems") ?? "minimem-alone").split(",").map((s) => s.trim()),
    topk: Number(get("--topk") ?? 8),
    seed: Number(get("--seed") ?? 1),
    concurrency: Number(get("--concurrency") ?? 6),
    embeddings: (get("--embeddings") ?? "local") === "none" ? "none" : "local",
    out: get("--out"),
  };
}

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

/** Stratified sample: round-robin across categories after a seeded shuffle. */
function sampleQuestions(
  questions: LocomoQuestion[],
  limit: number,
  seed: number,
): LocomoQuestion[] {
  if (limit <= 0 || questions.length <= limit) return questions;
  const rand = mulberry32(seed);
  const byCat = new Map<string, LocomoQuestion[]>();
  for (const q of questions) {
    const arr = byCat.get(q.category) ?? [];
    arr.push(q);
    byCat.set(q.category, arr);
  }
  for (const arr of byCat.values()) arr.sort(() => rand() - 0.5);
  const cats = [...byCat.keys()].sort();
  const out: LocomoQuestion[] = [];
  let idx = 0;
  while (out.length < limit) {
    const cat = cats[idx % cats.length];
    const arr = byCat.get(cat)!;
    if (arr.length) out.push(arr.shift()!);
    idx++;
    if (cats.every((c) => byCat.get(c)!.length === 0)) break;
  }
  return out;
}

function makeAdapter(name: string, llm: LlmClient, args: Args): MemorySystemAdapter {
  switch (name) {
    case "minimem-alone":
      return new MinimemAloneAdapter(llm, { topK: args.topk });
    case "cogcore-retrieval":
      return new CogcoreRetrievalAdapter(llm, { topK: args.topk, embeddings: args.embeddings });
    case "cogcore-memory":
      return new CogcoreMemoryAdapter(llm, { topK: args.topk, embeddings: args.embeddings });
    case "mem0":
      return new Mem0Adapter(llm, { topK: args.topk });
    default:
      throw new Error(
        `Unknown system "${name}" (available: minimem-alone, cogcore-retrieval, cogcore-memory, mem0)`,
      );
  }
}

async function runSystem(
  adapter: MemorySystemAdapter,
  conversations: LocomoConversation[],
  args: Args,
  llm: LlmClient,
): Promise<{ qa: QAResult[]; ingestUsage: UsageStats[]; judgeUsage: UsageStats[] }> {
  const qa: QAResult[] = [];
  const ingestUsage: UsageStats[] = [];
  const judgeUsage: UsageStats[] = [];

  for (const conv of conversations) {
    process.stderr.write(
      `[${adapter.name}] ingest ${conv.sampleId} (${conv.sessions.length} sessions, ${turnCount(conv)} turns)...\n`,
    );
    await adapter.reset();
    const ing = await adapter.ingest(conv);
    ingestUsage.push(ing);

    const questions = sampleQuestions(conv.questions, args.questions, args.seed);
    process.stderr.write(
      `[${adapter.name}] answering ${questions.length} questions (concurrency ${args.concurrency})...\n`,
    );

    let done = 0;
    const rows = await mapPool(questions, args.concurrency, async (q) => {
      const t0 = Date.now();
      try {
        const ans = await adapter.answer(q, conv);
        const judged = await judgeAnswer(llm, q.question, q.answer, ans.text);
        const judgeStat: UsageStats = { latencyMs: Date.now() - t0, totalTokens: judged.judgeTokens };

        // Adversarial: correct behavior is refusal; the J-judge scores against the
        // planted distractor, so we override with refusal detection for cat 5.
        const correct = q.isAdversarial ? isRefusal(ans.text) : judged.correct;

        const row: QAResult = {
          system: adapter.name,
          sampleId: conv.sampleId,
          questionId: q.id,
          categoryId: q.categoryId,
          category: q.category,
          question: q.question,
          goldAnswer: q.answer,
          predicted: ans.text,
          correct,
          judgeRaw: judged.raw,
          usage: { latencyMs: ans.latencyMs, totalTokens: ans.totalTokens, promptTokens: ans.promptTokens, completionTokens: ans.completionTokens },
        };
        if (++done % 10 === 0) process.stderr.write(`  ...${done}/${questions.length}\n`);
        return { row, judgeStat };
      } catch (err) {
        // One bad question (transient API error, etc.) must never kill a
        // multi-hour arm: record it as incorrect and keep going.
        process.stderr.write(
          `  [warn] ${adapter.name} question ${q.id} failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        const row: QAResult = {
          system: adapter.name,
          sampleId: conv.sampleId,
          questionId: q.id,
          categoryId: q.categoryId,
          category: q.category,
          question: q.question,
          goldAnswer: q.answer,
          predicted: "[ERROR]",
          correct: false,
          judgeRaw: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
          usage: { latencyMs: Date.now() - t0, totalTokens: 0 },
        };
        return { row, judgeStat: { latencyMs: Date.now() - t0, totalTokens: 0 } };
      }
    });

    for (const { row, judgeStat } of rows) {
      qa.push(row);
      judgeUsage.push(judgeStat);
    }
  }

  await adapter.close?.();
  return { qa, ingestUsage, judgeUsage };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const llm = new LlmClient();
  process.stderr.write(`[locomo] deployment=${llm.deployment}\n`);

  const all = await loadLocomo();
  const conversations = all.slice(0, args.conversations);

  const report: Record<string, unknown> = { config: args, systems: {} };

  for (const sysName of args.systems) {
    const adapter = makeAdapter(sysName, llm, args);
    const { qa, ingestUsage, judgeUsage } = await runSystem(adapter, conversations, args, llm);
    const score = scoreSystem(sysName, qa, ingestUsage);
    const judgeCost = summarizeCost(judgeUsage);

    (report.systems as Record<string, unknown>)[sysName] = { score, judgeCost, qa };

    // ---- console report ----
    process.stdout.write(`\n=== ${sysName} ===\n`);
    process.stdout.write(
      `Overall (excl. adversarial): ${(score.overallAccuracy * 100).toFixed(1)}% ` +
        `(${score.overallCorrect}/${score.overallN})  95% CI [${(score.ci95[0] * 100).toFixed(1)}, ${(score.ci95[1] * 100).toFixed(1)}]\n`,
    );
    for (const c of score.byCategory.sort((a, b) => a.category.localeCompare(b.category))) {
      process.stdout.write(
        `  ${c.category.padEnd(12)} ${(c.accuracy * 100).toFixed(1).padStart(5)}%  (${c.correct}/${c.n})\n`,
      );
    }
    process.stdout.write(
      `Answer cost: ${score.answerCost.meanTokens.toFixed(0)} tok/q, ` +
        `latency p50 ${score.answerCost.latencyP50Ms.toFixed(0)}ms / p95 ${score.answerCost.latencyP95Ms.toFixed(0)}ms\n`,
    );
    process.stdout.write(
      `Judge cost:  ${judgeCost.meanTokens.toFixed(0)} tok/q, latency p50 ${judgeCost.latencyP50Ms.toFixed(0)}ms\n`,
    );

    // ---- full-run extrapolation (answer + judge + amortized ingest) ----
    const totalPerConv = 1986 / 10;
    const meanAnsTok = score.answerCost.meanTokens;
    const meanJudgeTok = judgeCost.meanTokens;
    const meanIngestTokPerConv = score.ingestCost.meanTokens; // 0 for non-extraction arms
    const perQ = meanAnsTok + meanJudgeTok;
    const fullTokensOneArm = perQ * totalPerConv * 10 + meanIngestTokPerConv * 10;
    process.stdout.write(
      `\n[extrapolation] ${perQ.toFixed(0)} tok/q (answer+judge)` +
        (meanIngestTokPerConv > 0
          ? ` + ${(meanIngestTokPerConv / 1000).toFixed(0)}k ingest tok/conv`
          : "") +
        `. Full LOCOMO (1986 QA) ≈ ${(fullTokensOneArm / 1e6).toFixed(2)}M tok for this arm.\n`,
    );
    process.stdout.write(
      `[llm totals] calls=${llm.totals.calls} prompt=${llm.totals.promptTokens} completion=${llm.totals.completionTokens} total=${llm.totals.totalTokens}\n`,
    );
  }

  if (args.out) {
    const outPath = path.resolve(args.out);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
    process.stdout.write(`\nWrote ${outPath}\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
