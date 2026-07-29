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
const CONVS = Number(arg("conversations", "0")); // 0 = all (count of conversations to run)
const CONV_START = Number(arg("conv-start", "0")); // 0-indexed start (for running a later batch and merging)
const ANSWER_DEP = arg("answer-deployment", "gpt-5.5")!;
const ANSWER_MODEL = arg("answer-model"); // separate deployment for the final answer only (isolates answer-model from extraction)
const JUDGE_DEP = arg("judge-deployment", "gpt-4.1")!;
const CONC = Number(arg("concurrency", "4"));
const OUT = arg("out");
const DETAILS_OUT = arg("details-out");
const ANSWER_PROMPT = arg("answer-prompt", "tuned")!; // tuned (BEAM-tuned, default) | v15 (legacy adapter prompt)
const CONSOLIDATION = arg("consolidation", "off")!; // off (default) | contradiction (cross-chunk synthesis pass)
const QUERY_ADAPTIVE = arg("query-adaptive", "off")!; // off (default) | on (route by question intent to a strategy-specific context/prompt)
const RETRIEVAL = arg("retrieval", "kb")!; // kb (default, cognitive-core flat) | minimem-graph (structural retrieval on minimem's graph)
const GRAPH_TRAVERSE = arg("graph-traverse", "off")!; // off (Stage 0, seed-only) | on (Stage 1, seed-then-traverse)
const QUERY_DECOMP = arg("query-decomp", "off")!; // off | on (split each question into sub-queries, union graph retrievals)
const GRAPH_SUMMARIES = arg("graph-summaries", "off")!; // off | on (synthesize hierarchical summaries as retrievable nodes)
const RERANK = arg("rerank", "off")!; // off | llm (LLM reranker over a larger candidate pool -> topK)
const EMBED_MODEL = arg("embed-model"); // override minimem-graph store's local embedding (GGUF hf: path)
const SAMPLES = Number(arg("samples", "1")); // answers per question; score = mean (majority-of-N noise control)
const DIMS = (arg("dims") ?? "").split(",").map((s) => s.trim()).filter(Boolean); // limit to these categories (empty = all)

// BEAM-tuned answer prompt (validated +4-5pp over v15 on held-out): comprehensive
// + closed-book, LongMemEval-specific rules removed, contradiction-flagging added.
function beamTunedPrompt(
  question: string,
  _date: string | undefined,
  excerpts: { ref?: string; text: string }[],
  _cat?: string,
): string {
  const ctx = excerpts.map((e) => `- ${e.ref ? `[${e.ref}] ` : ""}${e.text}`).join("\n");
  return [
    "You are answering a question about a user using ONLY the memory excerpts below, drawn from the user's past conversations with an assistant.",
    "Answer as completely and specifically as possible, grounded strictly in the excerpts.",
    "",
    "Rules:",
    "- Use ONLY the excerpts; do NOT use outside knowledge. If the excerpts do not contain the information needed, say the information is not available / not mentioned.",
    "- Be thorough: address EVERY part of the question and include the specific supporting facts (names, numbers, dates, events) from the excerpts. When a question has multiple aspects, cover each one.",
    "- Contradictions: if the excerpts contain conflicting statements about the same thing that were never reconciled (e.g. \"I have never done X\" and \"I did X\"), explicitly state that there is contradictory information, quote BOTH conflicting statements, and note that it is unclear which is correct — do NOT silently pick one side.",
    "- Updates: if a fact/value/state changed over time (a genuine update, not an unreconciled conflict), give the most recent value and briefly note the prior value and when it changed.",
    "- Counts / lists / orderings: enumerate the relevant items completely from the excerpts; for ordering, sort by date/time; for counts, count distinct real-world items.",
    "- Time: resolve relative dates (\"last week\", \"two weeks ago\") against the question's reference date when available; for elapsed-time questions, show the calculation.",
    "- Preferences / instructions: recall the user's stated preferences or instructions from the excerpts and apply them to the question.",
    "- Be direct, but include enough supporting detail to fully satisfy every part of the question.",
    "",
    "Memory excerpts:",
    ctx,
    "",
    `Question: ${question}`,
    "Answer:",
  ].join("\n");
}

// gpt-5.6-sol answer prompt: keeps the comprehensive/synthesis framing (sol is a much
// stronger summarizer) but hardens the three dims sol regressed on with the plain tuned
// prompt (contradiction, instruction-following, abstention) — sol answers more elaborately
// and confidently, so these need explicit discipline + scope calibration.
function beamSolPrompt(
  question: string,
  _date: string | undefined,
  excerpts: { ref?: string; text: string }[],
  _cat?: string,
): string {
  const ctx = excerpts.map((e) => `- ${e.ref ? `[${e.ref}] ` : ""}${e.text}`).join("\n");
  return [
    "You are answering a question about a user using ONLY the memory excerpts below, drawn from the user's past conversations with an assistant.",
    "Ground every claim strictly in the excerpts, and calibrate the answer's scope to what the question actually asks.",
    "",
    "Rules:",
    "- ABSTENTION (critical): if the excerpts do not actually contain the information the question asks for, you MUST say the information is not available / not mentioned. Do NOT guess, infer, or construct a plausible-sounding answer from loosely related excerpts. A confident answer that the excerpts do not support is WRONG — when the evidence isn't there, decline.",
    "- CONTRADICTIONS: if the excerpts contain conflicting statements about the same thing that were never reconciled (e.g. \"I have never done X\" and \"I did X\"), you MUST explicitly state that the information is contradictory, quote BOTH conflicting statements, and note it is unclear which is correct. Do NOT resolve it yourself by picking the more recent, more detailed, or more plausible side.",
    "- FOLLOW THE QUESTION EXACTLY: answer precisely what is asked, in the form asked. For a specific/yes-no/single-value question, give exactly that and stop — do NOT add unrequested background, caveats, or elaboration. Match the question's scope; do not over-explain.",
    "- Be COMPLETE when the question warrants it: for summary, overview, or multi-part questions, cover every major point/aspect thoroughly with the specific supporting facts (names, numbers, dates, events). Scale the length to the question — comprehensive for broad questions, terse for narrow ones.",
    "- Updates: if a fact/value/state changed over time (a genuine update, not an unreconciled conflict), give the most recent value and briefly note the prior value and when it changed.",
    "- Counts / lists / orderings: enumerate the relevant items completely from the excerpts; for ordering, sort by date/time; for counts, count distinct real-world items.",
    "- Time: resolve relative dates against the question's reference date when available; for elapsed-time questions, show the calculation.",
    "- Preferences / instructions: recall the user's stated preferences or instructions from the excerpts and apply them exactly.",
    "",
    "Memory excerpts:",
    ctx,
    "",
    `Question: ${question}`,
    "Answer:",
  ].join("\n");
}

// Query-adaptive prompts: summarization wants a holistic, comprehensive answer over
// the (already broad) context; temporal/ordering questions get a timeline-first prompt
// (the adapter prepends an explicit chronological timeline to the context).
function beamSummaryPrompt(question: string, _date: string | undefined, excerpts: { ref?: string; text: string }[]): string {
  const ctx = excerpts.map((e) => `- ${e.ref ? `[${e.ref}] ` : ""}${e.text}`).join("\n");
  return [
    "You are producing a COMPREHENSIVE, well-organized answer to a summarization question about a user, using ONLY the memory context below (drawn from the user's past conversations with an assistant).",
    "",
    "Rules:",
    "- Cover ALL major topics, themes, projects, events, decisions, and changes over time that are relevant to the question — be complete and representative, not selective. A good summary reflects the full breadth of the history.",
    "- Organize the answer clearly (by theme or chronologically) and group related points together.",
    "- Include concrete specifics (names, dates, numbers, outcomes) in service of the overview, not as isolated facts.",
    "- If the question scopes the summary to a topic or time range, summarize that scope thoroughly and completely.",
    "- Use ONLY the context; if something is not present, do not invent it.",
    "",
    "Memory context:",
    ctx,
    "",
    `Question: ${question}`,
    "Comprehensive answer:",
  ].join("\n");
}

function beamTimelinePrompt(question: string, date: string | undefined, excerpts: { ref?: string; text: string }[]): string {
  const ctx = excerpts.map((e) => `- ${e.ref ? `[${e.ref}] ` : ""}${e.text}`).join("\n");
  return [
    "You are answering a TIME-based question about a user using ONLY the memory context below. A chronological TIMELINE of dated observations appears near the top of the context — use it to establish the order and dates of events.",
    "",
    "Rules:",
    "- For ordering questions, determine the correct chronological order by date and list events in order.",
    "- For elapsed-time / duration questions, identify the two relevant dated events and compute the interval, showing the dates and the calculation.",
    `- Resolve relative dates ("last week", "two weeks ago") against the question's reference date when available${date ? ` (reference date: ${date})` : ""}.`,
    "- Ground every date and ordering claim in the timeline/context; do not invent or guess dates.",
    "- Be specific and complete.",
    "",
    "Memory context:",
    ctx,
    "",
    `Question: ${question}`,
    "Answer:",
  ].join("\n");
}

// Intent router (oracle: uses BEAM's question category). A real deployment would infer
// intent with a classifier; oracle routing isolates the strategy's value from router error.
function beamAdaptivePrompt(
  question: string,
  date: string | undefined,
  excerpts: { ref?: string; text: string }[],
  category?: string,
): string {
  if (category === "summarization") return beamSummaryPrompt(question, date, excerpts);
  if (category === "temporal_reasoning" || category === "event_ordering") return beamTimelinePrompt(question, date, excerpts);
  return beamTunedPrompt(question, date, excerpts, category);
}

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

// Consolidation (synthesis) runs a reasoning model over ALL observations; give it a
// large completion budget (reasoning models spend most of the budget on reasoning).
const consolidationLlm = new LlmClient({ deployment: ANSWER_DEP, maxCompletionTokens: 16_000, maxRetries: 5 });
// Query decomposition is a small, fast task — use gpt-4.1 (non-reasoning), not the answer model.
const queryDecomposeLlm = new LlmClient({ deployment: "gpt-4.1", maxCompletionTokens: 400, maxRetries: 5 });
// Summary synthesis reads all observations and writes several thorough summaries — big output budget.
const graphSummaryLlm = new LlmClient({ deployment: "gpt-4.1", maxCompletionTokens: 6000, maxRetries: 5 });
// Reranker: a small, fast listwise LLM call (returns a JSON array of note numbers).
const rerankLlm = new LlmClient({ deployment: "gpt-4.1", maxCompletionTokens: 300, maxRetries: 5 });
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
    liveToolPolicy: "auto",
    liveToolQueries: 2,
    liveToolResults: 6,
    memoryProfile: "long-memory",
    onProgress: () => {},
    ...(answerModelLlm ? { answerLlm: answerModelLlm } : {}),
    ...(QUERY_ADAPTIVE === "on"
      ? { answerPromptOverride: beamAdaptivePrompt, queryAdaptive: "on" as const }
      : ANSWER_PROMPT === "sol"
        ? { answerPromptOverride: beamSolPrompt }
        : ANSWER_PROMPT === "tuned"
          ? { answerPromptOverride: beamTunedPrompt }
          : {}),
    ...(CONSOLIDATION !== "off" ? { consolidation: CONSOLIDATION as "contradiction", consolidationLlm } : {}),
    ...(RETRIEVAL === "minimem-graph"
      ? {
          retrieval: "minimem-graph" as const,
          minimemTraverse: GRAPH_TRAVERSE === "on",
          ...(QUERY_DECOMP === "on" ? { queryDecompose: true, queryDecomposeLlm } : {}),
          ...(GRAPH_SUMMARIES === "on" ? { graphSummaries: true, graphSummaryLlm } : {}),
          ...(RERANK === "llm" ? { rerank: "llm" as const, rerankLlm } : {}),
          ...(EMBED_MODEL ? { minimemEmbeddingModel: EMBED_MODEL } : {}),
        }
      : {}),
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
  // Namespace instance ids by dataset so caches (observations/derived/minimem-graph),
  // which are keyed by id, don't collide across splits (100K conv "1" vs 500K conv "1").
  // Empty tag for the 100K default preserves its existing caches.
  const tag = /100K/.test(DATA) ? "" : `${path.basename(DATA).replace(/\.json$/, "")}--`;
  if (tag) instances = instances.map((i) => ({ ...i, id: `${tag}${i.id}` }));
  const sliceEnd = CONVS > 0 ? CONV_START + CONVS : instances.length;
  instances = instances.slice(CONV_START, sliceEnd);
  process.stderr.write(`[beam] ${instances.length} conversations, answer=${ANSWER_DEP}, judge=${JUDGE_DEP}\n`);

  type Row = { conversationId: string; dimension: string; questionId: string; score: number };
  const rows: Row[] = [];
  const details: Array<Record<string, unknown>> = [];
  let done = 0;

  for (const inst of instances) {
    const questions = DIMS.length ? inst.questions.filter((q) => DIMS.includes(q.category)) : inst.questions;
    if (questions.length === 0) {
      done++;
      process.stderr.write(`[beam] conversation ${done}/${instances.length} (${inst.id}) skipped (no matching dims)\n`);
      continue;
    }
    const adapter = newAdapter(llm);
    await adapter.ingest(inst);
    const answered = await mapPool(questions, CONC, async (q) => {
      // event_ordering keeps the float (BEAM); the other 9 dims int-floor.
      const floor = q.category !== "event_ordering";
      const scores: number[] = [];
      let lastAnswer = "";
      let lastRetrieved: { ref?: string; text: string }[] = [];
      let lastPerItem: unknown;
      for (let s = 0; s < SAMPLES; s++) {
        const res = await adapter.answer(q);
        const judged = await beamJudgeQuestion(judge, q.rubric ?? [], res.answer, { floor });
        scores.push(judged.score);
        lastAnswer = res.answer;
        lastRetrieved = (res.retrieved ?? []).map((e) => ({ ref: e.ref, text: e.text }));
        lastPerItem = judged.perItem;
      }
      const score = scores.reduce((a, b) => a + b, 0) / scores.length;
      const row: Row = { conversationId: inst.id, dimension: q.category, questionId: q.id, score };
      if (DETAILS_OUT) {
        details.push({
          conversationId: inst.id,
          dimension: q.category,
          questionId: q.id,
          question: q.question,
          rubric: q.rubric ?? [],
          reference: q.answer,
          answer: lastAnswer,
          perItem: lastPerItem,
          score,
          samples: SAMPLES,
          sampleScores: scores,
          retrieved: lastRetrieved,
        });
      }
      return row;
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
  if (DETAILS_OUT) {
    fs.mkdirSync(path.dirname(DETAILS_OUT), { recursive: true });
    fs.writeFileSync(DETAILS_OUT, details.map((d) => JSON.stringify(d)).join("\n") + "\n");
    process.stderr.write(`[beam] wrote ${DETAILS_OUT} (${details.length} rows)\n`);
  }
}

main().catch((e) => { process.stderr.write(`[beam] error: ${e instanceof Error ? e.stack : String(e)}\n`); process.exit(1); });
