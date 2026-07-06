/**
 * LOCOMO trace tool — debug WHY arms disagree.
 *
 * Runs a small, stratified sample of questions through one or more arms and
 * dumps, per question: the gold answer, and for each arm its verdict, predicted
 * answer, and the EXACT context it retrieved (ref + text). This is the thing the
 * summary metrics can't show you: what each memory layer actually surfaced.
 *
 * Writes both a machine-readable JSON and a human-readable Markdown report,
 * with disagreement cases (some arm right, some wrong) pulled to the top.
 *
 *   npx tsx evals/locomo/trace.ts \
 *     --conversations 1 --questions 24 \
 *     --systems cogcore-retrieval,cogcore-memory \
 *     --out evals/locomo/results/trace
 *
 * Flags mirror run.ts (--conversations, --questions, --topk, --seed,
 * --concurrency, --embeddings). --questions 0 = all non-adversarial.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { loadLocomo, turnCount } from "./dataset.js";
import { judgeAnswer } from "./judge.js";
import { LlmClient } from "./llm.js";
import type {
  LocomoQuestion,
  MemorySystemAdapter,
  RetrievedNote,
} from "./types.js";

interface TraceArgs {
  conversations: number;
  questions: number;
  systems: string[];
  topk: number;
  seed: number;
  concurrency: number;
  embeddings: "local" | "none" | "nomic";
  keywordExpansion: boolean;
  mmr?: { lambda: number; poolSize: number };
  out: string;
}

interface TraceRow {
  system: string;
  predicted: string;
  correct: boolean;
  retrieved: RetrievedNote[];
  judgeRaw: string;
}

interface TraceQuestion {
  questionId: string;
  sampleId: string;
  category: string;
  question: string;
  gold: string;
  evidence: string[];
  bySystem: Record<string, TraceRow>;
}

function parseArgs(argv: string[]): TraceArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    conversations: Number(get("--conversations") ?? 1),
    questions: Number(get("--questions") ?? 24),
    systems: (get("--systems") ?? "cogcore-retrieval,cogcore-memory")
      .split(",")
      .map((s) => s.trim()),
    topk: Number(get("--topk") ?? 10),
    seed: Number(get("--seed") ?? 1),
    concurrency: Number(get("--concurrency") ?? 6),
    embeddings: parseEmbeddings(get("--embeddings")),
    keywordExpansion: argv.includes("--keyword-expansion"),
    mmr: argv.includes("--mmr")
      ? { lambda: Number(get("--mmr-lambda") ?? 0.7), poolSize: Number(get("--mmr-pool") ?? 50) }
      : undefined,
    out: get("--out") ?? "evals/locomo/results/trace",
  };
}

function parseEmbeddings(v: string | undefined): "local" | "none" | "nomic" {
  return v === "none" ? "none" : v === "nomic" ? "nomic" : "local";
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

/** Stratified sample across categories (adversarial excluded — it tests refusal,
 *  not retrieval). */
function sampleQuestions(
  questions: LocomoQuestion[],
  limit: number,
  seed: number,
): LocomoQuestion[] {
  const pool = questions.filter((q) => !q.isAdversarial);
  if (limit <= 0 || pool.length <= limit) return pool;
  const rand = mulberry32(seed);
  const byCat = new Map<string, LocomoQuestion[]>();
  for (const q of pool) {
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
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function makeAdapter(
  name: string,
  llm: LlmClient,
  args: TraceArgs,
): Promise<MemorySystemAdapter> {
  switch (name) {
    case "minimem-alone": {
      const { MinimemAloneAdapter } = await import("./adapters/minimem-alone.js");
      return new MinimemAloneAdapter(llm, { topK: args.topk });
    }
    case "cogcore-retrieval": {
      const { CogcoreRetrievalAdapter } = await import("./adapters/cogcore-retrieval.js");
      return new CogcoreRetrievalAdapter(llm, {
        topK: args.topk,
        embeddings: args.embeddings,
        keywordExpansion: args.keywordExpansion,
        mmr: args.mmr,
      });
    }
    case "cogcore-memory": {
      const { CogcoreMemoryAdapter } = await import("./adapters/cogcore-memory.js");
      return new CogcoreMemoryAdapter(llm, {
        topK: args.topk,
        embeddings: args.embeddings,
        keywordExpansion: args.keywordExpansion,
        mmr: args.mmr,
      });
    }
    case "cogcore-hybrid": {
      const { CogcoreMemoryAdapter } = await import("./adapters/cogcore-memory.js");
      const a = new CogcoreMemoryAdapter(llm, {
        topK: args.topk,
        embeddings: args.embeddings,
        keywordExpansion: args.keywordExpansion,
        mmr: args.mmr,
        hybridRawTurns: true,
      });
      (a as unknown as { name: string }).name = "cogcore-hybrid";
      return a;
    }
    case "cogcore-hybrid-mq": {
      const { CogcoreMemoryAdapter } = await import("./adapters/cogcore-memory.js");
      const a = new CogcoreMemoryAdapter(llm, {
        topK: args.topk,
        embeddings: args.embeddings,
        keywordExpansion: args.keywordExpansion,
        mmr: args.mmr,
        hybridRawTurns: true,
        multiQuery: true,
      });
      (a as unknown as { name: string }).name = "cogcore-hybrid-mq";
      return a;
    }
    case "mem0": {
      const { Mem0Adapter } = await import("./adapters/mem0.js");
      return new Mem0Adapter(llm, { topK: args.topk });
    }
    default:
      throw new Error(`Unknown system "${name}"`);
  }
}

function truncate(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n)}…` : flat;
}

function renderMarkdown(args: TraceArgs, questions: TraceQuestion[]): string {
  const systems = args.systems;
  const lines: string[] = [];
  lines.push(`# LOCOMO trace`);
  lines.push("");
  lines.push(
    `systems: ${systems.join(", ")} · topk=${args.topk} · embeddings=${args.embeddings} · ` +
      `${questions.length} questions from ${args.conversations} conversation(s)`,
  );
  lines.push("");

  // Per-system accuracy on this sample.
  lines.push(`## Sample accuracy`);
  lines.push("");
  lines.push(`| system | correct | acc |`);
  lines.push(`|---|---|---|`);
  for (const s of systems) {
    const rows = questions.map((q) => q.bySystem[s]).filter(Boolean);
    const c = rows.filter((r) => r.correct).length;
    lines.push(`| ${s} | ${c}/${rows.length} | ${((c / rows.length) * 100).toFixed(1)}% |`);
  }
  lines.push("");

  // Order: disagreements first (systems differ), then all-wrong, then all-right.
  const rank = (q: TraceQuestion): number => {
    const verdicts = systems.map((s) => q.bySystem[s]?.correct);
    const anyRight = verdicts.some((v) => v === true);
    const anyWrong = verdicts.some((v) => v === false);
    if (anyRight && anyWrong) return 0; // disagreement — most informative
    if (!anyRight) return 1; // all wrong
    return 2; // all right
  };
  const ordered = [...questions].sort((a, b) => rank(a) - rank(b));

  lines.push(`## Cases (disagreements first)`);
  lines.push("");
  for (const q of ordered) {
    const verdicts = systems
      .map((s) => `${s}=${q.bySystem[s]?.correct ? "✓" : "✗"}`)
      .join("  ");
    lines.push(`### [${q.category}] ${q.question}`);
    lines.push("");
    lines.push(`- **gold:** ${q.gold}`);
    if (q.evidence.length) lines.push(`- **evidence turns:** ${q.evidence.join(", ")}`);
    lines.push(`- **verdicts:** ${verdicts}`);
    lines.push("");
    for (const s of systems) {
      const r = q.bySystem[s];
      if (!r) continue;
      lines.push(`#### ${s} — ${r.correct ? "✓ correct" : "✗ wrong"}`);
      lines.push(`> predicted: ${truncate(r.predicted, 300)}`);
      lines.push("");
      if (r.retrieved.length === 0) {
        lines.push(`- _(no context retrieved)_`);
      } else {
        for (const e of r.retrieved) {
          lines.push(`- \`${e.ref}\` — ${truncate(e.text, 200)}`);
        }
      }
      lines.push("");
    }
    lines.push("---");
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const llm = new LlmClient();
  process.stderr.write(`[trace] deployment=${llm.deployment} systems=${args.systems.join(",")}\n`);
  const keepAlive = setInterval(() => {}, 1 << 30);

  const all = await loadLocomo();
  const conversations = all.slice(0, args.conversations);

  // question map keyed by questionId, filled per system.
  const qmap = new Map<string, TraceQuestion>();

  for (const sysName of args.systems) {
    const adapter = await makeAdapter(sysName, llm, args);
    for (const conv of conversations) {
      process.stderr.write(
        `[${sysName}] ingest ${conv.sampleId} (${conv.sessions.length} sessions, ${turnCount(conv)} turns)...\n`,
      );
      await adapter.reset();
      await adapter.ingest(conv);

      const questions = sampleQuestions(conv.questions, args.questions, args.seed);
      process.stderr.write(`[${sysName}] tracing ${questions.length} questions...\n`);

      await mapPool(questions, args.concurrency, async (q) => {
        const ans = await adapter.answer(q, conv);
        const judged = await judgeAnswer(llm, q.question, q.answer, ans.text);
        const key = q.id;
        let tq = qmap.get(key);
        if (!tq) {
          tq = {
            questionId: q.id,
            sampleId: conv.sampleId,
            category: q.category,
            question: q.question,
            gold: q.answer,
            evidence: q.evidence,
            bySystem: {},
          };
          qmap.set(key, tq);
        }
        tq.bySystem[sysName] = {
          system: sysName,
          predicted: ans.text,
          correct: judged.correct,
          retrieved: ans.retrieved ?? [],
          judgeRaw: judged.raw,
        };
      });
    }
    await adapter.close?.();
  }

  const questions = [...qmap.values()];
  const outBase = path.resolve(args.out);
  await fs.mkdir(path.dirname(outBase), { recursive: true });
  await fs.writeFile(`${outBase}.json`, JSON.stringify({ config: args, questions }, null, 2), "utf-8");
  await fs.writeFile(`${outBase}.md`, renderMarkdown(args, questions), "utf-8");
  process.stdout.write(`\nWrote ${outBase}.json and ${outBase}.md (${questions.length} questions)\n`);

  clearInterval(keepAlive);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(1);
});
