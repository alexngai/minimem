/**
 * BEAM (ICLR 2026) QA harness — runs a memory arm over BEAM conversations and
 * scores answers with BEAM's rubric judge (reusable `loadBeam` + `beamJudgeQuestion`
 * from swarmkit-eval). Ingest each conversation, answer its 10-dimension probing
 * questions, judge each answer against its rubric (per-item, int-floored except
 * event_ordering), and report per-dimension + overall accuracy.
 *
 *   source ~/.zshrc
 *   npx tsx evals/beam/run.ts --data evals/beam/cache/beam-100K.json \
 *     --conversations 1 --answer-deployment gpt-5.5 --judge-deployment gpt-4.1 \
 *     --out evals/beam/results/beam-100K-cogcore-live.json
 *
 * Judge note: BEAM's reference judge is gpt-4.1-mini; we substitute gpt-4.1
 * (gpt-4.1-mini is not deployed on this Azure) — a slightly stronger judge.
 */
import fs from "node:fs";
import path from "node:path";
import { loadBeam, beamJudgeQuestion, BEAM_DIMENSIONS, type MemQAInstance } from "swarmkit-eval";
import { LlmClient } from "../locomo/llm.js";
import { CogcoreLiveLongMemEvalAdapter } from "../longmemeval/cogcore-memory.js";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DATA = arg("data", "evals/beam/cache/beam-100K.json")!;
const CONVS = Number(arg("conversations", "0")); // 0 = all
const ANSWER_DEP = arg("answer-deployment", "gpt-5.5")!;
const JUDGE_DEP = arg("judge-deployment", "gpt-4.1")!;
const CONC = Number(arg("concurrency", "4"));
const OUT = arg("out");

const BASE = (process.env.AZURE_API_BASE || "").replace(/\/$/, "");
const KEY = process.env.AZURE_API_KEY!;
const VER = process.env.AZURE_API_VERSION!;
const judgeUrl = `${BASE}/openai/deployments/${JUDGE_DEP}/chat/completions?api-version=${VER}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** BEAM judge call: gpt-4.1 (substitute), temperature 0, tolerant of 400/5xx. */
async function judge(prompt: string): Promise<string> {
  for (let att = 0; att <= 6; att++) {
    try {
      const res = await fetch(judgeUrl, {
        method: "POST",
        headers: { "api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 400 }),
      });
      if (res.status === 429 || res.status >= 500) { await sleep(Math.min(30000, 1000 * 2 ** att)); continue; }
      if (res.status === 400) return '{"score": 0}';
      if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
      const j = (await res.json()) as { choices: { message: { content: string } }[] };
      return j.choices[0]?.message?.content ?? "";
    } catch (e) { if (att === 6) throw e; await sleep(Math.min(30000, 1000 * 2 ** att)); }
  }
  return '{"score": 0}';
}

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
  });
}

async function mapPool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0;
  const worker = async () => { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function main(): Promise<void> {
  const llm = new LlmClient({ deployment: ANSWER_DEP, maxCompletionTokens: 8192, maxRetries: 5 });
  let instances: MemQAInstance[] = loadBeam(DATA);
  if (CONVS > 0) instances = instances.slice(0, CONVS);
  process.stderr.write(`[beam] ${instances.length} conversations, answer=${ANSWER_DEP}, judge=${JUDGE_DEP}\n`);

  type Row = { conversationId: string; dimension: string; questionId: string; score: number };
  const rows: Row[] = [];
  let done = 0;

  for (const inst of instances) {
    const adapter = newAdapter(llm);
    await adapter.ingest(inst);
    const answered = await mapPool(inst.questions, CONC, async (q) => {
      const { answer } = await adapter.answer(q);
      // event_ordering keeps the float (BEAM); the other 9 dims int-floor.
      const floor = q.category !== "event_ordering";
      const { score } = await beamJudgeQuestion(judge, q.rubric ?? [], answer, { floor });
      return { conversationId: inst.id, dimension: q.category, questionId: q.id, score };
    });
    rows.push(...answered);
    await adapter.close();
    done++;
    process.stderr.write(`[beam] conversation ${done}/${instances.length} (${inst.id}) done\n`);
  }

  // Aggregate: per-dimension mean, then overall = mean over dimensions.
  const byDim = new Map<string, number[]>();
  for (const r of rows) { const a = byDim.get(r.dimension) ?? []; a.push(r.score); byDim.set(r.dimension, a); }
  const perDim: Record<string, { mean: number; n: number }> = {};
  for (const d of BEAM_DIMENSIONS) {
    const s = byDim.get(d) ?? [];
    perDim[d] = { mean: s.length ? s.reduce((a, b) => a + b, 0) / s.length : 0, n: s.length };
  }
  const dims = BEAM_DIMENSIONS.filter((d) => perDim[d].n > 0);
  const overall = dims.length ? dims.reduce((a, d) => a + perDim[d].mean, 0) / dims.length : 0;

  const report = { data: DATA, conversations: instances.length, answerModel: ANSWER_DEP, judgeModel: JUDGE_DEP, perDim, overall, n: rows.length };
  console.log(`\n=== BEAM ${path.basename(DATA)} (answer=${ANSWER_DEP}, judge=${JUDGE_DEP}, ${instances.length} convs, ${rows.length} Q) ===`);
  for (const d of BEAM_DIMENSIONS) console.log(`  ${d.padEnd(26)} ${(100 * perDim[d].mean).toFixed(1)}%  (n=${perDim[d].n})`);
  console.log(`  ${"OVERALL (mean of dims)".padEnd(26)} ${(100 * overall).toFixed(1)}%`);
  console.log(`Mastra/others don't publish BEAM; mem0 ref: 62% @1M, 48.6% @10M.`);
  if (OUT) { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(report, null, 2)); process.stderr.write(`[beam] wrote ${OUT}\n`); }
}

main().catch((e) => { process.stderr.write(`[beam] error: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
