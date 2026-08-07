/**
 * De-risk cross-chunk synthesis, starting with CONTRADICTION DETECTION.
 *
 * Thesis: BEAM's cross-chunk dims fail because flat retrieval surfaces both sides
 * of a contradiction but nothing FLAGS them as contradictory. Test whether a
 * question-agnostic "contradictions block" — synthesized once per conversation
 * from its observations (ingestion-time) and injected into the answer context —
 * lifts contradiction_resolution without hurting other dims. Offline, over the
 * stored retrieved context; tuned prompt; BEAM rubric judge (gpt-4.1).
 *
 *   baseline : tuned prompt over stored retrieved excerpts
 *   +block   : same, with the detected contradictions block prepended
 */
import fs from "node:fs";
import path from "node:path";
import { beamJudgeQuestion, BEAM_DIMENSIONS } from "swarmkit-eval";
import { LlmClient } from "../locomo/llm.js";

function arg(n: string, d?: string): string | undefined {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
}
const DETAILS = arg("details", "evals/beam/results/beam-100K-details.jsonl")!;
const ANSWER_DEP = arg("answer-deployment", "gpt-5.5")!;
const CONC = Number(arg("conc", "5"));
const SAMPLES = Number(arg("samples", "1"));
const ONLY_DIMS = (arg("dims") ?? "").split(",").filter(Boolean); // empty = all
const OBS_DIR = "evals/longmemeval/.cache/cogcore-observations";
const CD_DIR = "evals/beam/cache/contradictions";
fs.mkdirSync(CD_DIR, { recursive: true });

const BASE = (process.env.AZURE_API_BASE || "").replace(/\/$/, "");
const KEY = process.env.AZURE_API_KEY!;
const VER = process.env.AZURE_API_VERSION!;
const judgeUrl = `${BASE}/openai/deployments/gpt-4.1/chat/completions?api-version=${VER}`;
const GATE = arg("gate", "off")!; // off (blanket) | llm (relevance-gated, production-faithful routing proxy)
const answerLlm = new LlmClient({ deployment: ANSWER_DEP, maxCompletionTokens: 8192, maxRetries: 6 });
const detectLlm = new LlmClient({ deployment: "gpt-5.5", maxCompletionTokens: 16000, maxRetries: 6 });
const gateLlm = new LlmClient({ deployment: "gpt-4.1", maxCompletionTokens: 800, maxRetries: 6 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function judge(prompt: string): Promise<string> {
  for (let att = 0; att <= 6; att++) {
    try {
      const res = await fetch(judgeUrl, { method: "POST", headers: { "api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 400 }) });
      if (res.status === 429 || res.status >= 500) { await sleep(Math.min(30000, 1000 * 2 ** att)); continue; }
      if (res.status === 400) return '{"score": 0}';
      if (!res.ok) throw new Error(`judge HTTP ${res.status}`);
      const j = (await res.json()) as { choices: { message: { content: string } }[] };
      return j.choices[0]?.message?.content ?? "";
    } catch (e) { if (att === 6) throw e; await sleep(Math.min(30000, 1000 * 2 ** att)); }
  }
  return '{"score": 0}';
}

type Excerpt = { ref?: string; text: string };
const ctxOf = (ex: Excerpt[]) => ex.map((e) => `- ${e.ref ? `[${e.ref}] ` : ""}${e.text}`).join("\n");

function tunedPrompt(question: string, excerpts: Excerpt[]): string {
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
    "- Time: resolve relative dates against the question's reference date when available; for elapsed-time questions, show the calculation.",
    "- Preferences / instructions: recall the user's stated preferences or instructions from the excerpts and apply them to the question.",
    "- Be direct, but include enough supporting detail to fully satisfy every part of the question.",
    "",
    "Memory excerpts:",
    ctxOf(excerpts),
    "",
    `Question: ${question}`,
    "Answer:",
  ].join("\n");
}

// --- Contradiction detection (question-agnostic, once per conversation, cached) ---
type Obs = { statement: string; date?: string; type?: string; status?: string };
function loadObs(instanceId: string): Obs[] {
  const p = path.join(OBS_DIR, `${String(instanceId).replace(/[^a-zA-Z0-9._-]/g, "_")}.combined.json`);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8")).observations ?? [];
}
const DETECT = [
  "You are auditing a user's conversation memory for CONTRADICTIONS: cases where the record contains conflicting or inconsistent statements about the same thing that were never reconciled (e.g. \"I have never done X\" appearing alongside \"I did X / I recently did X\").",
  "Scan the dated observations below and list every GENUINE unreconciled contradiction. For each, give: the topic, statement A (with its date), statement B (with its date), and one line on why they conflict.",
  "Do NOT list normal updates where a value legitimately changed over time (that is not a contradiction). Only list true conflicts a user would find inconsistent.",
  "If there are no genuine contradictions, output exactly: NONE.",
].join("\n");

const cdCache = new Map<string, string>();
async function contradictionsBlock(instanceId: string): Promise<string> {
  if (cdCache.has(instanceId)) return cdCache.get(instanceId)!;
  const cp = path.join(CD_DIR, `${String(instanceId).replace(/[^a-zA-Z0-9._-]/g, "_")}.txt`);
  if (fs.existsSync(cp)) { const v = fs.readFileSync(cp, "utf8"); cdCache.set(instanceId, v); return v; }
  const obs = loadObs(instanceId);
  const body = obs.map((o) => `- [${o.date ?? "undated"}] ${o.statement}`).join("\n");
  const out = (await detectLlm.chat([{ role: "user", content: `${DETECT}\n\nObservations:\n${body}\n\nContradictions:` }])).text.trim();
  fs.writeFileSync(cp, out);
  cdCache.set(instanceId, out);
  return out;
}

// --- Relevance gate: production-faithful routing proxy. Would a retriever surface
// this contradiction for THIS question? Filter the block to the relevant items only. ---
const GATE_PROMPT = [
  "You are deciding which known contradictions (if any) are relevant to answering ONE specific question about a user.",
  "A contradiction is relevant ONLY if answering the question requires knowing about that specific conflict (e.g. the question asks whether the user has ever done something, or asks to reconcile/verify a claim that a listed contradiction bears on).",
  "Be strict. Most questions are NOT about any contradiction.",
  "Output ONLY the relevant contradictions, copied verbatim from the list. If none are relevant, output exactly: NONE.",
].join("\n");
async function gateBlock(question: string, block: string): Promise<string> {
  if (GATE !== "llm" || /^NONE\b/i.test(block)) return block;
  const out = (await gateLlm.chat([{ role: "user", content: `${GATE_PROMPT}\n\nKnown contradictions:\n${block}\n\nQuestion: ${question}\n\nRelevant contradictions:` }])).text.trim();
  return out;
}

type Detail = { conversationId: string; dimension: string; question: string; rubric: string[]; retrieved: Excerpt[] };

async function mapPool<T, R>(items: T[], limit: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length); let idx = 0, done = 0;
  const worker = async () => { while (idx < items.length) { const i = idx++; out[i] = await fn(items[i], i); if (++done % 30 === 0) process.stderr.write(`  ${done}/${items.length}\n`); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
async function scoreMaj(question: string, excerpts: Excerpt[], rubric: string[], floor: boolean): Promise<number> {
  const s: number[] = [];
  for (let k = 0; k < SAMPLES; k++) {
    const ans = (await answerLlm.chat([{ role: "user", content: tunedPrompt(question, excerpts) }])).text.trim();
    s.push((await beamJudgeQuestion(judge, rubric, ans, { floor })).score);
  }
  return s.reduce((a, b) => a + b, 0) / s.length;
}

let rows: Detail[] = fs.readFileSync(DETAILS, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
if (ONLY_DIMS.length) rows = rows.filter((r) => ONLY_DIMS.includes(r.dimension));
process.stderr.write(`[cd] ${rows.length} questions, samples=${SAMPLES}, dims=${ONLY_DIMS.length ? ONLY_DIMS.join(",") : "all"}\n`);
// pre-warm contradiction blocks per conversation
const convIds = [...new Set(rows.map((r) => r.conversationId))];
await mapPool(convIds, 4, async (cid) => { await contradictionsBlock(cid); return 0; });
const detected = convIds.filter((c) => !/^NONE\b/i.test(cdCache.get(c) ?? "NONE")).length;
process.stderr.write(`[cd] contradictions detected in ${detected}/${convIds.length} conversations\n`);

const scored = await mapPool(rows, CONC, async (r) => {
  const floor = r.dimension !== "event_ordering";
  const raw = await contradictionsBlock(r.conversationId);
  const block = await gateBlock(r.question, raw);
  const injected = !/^NONE\b/i.test(block);
  const base = await scoreMaj(r.question, r.retrieved, r.rubric ?? [], floor);
  // When nothing is injected (gate said NONE / no contradictions), the context is
  // identical to baseline — reuse the score (cheaper, and removes sampling noise on nulls).
  const blk = injected
    ? await scoreMaj(r.question, [{ ref: "detected-contradictions", text: `KNOWN UNRECONCILED CONTRADICTIONS IN THE RECORD:\n${block}` }, ...r.retrieved], r.rubric ?? [], floor)
    : base;
  return { dim: r.dimension, base, blk, injected: injected ? 1 : 0 };
});

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
console.log(`\n=== CONTRADICTION-BLOCK de-risk (tuned prompt; n=${scored.length}, samples=${SAMPLES}, gate=${GATE}, judge=gpt-4.1) ===`);
console.log(`contradictions detected in ${detected}/${convIds.length} conversations\n`);
console.log(`${"dimension".padEnd(26)} ${"tuned".padStart(8)} ${"+block".padStart(8)}   delta`);
for (const d of BEAM_DIMENSIONS) {
  const s = scored.filter((x) => x.dim === d);
  if (!s.length) continue;
  const b = mean(s.map((x) => x.base)), k = mean(s.map((x) => x.blk));
  console.log(`${d.padEnd(26)} ${(100 * b).toFixed(1).padStart(7)}% ${(100 * k).toFixed(1).padStart(7)}%   ${k - b >= 0 ? "+" : ""}${(100 * (k - b)).toFixed(1)}`);
}
const ov = (key: "base" | "blk") => mean(BEAM_DIMENSIONS.map((d) => mean(scored.filter((x) => x.dim === d).map((x) => x[key]))).filter((n) => !Number.isNaN(n)));
console.log(`${"OVERALL (mean of dims)".padEnd(26)} ${(100 * ov("base")).toFixed(1).padStart(7)}% ${(100 * ov("blk")).toFixed(1).padStart(7)}%   ${ov("blk") - ov("base") >= 0 ? "+" : ""}${(100 * (ov("blk") - ov("base"))).toFixed(1)}`);
const injectedTotal = scored.reduce((a, x) => a + ((x as { injected?: number }).injected ?? 0), 0);
console.log(`block injected into ${injectedTotal}/${scored.length} questions (gate=${GATE})`);
const injByDim = BEAM_DIMENSIONS.map((d) => { const s = scored.filter((x) => x.dim === d); const inj = s.reduce((a, x) => a + ((x as { injected?: number }).injected ?? 0), 0); return `${d}:${inj}`; }).join("  ");
console.log(`  injected-by-dim: ${injByDim}`);
console.log(`answer tokens=${answerLlm.totals.totalTokens}, detect tokens=${detectLlm.totals.totalTokens}, gate tokens=${gateLlm.totals.totalTokens}`);
