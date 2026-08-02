/**
 * minimem-flat on LongMemEval_S (official judge) — gives a true minimem-retrieval number
 * for LongMemEval, consistent with BEAM/LOCOMO. Reuses the benchmark-agnostic
 * CogcoreLiveLongMemEvalAdapter over loadLongMemEval() data; extraction reuses the cached
 * observations (same chunkTurns=40/maxObs=12/combined config, ids NOT namespaced).
 * Judge: judgeMemoryQACorrect (mem0-J, validated to match the official LongMemEval rubric
 * within 0 flips) + isMemoryQARefusal for abstention.
 */
import fs from "node:fs";
import { loadLongMemEval, judgeMemoryQACorrect, isMemoryQARefusal, type MemQAInstance, type MemQuestion } from "swarmkit-eval";
import { CogcoreLiveLongMemEvalAdapter } from "./cogcore-memory.js";
import { LlmClient } from "../locomo/llm.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DATA = arg("data", "evals/longmemeval/cache/longmemeval_s.json")!;
const N = Number(arg("n", "0")); // limit to first N instances (0 = all)
const ANSWER_DEP = arg("answer-deployment", "gpt-5.5")!;
const ANSWER_MODEL = arg("answer-model");
const JUDGE_DEP = arg("judge-deployment", "gpt-4.1")!;
const CONC = Number(arg("concurrency", "5"));
const RETRIEVAL = arg("retrieval", "minimem-graph")!;
const GRAPH_TRAVERSE = arg("graph-traverse", "off")!;
const OUT = arg("out");
// C1 control: point the adapter at a different observation cache (e.g. the verbatim one from
// make-verbatim-cache.tmp.ts) and disable live search tools, so the only thing varying
// between arms is what the notes contain.
const OBS_CACHE = arg("observation-cache-dir");
const LIVE_TOOLS = arg("live-tools", "auto")!; // auto | always | off

const answerModelLlm = ANSWER_MODEL ? new LlmClient({ deployment: ANSWER_MODEL, maxCompletionTokens: 8192, maxRetries: 5 }) : undefined;

function newAdapter(llm: LlmClient): CogcoreLiveLongMemEvalAdapter {
  return new CogcoreLiveLongMemEvalAdapter(llm, "cogcore-live", {
    topK: 16,
    embeddings: "local",
    extractConcurrency: 3,
    chunkTurns: 40,
    maxFactsPerChunk: 60,
    experienceGranularity: "chunk",
    experienceEmbedding: "hash",
    experienceScope: "knowledge-sessions",
    experiencePoolSize: 64,
    observationMemory: "kb",
    observationSource: "combined",
    observationContext: "both",
    observationLogMaxChars: 40_000,
    observationMaxPerChunk: 12,
    observationSlots: 12,
    liveToolPolicy: LIVE_TOOLS as "auto" | "always" | "off",
    liveToolQueries: 2,
    liveToolResults: 6,
    memoryProfile: "long-memory",
    onProgress: () => {},
    ...(OBS_CACHE ? { observationCacheDir: OBS_CACHE } : {}),
    ...(answerModelLlm ? { answerLlm: answerModelLlm } : {}),
    ...(RETRIEVAL === "minimem-graph" ? { retrieval: "minimem-graph" as const, minimemTraverse: GRAPH_TRAVERSE === "on" } : {}),
  });
}

async function mapPool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let idx = 0;
  const worker = async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main(): Promise<void> {
  const llm = new LlmClient({ deployment: ANSWER_DEP, maxCompletionTokens: 8192, maxRetries: 5 });
  const judgeLlm = new LlmClient({ deployment: JUDGE_DEP, maxCompletionTokens: 16, maxRetries: 5 });
  const judgeComplete = async (prompt: string): Promise<string> => (await judgeLlm.chat([{ role: "user", content: prompt }])).text;

  let instances: MemQAInstance[] = loadLongMemEval(DATA);
  if (N > 0 && N < instances.length) {
    // Dataset is grouped by category — round-robin across categories for a balanced subset.
    const byCat = new Map<string, MemQAInstance[]>();
    for (const inst of instances) {
      const c = inst.questions[0]?.category ?? "?";
      const a = byCat.get(c) ?? [];
      a.push(inst);
      byCat.set(c, a);
    }
    const cats = [...byCat.keys()].sort();
    const picked: MemQAInstance[] = [];
    for (let i = 0; picked.length < N; i++) {
      let added = false;
      for (const c of cats) {
        const a = byCat.get(c)!;
        if (i < a.length) { picked.push(a[i]); added = true; if (picked.length >= N) break; }
      }
      if (!added) break;
    }
    instances = picked;
  }
  process.stderr.write(
    `[lme] ${instances.length} instances, retrieval=${RETRIEVAL}${RETRIEVAL === "minimem-graph" ? `+traverse=${GRAPH_TRAVERSE}` : ""}, answer=${ANSWER_MODEL ?? ANSWER_DEP}, judge=official(mem0-J)\n`,
  );

  type Row = { id: string; category: string; correct: number };
  const rows: Row[] = [];
  let done = 0;

  for (const inst of instances) {
    const adapter = newAdapter(llm);
    await adapter.ingest(inst);
    const answered = await mapPool(inst.questions, CONC, async (q: MemQuestion) => {
      const res = await adapter.answer(q);
      const abstain = (q as MemQuestion & { abstain?: boolean }).abstain === true;
      const correct = abstain
        ? isMemoryQARefusal(res.answer)
        : await judgeMemoryQACorrect(judgeComplete, q.question, q.answer ?? "", res.answer);
      return { id: q.id, category: q.category, correct: correct ? 1 : 0 } as Row;
    });
    rows.push(...answered);
    await adapter.close();
    done++;
    if (done % 25 === 0 || done === instances.length) process.stderr.write(`[lme] ${done}/${instances.length} instances done\n`);
  }

  const byCat = new Map<string, number[]>();
  for (const r of rows) {
    const a = byCat.get(r.category) ?? [];
    a.push(r.correct);
    byCat.set(r.category, a);
  }
  const cats = [...byCat.keys()].sort();
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  console.log(`\n=== LongMemEval_S (${RETRIEVAL}${RETRIEVAL === "minimem-graph" ? `+traverse=${GRAPH_TRAVERSE}` : ""}, answer=${ANSWER_MODEL ?? ANSWER_DEP}, official mem0-J judge) ===`);
  for (const c of cats) console.log(`  ${c.padEnd(28)} ${(100 * mean(byCat.get(c)!)).toFixed(1)}%  (n=${byCat.get(c)!.length})`);
  const overall = mean(rows.map((r) => r.correct));
  console.log(`  OVERALL ${(100 * overall).toFixed(1)}%  (${rows.reduce((a, r) => a + r.correct, 0)}/${rows.length})`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ retrieval: RETRIEVAL, overall, n: rows.length, byCategory: Object.fromEntries(cats.map((c) => [c, mean(byCat.get(c)!)])) }, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
