/**
 * LOCOMO validation of the PRODUCT graph path (step 3): flat KB vs minimem-graph, mem0 J-judge.
 * Reuses the benchmark-agnostic CogcoreLiveLongMemEvalAdapter (extraction supplies entity-tagged
 * observations, so the graph engages) on loadLocomo() data. A different benchmark, scale, and
 * judge than BEAM — a non-harm + generalization check for the graph.
 */
import fs from "node:fs";
import { loadLocomo, type MemQAInstance, type MemQuestion } from "swarmkit-eval";
import { CogcoreLiveLongMemEvalAdapter } from "../longmemeval/cogcore-memory.js";
import { LlmClient } from "./llm.js";
import { judgeAnswer, isRefusal } from "./judge.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DATA = arg("data", "evals/locomo/cache/locomo10.json")!;
const CONVS = Number(arg("conversations", "0"));
const MAX_Q = Number(arg("max-q", "0")); // per-conversation cap, stratified by category (0 = all)
const ANSWER_DEP = arg("answer-deployment", "gpt-5.5")!;
const JUDGE_DEP = arg("judge-deployment", "gpt-4.1")!;
const CONC = Number(arg("concurrency", "4"));
const SAMPLES = Number(arg("samples", "1"));
const RETRIEVAL = arg("retrieval", "kb")!;
const GRAPH_TRAVERSE = arg("graph-traverse", "off")!;
const OUT = arg("out");
const DETAILS_OUT = arg("details-out");

const CAT_LABEL: Record<string, string> = {
  "1": "multi-hop",
  "2": "temporal",
  "3": "open-domain",
  "4": "single-hop",
  "5": "adversarial",
};

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
    liveToolPolicy: "auto",
    liveToolQueries: 2,
    liveToolResults: 6,
    memoryProfile: "long-memory",
    onProgress: () => {},
    // No BEAM prompt — default LongMemEval answer prompt, appropriate for LOCOMO QA.
    ...(RETRIEVAL === "minimem-graph"
      ? { retrieval: "minimem-graph" as const, minimemTraverse: GRAPH_TRAVERSE === "on" }
      : {}),
  });
}

/** Round-robin across categories so a per-conversation cap keeps every category represented. */
function stratify(questions: MemQuestion[], cap: number): MemQuestion[] {
  if (cap <= 0 || questions.length <= cap) return questions;
  const byCat = new Map<string, MemQuestion[]>();
  for (const q of questions) {
    const a = byCat.get(q.category) ?? [];
    a.push(q);
    byCat.set(q.category, a);
  }
  const cats = [...byCat.keys()].sort();
  const out: MemQuestion[] = [];
  let i = 0;
  while (out.length < cap) {
    let added = false;
    for (const c of cats) {
      const a = byCat.get(c)!;
      if (i < a.length) {
        out.push(a[i]);
        added = true;
        if (out.length >= cap) break;
      }
    }
    if (!added) break;
    i++;
  }
  return out;
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
  const judge = new LlmClient({ deployment: JUDGE_DEP, maxCompletionTokens: 16, maxRetries: 5 });
  let instances: MemQAInstance[] = loadLocomo(DATA);
  // Namespace ids so the observation cache never collides with BEAM/LongMemEval.
  instances = instances.map((i) => ({ ...i, id: `locomo--${i.id}` }));
  if (CONVS > 0) instances = instances.slice(0, CONVS);
  process.stderr.write(
    `[locomo] ${instances.length} conversations, retrieval=${RETRIEVAL}${RETRIEVAL === "minimem-graph" ? `+traverse=${GRAPH_TRAVERSE}` : ""}, answer=${ANSWER_DEP}, samples=${SAMPLES}\n`,
  );

  type Row = { conversationId: string; dimension: string; questionId: string; score: number };
  const rows: Row[] = [];
  const details: Array<Record<string, unknown>> = [];
  let done = 0;

  for (const inst of instances) {
    const questions = stratify(inst.questions, MAX_Q);
    const adapter = newAdapter(llm);
    await adapter.ingest(inst);
    const answered = await mapPool(questions, CONC, async (q) => {
      const adversarial = q.category === "5";
      const scores: number[] = [];
      let lastAnswer = "";
      for (let s = 0; s < SAMPLES; s++) {
        const res = await adapter.answer(q);
        lastAnswer = res.answer;
        const correct = adversarial
          ? isRefusal(res.answer)
          : (await judgeAnswer(judge, q.question, q.answer ?? "", res.answer)).correct;
        scores.push(correct ? 1 : 0);
      }
      const score = scores.reduce((a, b) => a + b, 0) / scores.length;
      const row: Row = { conversationId: inst.id, dimension: q.category, questionId: q.id, score };
      if (DETAILS_OUT) {
        details.push({ ...row, question: q.question, reference: q.answer, answer: lastAnswer, samples: SAMPLES });
      }
      return row;
    });
    rows.push(...answered);
    await adapter.close();
    done++;
    process.stderr.write(`[locomo] conversation ${done}/${instances.length} (${inst.id}) done\n`);
  }

  const byCat = new Map<string, number[]>();
  for (const r of rows) {
    const a = byCat.get(r.dimension) ?? [];
    a.push(r.score);
    byCat.set(r.dimension, a);
  }
  const cats = [...byCat.keys()].sort();
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  console.log(
    `\n=== LOCOMO (${RETRIEVAL}${RETRIEVAL === "minimem-graph" ? `+traverse=${GRAPH_TRAVERSE}` : ""}, judge=mem0-J, ${instances.length} convs, samples=${SAMPLES}) ===`,
  );
  for (const c of cats) {
    console.log(`  cat ${c} ${(CAT_LABEL[c] ?? "").padEnd(12)} ${(100 * mean(byCat.get(c)!)).toFixed(1)}%  (n=${byCat.get(c)!.length})`);
  }
  const overall = mean(rows.map((r) => r.score));
  console.log(`  OVERALL (all questions)       ${(100 * overall).toFixed(1)}%  (n=${rows.length})`);
  if (OUT) {
    fs.writeFileSync(
      OUT,
      JSON.stringify({ retrieval: RETRIEVAL, overall, perCat: Object.fromEntries(cats.map((c) => [c, mean(byCat.get(c)!)])) }, null, 2),
    );
  }
  if (DETAILS_OUT) fs.writeFileSync(DETAILS_OUT, details.map((d) => JSON.stringify(d)).join("\n") + "\n");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
