/**
 * LongMemEval full QA harness — ingest → retrieve/answer → mem0-judge,
 * with abstention scoring, on swarmkit-eval's memory-QA harness.
 *
 *   npx tsx evals/longmemeval/qa.ts --arms local --per-category 10 --k 10 --out lme-qa.md
 *   npx tsx evals/longmemeval/qa.ts --arms none,local --per-category 8 --concurrency 4
 *
 * Raw minimem arms build an index over the haystack turns, retrieve top-k,
 * evict the index, have GPT-5.5 answer from the retrieved excerpts, then judge.
 * Cogcore arms ingest the haystack into cognitive-core first, then answer from
 * retrieved cognitive-core notes.
 *   - answerable questions → mem0 J-judge (generous, LoCoMo-leaderboard prompt)
 *   - abstention questions (`*_abs`) → scored on refusal, not gold-match
 *
 * Retrieval index builds are serialized inside the adapter (embedding safety);
 * the LLM answer+judge calls run concurrently up to --concurrency.
 */

import fs from "node:fs/promises";
import path from "node:path";

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
import {
  CogcoreLongMemEvalAdapter,
  CogcoreLiveLongMemEvalAdapter,
  COGCORE_EXTRACTION_CACHE_VERSION,
  COGCORE_OBSERVATION_CACHE_VERSION,
  defaultSystemExperienceSlots,
  type LiveAnswerTrace,
  type ExperienceEmbedding,
  type ExperienceGranularity,
  type ExperienceScope,
  type LiveToolPolicy,
  type ObservationContextMode,
  type ObservationExtractionSource,
  type ObservationMemoryMode,
  type CogcoreLiveLongMemEvalArm,
  type CogcoreLongMemEvalArm,
} from "./cogcore-memory.js";
import { createMinimemSearch, type Embeddings } from "./minimem-search.js";
import {
  buildLongMemEvalAnswerPrompt,
  LME_ANSWER_PROMPT_VERSION,
  type LongMemEvalAnswerExcerpt,
} from "./prompt.js";
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

type RetrievalArm = Embeddings;
type Arm = RetrievalArm | CogcoreLongMemEvalArm | CogcoreLiveLongMemEvalArm;
type QAJudgedBy = MemoryQARecord["judgedBy"] | "retrieval-only";
type MemoryProfile = "standard" | "long-memory";

interface MemoryProfileDefaults {
  experienceGranularity: ExperienceGranularity;
  experienceEmbedding: ExperienceEmbedding;
  experienceScope: ExperienceScope;
  experiencePoolSize: number;
  observationMemory: ObservationMemoryMode;
  observationSource: ObservationExtractionSource;
  observationContext: ObservationContextMode;
  observationLogMaxChars: number;
  observationMaxPerChunk: number;
  observationSlots: number;
  liveToolPolicy: LiveToolPolicy;
  liveToolQueries: number;
  liveToolResults: (k: number) => number;
}

const STANDARD_MEMORY_PROFILE_DEFAULTS: MemoryProfileDefaults = {
  experienceGranularity: "session",
  experienceEmbedding: "none",
  experienceScope: "knowledge-sessions",
  experiencePoolSize: 64,
  observationMemory: "off",
  observationSource: "chunks",
  observationContext: "retrieved",
  observationLogMaxChars: 80_000,
  observationMaxPerChunk: 12,
  observationSlots: 12,
  liveToolPolicy: "auto",
  liveToolQueries: 2,
  liveToolResults: (k) => Math.min(8, k),
};

const LONG_MEMORY_PROFILE_DEFAULTS: MemoryProfileDefaults = {
  ...STANDARD_MEMORY_PROFILE_DEFAULTS,
  experienceGranularity: "chunk",
  experienceEmbedding: "hash",
  observationMemory: "kb",
  observationSource: "combined",
  observationContext: "both",
  observationLogMaxChars: 40_000,
  liveToolResults: () => 6,
};

const RETRIEVAL_ARMS: RetrievalArm[] = ["none", "local", "nomic"];
const COGCORE_ARMS: CogcoreLongMemEvalArm[] = [
  "cogcore-memory",
  "cogcore-hybrid",
  "cogcore-hybrid-mq",
  "cogcore-evolve",
  "cogcore-system",
  "cogcore-system-evolve",
];
const COGCORE_LIVE_ARMS: CogcoreLiveLongMemEvalArm[] = ["cogcore-live"];
const KNOWN_ARMS: Arm[] = [...RETRIEVAL_ARMS, ...COGCORE_ARMS, ...COGCORE_LIVE_ARMS];
const RETRIEVAL_ONLY_ANSWER = "[retrieval-only]";
const RETRIEVAL_ONLY_JUDGED_BY = "retrieval-only" as QAJudgedBy;

function isRetrievalArm(arm: Arm): arm is RetrievalArm {
  return RETRIEVAL_ARMS.includes(arm as RetrievalArm);
}

function isCogcoreArm(arm: Arm): arm is CogcoreLongMemEvalArm {
  return COGCORE_ARMS.includes(arm as CogcoreLongMemEvalArm);
}

function isCogcoreLiveArm(arm: Arm): arm is CogcoreLiveLongMemEvalArm {
  return COGCORE_LIVE_ARMS.includes(arm as CogcoreLiveLongMemEvalArm);
}

function parseArms(spec: string | boolean | undefined): Arm[] {
  if (!spec || spec === true) return ["local"];
  const arms = String(spec).split(",").map((s) => s.trim()).filter(Boolean) as Arm[];
  for (const a of arms) {
    if (!KNOWN_ARMS.includes(a)) throw new Error(`Unknown arm '${a}'. Use ${KNOWN_ARMS.join("|")}.`);
  }
  return arms;
}

function parseMemoryProfile(spec: string | boolean | undefined, fallback: MemoryProfile): MemoryProfile {
  const value = spec && spec !== true ? String(spec) : fallback;
  if (value === "standard" || value === "long-memory") return value;
  throw new Error(`Unknown --memory-profile '${value}'. Use standard|long-memory.`);
}

function defaultsForMemoryProfile(profile: MemoryProfile): MemoryProfileDefaults {
  return profile === "long-memory" ? LONG_MEMORY_PROFILE_DEFAULTS : STANDARD_MEMORY_PROFILE_DEFAULTS;
}

function parseExperienceGranularity(
  spec: string | boolean | undefined,
  fallback: ExperienceGranularity,
): ExperienceGranularity {
  const value = spec && spec !== true ? String(spec) : fallback;
  if (value === "session" || value === "chunk" || value === "turn") return value;
  throw new Error(`Unknown --experience-granularity '${value}'. Use session|chunk|turn.`);
}

function parseExperienceEmbedding(
  spec: string | boolean | undefined,
  fallback: ExperienceEmbedding,
): ExperienceEmbedding {
  const value = spec && spec !== true ? String(spec) : fallback;
  if (value === "none" || value === "hash") return value;
  throw new Error(`Unknown --experience-embedding '${value}'. Use none|hash.`);
}

function parseExperienceScope(spec: string | boolean | undefined, fallback: ExperienceScope): ExperienceScope {
  const value = spec && spec !== true ? String(spec) : fallback;
  if (value === "knowledge-sessions" || value === "all") return value;
  throw new Error(`Unknown --experience-scope '${value}'. Use knowledge-sessions|all.`);
}

function parseObservationMemory(
  spec: string | boolean | undefined,
  fallback: ObservationMemoryMode,
): ObservationMemoryMode {
  const value = spec && spec !== true ? String(spec) : fallback;
  if (value === "off" || value === "kb") return value;
  throw new Error(`Unknown --observation-memory '${value}'. Use off|kb.`);
}

function parseObservationSource(
  spec: string | boolean | undefined,
  fallback: ObservationExtractionSource,
): ObservationExtractionSource {
  const value = spec && spec !== true ? String(spec) : fallback;
  if (value === "chunks" || value === "combined") return value;
  throw new Error(`Unknown --observation-source '${value}'. Use chunks|combined.`);
}

function parseObservationContext(
  spec: string | boolean | undefined,
  fallback: ObservationContextMode,
): ObservationContextMode {
  const value = spec && spec !== true ? String(spec) : fallback;
  if (value === "retrieved" || value === "log" || value === "both") return value;
  throw new Error(`Unknown --observation-context '${value}'. Use retrieved|log|both.`);
}

function parseLiveToolPolicy(spec: string | boolean | undefined, fallback: LiveToolPolicy): LiveToolPolicy {
  const value = spec && spec !== true ? String(spec) : fallback;
  if (value === "auto" || value === "always" || value === "off") return value;
  throw new Error(`Unknown --live-tool-policy '${value}'. Use auto|always|off.`);
}

function parseCategories(spec: string | boolean | undefined): string[] {
  if (!spec || spec === true) return [];
  return String(spec).split(",").map((s) => s.trim()).filter(Boolean);
}

const RETRYABLE_ERROR_PATTERNS = [
  /azure .* exhausted retries/i,
  /\bfetch failed\b/i,
  /\brequest timed out\b/i,
  /\babort(?:ed)?\b/i,
  /\btimeout\b/i,
  /\bECONNRESET\b/i,
  /\bETIMEDOUT\b/i,
  /\bENOTFOUND\b/i,
  /\bECONNREFUSED\b/i,
  /\bEAI_AGAIN\b/i,
  /\b429\b/i,
  /\brate limit/i,
  /\btoo many requests\b/i,
  /\b5\d\d\b/,
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableEvalError(message: string | undefined): boolean {
  if (!message) return false;
  return RETRYABLE_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

function retryDelayMs(attempt: number, message: string | undefined): number {
  if (message && /\b429\b|rate limit|too many requests/i.test(message)) return Math.min(120_000, 30_000 + attempt * 30_000);
  return Math.min(45_000, 10_000 + attempt * 10_000);
}

async function loadErroredQuestionIdsFromDetails(file: string): Promise<string[]> {
  const raw = await fs.readFile(file, "utf-8");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      throw new Error(
        `Could not parse ${file}:${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!parsed || typeof parsed !== "object") continue;
    const record = parsed as { type?: unknown; questionId?: unknown; error?: unknown };
    if (record.type !== "record" || typeof record.questionId !== "string" || typeof record.error !== "string") {
      continue;
    }
    if (!seen.has(record.questionId)) {
      seen.add(record.questionId);
      out.push(record.questionId);
    }
  }
  return out;
}

function sampleByQuestionIds(source: ReturnType<typeof loadLongMemEvalCached>, questionIds: string[]): SampledMemQuestion[] {
  const byId = new Map<string, SampledMemQuestion>();
  for (const instance of source) {
    for (const question of instance.questions) {
      if (questionIds.includes(question.id)) byId.set(question.id, { instance, question });
    }
  }
  const missing = questionIds.filter((id) => !byId.has(id));
  if (missing.length > 0) throw new Error(`Unknown --question-ids value(s): ${missing.join(", ")}`);
  return questionIds.map((id) => byId.get(id)!);
}

interface RetrievedDetail {
  rank: number;
  ref: string;
  text: string;
  channel?: "raw" | "knowledge" | "experience" | "tool";
  score?: number;
  sourceRank?: number;
  sourceScore?: number;
  query?: string;
  noteId?: string;
  matchType?: string;
  experienceId?: string;
  turnIds?: string[];
  selectedBy?: string;
  docId?: string;
  sessionId?: string;
  turnId?: string;
  speaker?: string;
  date?: string;
}

interface EvidenceHit {
  turnId: string;
  sessionId?: string;
  rank?: number;
  ref?: string;
  channel?: RetrievedDetail["channel"];
  method: "turn-id" | "text-overlap" | "missing";
  overlap?: number;
  threshold?: number;
}

interface EvidenceCoverage {
  total: number;
  hit: number;
  allHit: boolean;
  missingTurnIds: string[];
  maxHitRank?: number;
  hits: EvidenceHit[];
}

interface MatchingFact {
  index: number;
  overlap: number;
  fact: string;
  entities: string[];
}

interface MatchingAction {
  index: number;
  overlap: number;
  action: unknown;
}

interface CogcoreDebugArtifacts {
  extraction?: {
    path: string;
    facts: number;
    matchingFacts?: MatchingFact[];
  };
  evolution?: {
    path: string;
    actions: number;
    matchingActions?: MatchingAction[];
  };
}

interface QATimingMs {
  total: number;
  ingest?: number;
  retrieve?: number;
  answer?: number;
  adapterClose?: number;
  judge?: number;
  debug?: number;
}

interface QADetailRecord {
  type: "record";
  arm: Arm;
  instanceId: string;
  questionId: string;
  category: string;
  abstain: boolean;
  question: string;
  questionDate?: string;
  gold: string;
  answer: string;
  correct: boolean;
  judgedBy: QAJudgedBy;
  evidenceTurnIds: string[];
  evidenceSessionIds: string[];
  evidenceCoverage: EvidenceCoverage;
  retrieved: RetrievedDetail[];
  debug?: CogcoreDebugArtifacts;
  liveTrace?: LiveAnswerTrace;
  timingMs?: QATimingMs;
  retryAttempts?: number;
  retryErrors?: string[];
  error?: string;
}

interface ArmRunResult {
  report: MemoryQAReport;
  details: QADetailRecord[];
}

interface RunMetadataRecord {
  type: "run";
  createdAt: string;
  promptVersion: string;
  dataset: string;
  args: {
    arms: Arm[];
    k: number;
    perCategory: number;
    sample?: number;
    targetCategories?: string[];
    questionIdsFilter?: string[];
    retryErrorsFrom?: string;
    retryErrorQuestionIds?: string[];
    categoryOffset?: number;
    includeAbstain: boolean;
    abstainN: number;
    concurrency: number;
    cogcoreConcurrency: number;
    extractConcurrency: number;
    chunkTurns: number;
    maxFactsPerChunk: number;
    extractionCacheVersion: number;
    observationCacheVersion: number;
    memoryProfile: MemoryProfile;
    systemExperienceSlots?: number;
    experienceGranularity?: ExperienceGranularity;
    experienceChunkTurns?: number;
    experienceEmbedding?: ExperienceEmbedding;
    experienceScope?: ExperienceScope;
    experiencePoolSize?: number;
    experienceMinScore?: number;
    observationMemory?: ObservationMemoryMode;
    observationSource?: ObservationExtractionSource;
    observationContext?: ObservationContextMode;
    observationLogMaxChars?: number;
    observationMaxPerChunk?: number;
    observationSlots?: number;
    liveToolPolicy?: LiveToolPolicy;
    liveToolQueries?: number;
    liveToolResults?: number;
    maxCompletionTokens: number;
    recordRetries: number;
    retrievalOnly: boolean;
    debugAll: boolean;
  };
  questionIds: string[];
  categories: Record<string, number>;
  command: string[];
}

interface ArmSummaryRecord {
  type: "arm-summary";
  arm: Arm;
  accuracy: number;
  n: number;
  calls: number;
  tokens: number;
  wallMs: number;
}

type DetailJsonlRecord = RunMetadataRecord | QADetailRecord | ArmSummaryRecord;

const STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "but",
  "can",
  "did",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "into",
  "need",
  "not",
  "out",
  "the",
  "their",
  "then",
  "there",
  "they",
  "this",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "with",
  "you",
  "your",
]);

function safeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function tokenizeForDebug(...parts: Array<string | undefined>): Set<string> {
  const tokens = new Set<string>();
  for (const part of parts) {
    for (const tok of String(part ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)) {
      if (tok.length > 2 && !STOPWORDS.has(tok)) tokens.add(tok);
    }
  }
  return tokens;
}

function overlapScore(text: string, terms: Set<string>): number {
  let n = 0;
  const seen = new Set<string>();
  for (const tok of tokenizeForDebug(text)) {
    if (terms.has(tok) && !seen.has(tok)) {
      seen.add(tok);
      n++;
    }
  }
  return n;
}

async function readJsonIfExists<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8")) as T;
  } catch {
    return null;
  }
}

async function loadCogcoreDebugArtifacts(
  instanceId: string,
  question: string,
  gold: string,
  evidenceTexts: string[],
  includeMatches: boolean,
  includeEvolution: boolean,
): Promise<CogcoreDebugArtifacts | undefined> {
  const terms = tokenizeForDebug(question, gold, ...evidenceTexts);
  const extractionPath = path.resolve(
    "evals/longmemeval/.cache/cogcore-extractions",
    `${safeFileName(instanceId)}.json`,
  );
  const evolutionPath = path.resolve(
    "evals/longmemeval/.cache/cogcore-evolve-plans",
    `${safeFileName(instanceId)}.json`,
  );

  const out: CogcoreDebugArtifacts = {};
  const extraction = await readJsonIfExists<{
    facts?: Array<{ fact?: string; entities?: string[] }>;
  }>(extractionPath);
  if (Array.isArray(extraction?.facts)) {
    const scored = extraction.facts
      .map((f, index) => ({
        index,
        overlap: overlapScore(f.fact ?? "", terms),
        fact: f.fact ?? "",
        entities: Array.isArray(f.entities) ? f.entities : [],
      }))
      .filter((f) => f.fact && f.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
      .slice(0, 20);
    out.extraction = {
      path: extractionPath,
      facts: extraction.facts.length,
      ...(includeMatches ? { matchingFacts: scored } : {}),
    };
  }

  const evolution = includeEvolution
    ? await readJsonIfExists<{ plan?: { actions?: unknown[] } }>(evolutionPath)
    : null;
  if (Array.isArray(evolution?.plan?.actions)) {
    const scored = evolution.plan.actions
      .map((action, index) => ({
        index,
        overlap: overlapScore(JSON.stringify(action), terms),
        action,
      }))
      .filter((a) => a.overlap > 0)
      .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
      .slice(0, 20);
    out.evolution = {
      path: evolutionPath,
      actions: evolution.plan.actions.length,
      ...(includeMatches ? { matchingActions: scored } : {}),
    };
  }

  return out.extraction || out.evolution ? out : undefined;
}

function evidenceTextsForQuestion(
  instance: SampledMemQuestion["instance"],
  evidenceTurnIds: string[],
): string[] {
  const wanted = new Set(evidenceTurnIds);
  const out: string[] = [];
  for (const session of instance.sessions) {
    for (const turn of session.turns) {
      if (wanted.has(turn.id)) out.push(turn.text);
    }
  }
  return out;
}

function buildEvidenceCoverage(
  instance: SampledMemQuestion["instance"],
  evidenceTurnIds: string[],
  retrieved: RetrievedDetail[],
): EvidenceCoverage {
  const turnById = new Map<string, { text: string; sessionId: string }>();
  for (const session of instance.sessions) {
    for (const turn of session.turns) turnById.set(turn.id, { text: turn.text, sessionId: session.id });
  }

  const hits = evidenceTurnIds.map((turnId): EvidenceHit => {
    const turn = turnById.get(turnId);
    const exact = retrieved.find(
      (r) =>
        r.turnId === turnId ||
        r.turnIds?.includes(turnId) ||
        r.ref.includes(turnId) ||
        r.text.includes(turnId),
    );
    if (exact) {
      return {
        turnId,
        sessionId: turn?.sessionId,
        rank: exact.rank,
        ref: exact.ref,
        channel: exact.channel,
        method: "turn-id",
      };
    }

    if (turn?.text) {
      const terms = tokenizeForDebug(turn.text);
      const threshold = Math.min(8, Math.max(3, Math.ceil(terms.size * 0.25)));
      let best: { item: RetrievedDetail; overlap: number } | null = null;
      for (const item of retrieved) {
        const overlap = overlapScore(item.text, terms);
        if (!best || overlap > best.overlap) best = { item, overlap };
      }
      if (best && best.overlap >= threshold) {
        return {
          turnId,
          sessionId: turn.sessionId,
          rank: best.item.rank,
          ref: best.item.ref,
          channel: best.item.channel,
          method: "text-overlap",
          overlap: best.overlap,
          threshold,
        };
      }
      return {
        turnId,
        sessionId: turn.sessionId,
        method: "missing",
        overlap: best?.overlap ?? 0,
        threshold,
      };
    }

    return { turnId, method: "missing" };
  });

  const hitRanks = hits.flatMap((h) => (h.rank !== undefined ? [h.rank] : []));
  const missingTurnIds = hits.filter((h) => h.method === "missing").map((h) => h.turnId);
  return {
    total: hits.length,
    hit: hits.length - missingTurnIds.length,
    allHit: missingTurnIds.length === 0,
    missingTurnIds,
    ...(hitRanks.length > 0 ? { maxHitRank: Math.max(...hitRanks) } : {}),
    hits,
  };
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
  arm: RetrievalArm,
  sampled: SampledMemQuestion[],
  llm: LlmClient,
  k: number,
  concurrency: number,
  retrievalOnly: boolean,
  log: (m: string) => void,
): Promise<ArmRunResult> {
  const searcher = createMinimemSearch(arm);
  let done = 0;
  try {
    const results = await mapPool(sampled, concurrency, async ({ instance, question }) => {
      const docs = instanceToDocuments(instance);
      // Serialized build + retrieve, then free the embedding model immediately.
      const ranked = await searcher.search(question.question, docs, { maxResults: k });
      await searcher.evict(instance.id);

      const byId = new Map(docs.map((d) => [d.id, d]));
      const excerpts = ranked.slice(0, k).map((r) => byId.get(r.id)!).filter(Boolean);
      const retrieved: RetrievedDetail[] = ranked
        .slice(0, k)
        .flatMap((r, i) => {
          const doc = byId.get(r.id);
          if (!doc) return [];
          const detail: RetrievedDetail = {
            rank: r.rank ?? i + 1,
            ref: r.id,
            text: doc.text,
            channel: "raw",
            sourceRank: r.rank ?? i + 1,
            selectedBy: "raw-topk",
            docId: r.id,
            sessionId: doc.sessionId,
            turnId: doc.turnId,
            speaker: doc.speaker,
          };
          if (r.score !== undefined) detail.score = r.score;
          if (r.score !== undefined) detail.sourceScore = r.score;
          if (doc.date !== undefined) detail.date = doc.date;
          return [detail];
        });
      const evidenceCoverage = buildEvidenceCoverage(instance, question.evidenceTurnIds, retrieved);

      let answer = "";
      let judgedBy: QAJudgedBy = "error";
      let correct = false;
      let error: string | undefined;
      if (retrievalOnly) {
        answer = RETRIEVAL_ONLY_ANSWER;
        correct = evidenceCoverage.allHit;
        judgedBy = RETRIEVAL_ONLY_JUDGED_BY;
      } else {
        try {
          const promptExcerpts: LongMemEvalAnswerExcerpt[] = excerpts.map((e) => ({ text: e.text }));
          const { text } = await llm.chat([
            {
              role: "user",
              content: buildLongMemEvalAnswerPrompt(
                question.question,
                question.date,
                promptExcerpts,
                question.category,
              ),
            },
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
          error = err instanceof Error ? err.message : String(err);
          log(`  [${arm}] error on ${question.id}: ${error}`);
        }
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
        judgedBy: judgedBy as MemoryQARecord["judgedBy"],
      };
      const detail: QADetailRecord = {
        type: "record",
        arm,
        instanceId: instance.id,
        questionId: question.id,
        category: question.category,
        abstain: question.abstain,
        question: question.question,
        questionDate: question.date,
        gold: question.answer,
        answer,
        correct,
        judgedBy,
        evidenceTurnIds: question.evidenceTurnIds,
        evidenceSessionIds: question.evidenceSessionIds,
        evidenceCoverage,
        retrieved,
        ...(error ? { error } : {}),
      };
      return { record: rec, detail };
    });
    const records = results.map((r) => r.record);
    return { report: buildMemoryQAReport(arm, k, records), details: results.map((r) => r.detail) };
  } finally {
    await searcher.close();
  }
}

async function runCogcoreArm(
  arm: CogcoreLongMemEvalArm,
  sampled: SampledMemQuestion[],
  llm: LlmClient,
  k: number,
  concurrency: number,
  extractConcurrency: number,
  chunkTurns: number,
  maxFactsPerChunk: number,
  debugAll: boolean,
  experienceGranularity: ExperienceGranularity,
  experienceChunkTurns: number,
  experienceEmbedding: ExperienceEmbedding,
  experienceScope: ExperienceScope,
  experiencePoolSize: number,
  systemExperienceSlots: number,
  experienceMinScore: number | undefined,
  retrievalOnly: boolean,
  log: (m: string) => void,
): Promise<ArmRunResult> {
  let done = 0;
  const results = await mapPool(sampled, concurrency, async ({ instance, question }) => {
    const adapter = new CogcoreLongMemEvalAdapter(llm, arm, {
      topK: k,
      embeddings: "local",
      extractConcurrency,
      chunkTurns,
      maxFactsPerChunk,
      experienceGranularity,
      experienceChunkTurns,
      experienceEmbedding,
      experienceScope,
      experiencePoolSize,
      experienceSlots: systemExperienceSlots,
      ...(experienceMinScore !== undefined ? { experienceMinScore } : {}),
      onProgress: (m) => log(`  [${arm}] ${instance.id}: ${m}`),
    });
    let answer = "";
    let judgedBy: QAJudgedBy = "error";
    let correct = false;
    let retrieved: RetrievedDetail[] = [];
    let error: string | undefined;
    const totalStarted = Date.now();
    const timingMs: QATimingMs = { total: 0 };
    try {
      const ingestStarted = Date.now();
      await adapter.ingest(instance);
      timingMs.ingest = Date.now() - ingestStarted;
      if (retrievalOnly) {
        const retrieveStarted = Date.now();
        const excerpts = await adapter.retrieve(question);
        timingMs.retrieve = Date.now() - retrieveStarted;
        answer = RETRIEVAL_ONLY_ANSWER;
        retrieved = excerpts.map((e, i) => ({
          rank: i + 1,
          ref: e.ref,
          text: e.text,
          channel: e.channel,
          sourceRank: e.sourceRank,
          sourceScore: e.sourceScore,
          query: e.query,
          noteId: e.noteId,
          matchType: e.matchType,
          experienceId: e.experienceId,
          sessionId: e.sessionId,
          turnIds: e.turnIds,
          date: e.date,
          selectedBy: e.selectedBy,
        }));
      } else {
        const answerStarted = Date.now();
        const res = await adapter.answer(question);
        timingMs.answer = Date.now() - answerStarted;
        answer = res.answer;
        retrieved = res.retrieved.map((e, i) => ({
          rank: i + 1,
          ref: e.ref,
          text: e.text,
          channel: e.channel,
          sourceRank: e.sourceRank,
          sourceScore: e.sourceScore,
          query: e.query,
          noteId: e.noteId,
          matchType: e.matchType,
          experienceId: e.experienceId,
          sessionId: e.sessionId,
          turnIds: e.turnIds,
          date: e.date,
          selectedBy: e.selectedBy,
        }));
      }
      const closeStarted = Date.now();
      await adapter.close();
      timingMs.adapterClose = (timingMs.adapterClose ?? 0) + Date.now() - closeStarted;
      if (retrievalOnly) {
        correct = buildEvidenceCoverage(instance, question.evidenceTurnIds, retrieved).allHit;
        judgedBy = RETRIEVAL_ONLY_JUDGED_BY;
      } else if (question.abstain) {
        const judgeStarted = Date.now();
        correct = isMemoryQARefusal(answer);
        timingMs.judge = Date.now() - judgeStarted;
        judgedBy = "abstain-sentinel";
      } else {
        const judgeStarted = Date.now();
        correct = await judgeMemoryQACorrect(
          (p) => llm.complete(p),
          question.question,
          question.answer,
          answer,
        );
        timingMs.judge = Date.now() - judgeStarted;
        judgedBy = "mem0-judge";
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log(`  [${arm}] error on ${question.id}: ${error}`);
    } finally {
      const closeStarted = Date.now();
      await adapter.close();
      timingMs.adapterClose = (timingMs.adapterClose ?? 0) + Date.now() - closeStarted;
    }

    done++;
    log(`  [${arm}] ${done}/${sampled.length} ${question.id} ${correct ? "✓" : "✗"}`);
    const evidenceCoverage = buildEvidenceCoverage(instance, question.evidenceTurnIds, retrieved);
    const record: MemoryQARecord = {
      id: question.id,
      category: question.category,
      question: question.question,
      answer,
      gold: question.answer,
      correct,
      judgedBy: judgedBy as MemoryQARecord["judgedBy"],
    };
    const debugStarted = Date.now();
    const debug = await loadCogcoreDebugArtifacts(
      instance.id,
      question.question,
      question.answer,
      evidenceTextsForQuestion(instance, question.evidenceTurnIds),
      debugAll || !correct,
      arm === "cogcore-evolve" || arm === "cogcore-system-evolve",
    );
    timingMs.debug = Date.now() - debugStarted;
    timingMs.total = Date.now() - totalStarted;
    const detail: QADetailRecord = {
      type: "record",
      arm,
      instanceId: instance.id,
      questionId: question.id,
      category: question.category,
      abstain: question.abstain,
      question: question.question,
      questionDate: question.date,
      gold: question.answer,
      answer,
      correct,
      judgedBy,
      evidenceTurnIds: question.evidenceTurnIds,
      evidenceSessionIds: question.evidenceSessionIds,
      evidenceCoverage,
      retrieved,
      debug,
      timingMs,
      ...(error ? { error } : {}),
    };
    return { record, detail };
  });
  const records = results.map((r) => r.record);
  return { report: buildMemoryQAReport(arm, k, records), details: results.map((r) => r.detail) };
}

async function runCogcoreLiveArm(
  arm: CogcoreLiveLongMemEvalArm,
  sampled: SampledMemQuestion[],
  llm: LlmClient,
  k: number,
  concurrency: number,
  extractConcurrency: number,
  chunkTurns: number,
  maxFactsPerChunk: number,
  debugAll: boolean,
  experienceGranularity: ExperienceGranularity,
  experienceChunkTurns: number,
  experienceEmbedding: ExperienceEmbedding,
  experienceScope: ExperienceScope,
  experiencePoolSize: number,
  observationMemory: ObservationMemoryMode,
  observationSource: ObservationExtractionSource,
  observationContext: ObservationContextMode,
  observationLogMaxChars: number,
  observationMaxPerChunk: number,
  observationSlots: number,
  liveToolPolicy: LiveToolPolicy,
  liveToolQueries: number,
  liveToolResults: number,
  memoryProfile: MemoryProfile,
  recordRetries: number,
  retrievalOnly: boolean,
  log: (m: string) => void,
): Promise<ArmRunResult> {
  let done = 0;
  const results = await mapPool(sampled, concurrency, async ({ instance, question }) => {
    let answer = "";
    let judgedBy: QAJudgedBy = "error";
    let correct = false;
    let retrieved: RetrievedDetail[] = [];
    let liveTrace: LiveAnswerTrace | undefined;
    let error: string | undefined;
    const retryErrors: string[] = [];
    let attemptsRun = 0;
    const totalStarted = Date.now();
    const timingMs: QATimingMs = { total: 0 };

    for (let attempt = 0; attempt <= recordRetries; attempt++) {
      attemptsRun = attempt + 1;
      answer = "";
      judgedBy = "error";
      correct = false;
      retrieved = [];
      liveTrace = undefined;
      error = undefined;
      const adapter = new CogcoreLiveLongMemEvalAdapter(llm, arm, {
        topK: k,
        embeddings: "local",
        extractConcurrency,
        chunkTurns,
        maxFactsPerChunk,
        experienceGranularity,
        experienceChunkTurns,
        experienceEmbedding,
        experienceScope,
        experiencePoolSize,
        observationMemory,
        observationSource,
        observationContext,
        observationLogMaxChars,
        observationMaxPerChunk,
        observationSlots,
        liveToolPolicy,
        liveToolQueries,
        liveToolResults,
        memoryProfile,
        onProgress: (m) => log(`  [${arm}] ${instance.id}: ${m}`),
      });

      try {
        const ingestStarted = Date.now();
        await adapter.ingest(instance);
        timingMs.ingest = (timingMs.ingest ?? 0) + Date.now() - ingestStarted;
        if (retrievalOnly) {
          const retrieveStarted = Date.now();
          const excerpts = await adapter.retrieve(question);
          timingMs.retrieve = (timingMs.retrieve ?? 0) + Date.now() - retrieveStarted;
          answer = RETRIEVAL_ONLY_ANSWER;
          retrieved = excerpts.map((e, i) => ({
            rank: i + 1,
            ref: e.ref,
            text: e.text,
            channel: e.channel,
            sourceRank: e.sourceRank,
            sourceScore: e.sourceScore,
            query: e.query,
            noteId: e.noteId,
            matchType: e.matchType,
            experienceId: e.experienceId,
            sessionId: e.sessionId,
            turnIds: e.turnIds,
            date: e.date,
            selectedBy: e.selectedBy,
          }));
        } else {
          const answerStarted = Date.now();
          const res = await adapter.answer(question);
          timingMs.answer = (timingMs.answer ?? 0) + Date.now() - answerStarted;
          answer = res.answer;
          liveTrace = res.liveTrace;
          retrieved = res.retrieved.map((e, i) => ({
            rank: i + 1,
            ref: e.ref,
            text: e.text,
            channel: e.channel,
            sourceRank: e.sourceRank,
            sourceScore: e.sourceScore,
            query: e.query,
            noteId: e.noteId,
            matchType: e.matchType,
            experienceId: e.experienceId,
            sessionId: e.sessionId,
            turnIds: e.turnIds,
            date: e.date,
            selectedBy: e.selectedBy,
          }));
        }
        if (retrievalOnly) {
          correct = buildEvidenceCoverage(instance, question.evidenceTurnIds, retrieved).allHit;
          judgedBy = RETRIEVAL_ONLY_JUDGED_BY;
        } else if (question.abstain) {
          const judgeStarted = Date.now();
          correct = isMemoryQARefusal(answer);
          timingMs.judge = (timingMs.judge ?? 0) + Date.now() - judgeStarted;
          judgedBy = "abstain-sentinel";
        } else {
          const judgeStarted = Date.now();
          correct = await judgeMemoryQACorrect(
            (p) => llm.complete(p),
            question.question,
            question.answer,
            answer,
          );
          timingMs.judge = (timingMs.judge ?? 0) + Date.now() - judgeStarted;
          judgedBy = "mem0-judge";
        }
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        const closeStarted = Date.now();
        try {
          await adapter.close();
        } catch (closeErr) {
          const closeError = closeErr instanceof Error ? closeErr.message : String(closeErr);
          error = error ? `${error}; adapter close failed: ${closeError}` : `adapter close failed: ${closeError}`;
        }
        timingMs.adapterClose = (timingMs.adapterClose ?? 0) + Date.now() - closeStarted;
      }

      if (!error) break;

      retryErrors.push(error);
      const canRetry = attempt < recordRetries && isRetryableEvalError(error);
      log(
        `  [${arm}] error on ${question.id} attempt ${attempt + 1}/${recordRetries + 1}: ${error}` +
          (canRetry ? " (retryable)" : ""),
      );
      if (!canRetry) break;

      const delayMs = retryDelayMs(attempt, error);
      log(`  [${arm}] retrying ${question.id} in ${(delayMs / 1000).toFixed(0)}s`);
      await sleep(delayMs);
    }

    done++;
    log(`  [${arm}] ${done}/${sampled.length} ${question.id} ${correct ? "✓" : "✗"}`);
    const evidenceCoverage = buildEvidenceCoverage(instance, question.evidenceTurnIds, retrieved);
    const record: MemoryQARecord = {
      id: question.id,
      category: question.category,
      question: question.question,
      answer,
      gold: question.answer,
      correct,
      judgedBy: judgedBy as MemoryQARecord["judgedBy"],
    };
    const debugStarted = Date.now();
    const debug = await loadCogcoreDebugArtifacts(
      instance.id,
      question.question,
      question.answer,
      evidenceTextsForQuestion(instance, question.evidenceTurnIds),
      debugAll || !correct,
      false,
    );
    timingMs.debug = Date.now() - debugStarted;
    timingMs.total = Date.now() - totalStarted;
    const detail: QADetailRecord = {
      type: "record",
      arm,
      instanceId: instance.id,
      questionId: question.id,
      category: question.category,
      abstain: question.abstain,
      question: question.question,
      questionDate: question.date,
      gold: question.answer,
      answer,
      correct,
      judgedBy,
      evidenceTurnIds: question.evidenceTurnIds,
      evidenceSessionIds: question.evidenceSessionIds,
      evidenceCoverage,
      retrieved,
      debug,
      timingMs,
      ...(liveTrace ? { liveTrace } : {}),
      ...(attemptsRun > 1 ? { retryAttempts: attemptsRun - 1 } : {}),
      ...(retryErrors.length > 0 ? { retryErrors } : {}),
      ...(error ? { error } : {}),
    };
    return { record, detail };
  });
  const records = results.map((r) => r.record);
  return { report: buildMemoryQAReport(arm, k, records), details: results.map((r) => r.detail) };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

function takeRoundRobinByCategory(sampled: SampledMemQuestion[], n: number): SampledMemQuestion[] {
  const byCategory = new Map<string, SampledMemQuestion[]>();
  for (const item of sampled) {
    const key = item.question.category;
    let bucket = byCategory.get(key);
    if (!bucket) {
      bucket = [];
      byCategory.set(key, bucket);
    }
    bucket.push(item);
  }

  const categories = [...byCategory.keys()];
  const out: SampledMemQuestion[] = [];
  while (out.length < n) {
    let advanced = false;
    for (const category of categories) {
      const item = byCategory.get(category)?.shift();
      if (!item) continue;
      out.push(item);
      advanced = true;
      if (out.length >= n) break;
    }
    if (!advanced) break;
  }
  return out;
}

function categoryCounts(sampled: SampledMemQuestion[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of sampled) out[item.question.category] = (out[item.question.category] ?? 0) + 1;
  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const arms = parseArms(args.arms);
  const k = args.k ? Number(args.k) : 10;
  const perCategory = args["per-category"] ? Number(args["per-category"]) : 10;
  const sample = args.sample ? Number(args.sample) : undefined;
  const targetCategories = parseCategories(args.categories);
  const explicitQuestionIdsFilter = parseCategories(args["question-ids"]);
  const retryErrorsFromArg = args["retry-errors-from"];
  if (retryErrorsFromArg === true) throw new Error("--retry-errors-from requires a detail JSONL path");
  const retryErrorsFrom = retryErrorsFromArg ? String(retryErrorsFromArg) : undefined;
  const categoryOffset = args["category-offset"] ? Number(args["category-offset"]) : undefined;
  const includeAbstain = args["no-abstain"] ? false : true;
  const concurrency = args.concurrency ? Number(args.concurrency) : 4;
  const cogcoreConcurrency = args["cogcore-concurrency"] ? Number(args["cogcore-concurrency"]) : 1;
  const extractConcurrency = args["extract-concurrency"] ? Number(args["extract-concurrency"]) : 2;
  const chunkTurns = args["chunk-turns"] ? Number(args["chunk-turns"]) : 40;
  const maxFactsPerChunk = args["max-facts-per-chunk"] ? Number(args["max-facts-per-chunk"]) : 60;
  const debugAll = Boolean(args["debug-all"]);
  const retrievalOnly = Boolean(args["retrieval-only"]);
  const memoryProfile = parseMemoryProfile(
    args["memory-profile"],
    arms.some((a) => isCogcoreLiveArm(a)) ? "long-memory" : "standard",
  );
  const memoryProfileDefaults = defaultsForMemoryProfile(memoryProfile);
  const experienceGranularity = parseExperienceGranularity(
    args["experience-granularity"],
    memoryProfileDefaults.experienceGranularity,
  );
  const experienceChunkTurns = args["experience-chunk-turns"] ? Number(args["experience-chunk-turns"]) : 8;
  const experienceEmbedding = parseExperienceEmbedding(
    args["experience-embedding"],
    memoryProfileDefaults.experienceEmbedding,
  );
  const experienceScope = parseExperienceScope(args["experience-scope"], memoryProfileDefaults.experienceScope);
  const experiencePoolSize = args["experience-pool-size"]
    ? Number(args["experience-pool-size"])
    : memoryProfileDefaults.experiencePoolSize;
  const experienceMinScore = args["experience-min-score"] ? Number(args["experience-min-score"]) : undefined;
  const observationMemory = parseObservationMemory(
    args["observation-memory"],
    memoryProfileDefaults.observationMemory,
  );
  const observationSource = parseObservationSource(
    args["observation-source"],
    memoryProfileDefaults.observationSource,
  );
  const observationContext = parseObservationContext(
    args["observation-context"],
    memoryProfileDefaults.observationContext,
  );
  const observationLogMaxChars = args["observation-log-max-chars"]
    ? Number(args["observation-log-max-chars"])
    : memoryProfileDefaults.observationLogMaxChars;
  const observationMaxPerChunk = args["observation-max-per-chunk"]
    ? Number(args["observation-max-per-chunk"])
    : memoryProfileDefaults.observationMaxPerChunk;
  const observationSlots = args["observation-slots"]
    ? Number(args["observation-slots"])
    : memoryProfileDefaults.observationSlots;
  const liveToolPolicy = parseLiveToolPolicy(args["live-tool-policy"], memoryProfileDefaults.liveToolPolicy);
  const liveToolQueries = args["live-tool-queries"]
    ? Number(args["live-tool-queries"])
    : memoryProfileDefaults.liveToolQueries;
  const liveToolResults = args["live-tool-results"]
    ? Number(args["live-tool-results"])
    : memoryProfileDefaults.liveToolResults(k);
  const recordRetries = args["record-retries"] ? Number(args["record-retries"]) : 1;
  if (!Number.isInteger(recordRetries) || recordRetries < 0) {
    throw new Error(`Invalid --record-retries '${String(args["record-retries"])}'. Use a non-negative integer.`);
  }
  if (!Number.isInteger(observationMaxPerChunk) || observationMaxPerChunk < 1) {
    throw new Error(
      `Invalid --observation-max-per-chunk '${String(args["observation-max-per-chunk"])}'. Use a positive integer.`,
    );
  }
  if (!Number.isInteger(observationSlots) || observationSlots < 0) {
    throw new Error(`Invalid --observation-slots '${String(args["observation-slots"])}'. Use a non-negative integer.`);
  }
  if (!Number.isInteger(observationLogMaxChars) || observationLogMaxChars < 0) {
    throw new Error(
      `Invalid --observation-log-max-chars '${String(args["observation-log-max-chars"])}'. Use a non-negative integer.`,
    );
  }
  if (!Number.isInteger(liveToolQueries) || liveToolQueries < 0) {
    throw new Error(`Invalid --live-tool-queries '${String(args["live-tool-queries"])}'. Use a non-negative integer.`);
  }
  const hasCogcoreArm = arms.some((a) => isCogcoreArm(a) || isCogcoreLiveArm(a));
  const hasCogcoreSystemArm = arms.some((a) => String(a).startsWith("cogcore-system") || isCogcoreLiveArm(a));
  const systemExperienceSlots = args["experience-slots"]
    ? Number(args["experience-slots"])
    : defaultSystemExperienceSlots(k);
  const maxCompletionTokens = args["max-completion-tokens"]
    ? Number(args["max-completion-tokens"])
    : hasCogcoreArm
      ? 8192
      : 2048;

  const log = (m: string) => process.stderr.write(`[lme-qa] ${m}\n`);

  const all = loadLongMemEvalCached();
  const allCategories = new Set(all.flatMap((inst) => inst.questions.map((q) => q.category)));
  const unknownCategories = targetCategories.filter((category) => !allCategories.has(category));
  if (unknownCategories.length > 0) {
    throw new Error(
      `Unknown --categories value(s): ${unknownCategories.join(", ")}. Available: ${[...allCategories].sort().join(", ")}`,
    );
  }
  const source =
    targetCategories.length > 0
      ? all.filter((inst) => inst.questions.some((q) => targetCategories.includes(q.category)))
      : all;
  const retryErrorQuestionIds = retryErrorsFrom ? await loadErroredQuestionIdsFromDetails(retryErrorsFrom) : [];
  if (retryErrorsFrom) {
    if (retryErrorQuestionIds.length === 0) throw new Error(`No errored records found in ${retryErrorsFrom}`);
    log(`loaded ${retryErrorQuestionIds.length} errored question ids from ${retryErrorsFrom}`);
  }
  const questionIdsFilter =
    explicitQuestionIdsFilter.length > 0 ? explicitQuestionIdsFilter : retryErrorQuestionIds;
  let sampled =
    questionIdsFilter.length > 0
      ? sampleByQuestionIds(source, questionIdsFilter)
      : sampleMemoryQAStratified(source, perCategory, {
          includeAbstain,
          ...(categoryOffset !== undefined ? { categoryOffset } : {}),
        });
  if (sample !== undefined && questionIdsFilter.length === 0) sampled = takeRoundRobinByCategory(sampled, sample);
  const abstainN = sampled.filter((s) => s.question.abstain).length;
  log(
    `loaded ${all.length} instances${source.length !== all.length ? ` (${source.length} targeted)` : ""} → ${sampled.length} questions ` +
      `(perCategory=${perCategory}, sample=${sample ?? "off"}, abstain=${abstainN}, ` +
      `categories=${targetCategories.length > 0 ? targetCategories.join(",") : "all"}, ` +
      `questionIds=${questionIdsFilter.length > 0 ? questionIdsFilter.length : "off"}, ` +
      `categoryOffset=${categoryOffset ?? "stride"}, ` +
      `arms=${arms.join(",")}, k=${k}, conc=${concurrency}, cogConc=${cogcoreConcurrency}, ` +
      `extractConc=${extractConcurrency}, chunkTurns=${chunkTurns}, maxFactsPerChunk=${maxFactsPerChunk}, ` +
      `memoryProfile=${memoryProfile}, retrievalOnly=${retrievalOnly}, debugAll=${debugAll}, ` +
      `maxCompletionTokens=${maxCompletionTokens}, recordRetries=${recordRetries}${
        hasCogcoreSystemArm
          ? `, systemExperienceSlots=${systemExperienceSlots}, experienceGranularity=${experienceGranularity}, ` +
            `experienceChunkTurns=${experienceChunkTurns}, experienceEmbedding=${experienceEmbedding}, ` +
            `experienceScope=${experienceScope}, experiencePoolSize=${experiencePoolSize}, ` +
            `experienceMinScore=${experienceMinScore ?? "off"}, observationMemory=${observationMemory}, ` +
            `observationSource=${observationSource}, observationContext=${observationContext}, ` +
            `observationLogMaxChars=${observationLogMaxChars}, observationMaxPerChunk=${observationMaxPerChunk}, ` +
            `observationSlots=${observationSlots}, ` +
            `liveToolPolicy=${liveToolPolicy}, liveToolQueries=${liveToolQueries}, ` +
            `liveToolResults=${liveToolResults}`
          : ""
      })`,
  );

  const llm = new LlmClient({ maxCompletionTokens });

  const reports = new Map<Arm, MemoryQAReport>();
  const detailRecords: DetailJsonlRecord[] = [
    {
      type: "run",
      createdAt: new Date().toISOString(),
      promptVersion: LME_ANSWER_PROMPT_VERSION,
      dataset: "LongMemEval_S",
      args: {
        arms,
        k,
        perCategory,
        ...(sample !== undefined ? { sample } : {}),
        ...(targetCategories.length > 0 ? { targetCategories } : {}),
        ...(questionIdsFilter.length > 0 ? { questionIdsFilter } : {}),
        ...(retryErrorsFrom ? { retryErrorsFrom, retryErrorQuestionIds } : {}),
        ...(categoryOffset !== undefined ? { categoryOffset } : {}),
        includeAbstain,
        abstainN,
        concurrency,
        cogcoreConcurrency,
        extractConcurrency,
        chunkTurns,
        maxFactsPerChunk,
        extractionCacheVersion: COGCORE_EXTRACTION_CACHE_VERSION,
        observationCacheVersion: COGCORE_OBSERVATION_CACHE_VERSION,
        memoryProfile,
        ...(hasCogcoreSystemArm
          ? {
              systemExperienceSlots,
              experienceGranularity,
              experienceChunkTurns,
              experienceEmbedding,
              experienceScope,
              experiencePoolSize,
              observationMemory,
              observationSource,
              observationContext,
              observationLogMaxChars,
              observationMaxPerChunk,
              observationSlots,
              ...(experienceMinScore !== undefined ? { experienceMinScore } : {}),
              ...(arms.some((a) => isCogcoreLiveArm(a)) ? { liveToolPolicy, liveToolQueries, liveToolResults } : {}),
            }
          : {}),
        maxCompletionTokens,
        recordRetries,
        retrievalOnly,
        debugAll,
      },
      questionIds: sampled.map((s) => s.question.id),
      categories: categoryCounts(sampled),
      command: process.argv,
    },
  ];

  const sections: string[] = [
    `# LongMemEval ${retrievalOnly ? "Retrieval Coverage" : "QA"} (n=${sampled.length}, k=${k})\n`,
  ];
  if (retrievalOnly) {
    sections.push(
      "Retrieval-only mode: answers and judges are skipped; `accuracy` means all gold evidence turn ids were covered by the retrieved context.\n",
    );
  }
  sections.push("## run config\n");
  sections.push(
    "```json\n" +
      JSON.stringify(
        {
          promptVersion: LME_ANSWER_PROMPT_VERSION,
          arms,
          k,
          perCategory,
          sample: sample ?? null,
          targetCategories: targetCategories.length > 0 ? targetCategories : null,
          questionIdsFilter: questionIdsFilter.length > 0 ? questionIdsFilter : null,
          retryErrorsFrom: retryErrorsFrom ?? null,
          retryErrorQuestionIds: retryErrorQuestionIds.length > 0 ? retryErrorQuestionIds : null,
          categoryOffset: categoryOffset ?? null,
          includeAbstain,
          abstainN,
          concurrency,
          cogcoreConcurrency,
          extractConcurrency,
          chunkTurns,
          maxFactsPerChunk,
          extractionCacheVersion: COGCORE_EXTRACTION_CACHE_VERSION,
          observationCacheVersion: COGCORE_OBSERVATION_CACHE_VERSION,
          memoryProfile,
          ...(hasCogcoreSystemArm
            ? {
                systemExperienceSlots,
                experienceGranularity,
                experienceChunkTurns,
                experienceEmbedding,
                experienceScope,
                experiencePoolSize,
                observationMemory,
                observationSource,
                observationContext,
                observationLogMaxChars,
                observationMaxPerChunk,
                observationSlots,
                ...(experienceMinScore !== undefined ? { experienceMinScore } : {}),
                ...(arms.some((a) => isCogcoreLiveArm(a)) ? { liveToolPolicy, liveToolQueries, liveToolResults } : {}),
              }
            : {}),
          maxCompletionTokens,
          recordRetries,
          retrievalOnly,
          debugAll,
          questionIds: sampled.map((s) => s.question.id),
          categories: categoryCounts(sampled),
        },
        null,
        2,
      ) +
      "\n```\n",
  );

  for (const arm of arms) {
    const started = Date.now();
    const before = { ...llm.totals };
    const run = isRetrievalArm(arm)
      ? await runArm(arm, sampled, llm, k, concurrency, retrievalOnly, log)
      : isCogcoreArm(arm)
        ? await runCogcoreArm(
            arm,
            sampled,
            llm,
            k,
            Math.min(concurrency, cogcoreConcurrency),
            extractConcurrency,
            chunkTurns,
            maxFactsPerChunk,
            debugAll,
            experienceGranularity,
            experienceChunkTurns,
            experienceEmbedding,
            experienceScope,
            experiencePoolSize,
            systemExperienceSlots,
            experienceMinScore,
            retrievalOnly,
            log,
          )
        : isCogcoreLiveArm(arm)
          ? await runCogcoreLiveArm(
              arm,
              sampled,
              llm,
              k,
              Math.min(concurrency, cogcoreConcurrency),
              extractConcurrency,
              chunkTurns,
              maxFactsPerChunk,
              debugAll,
              experienceGranularity,
              experienceChunkTurns,
              experienceEmbedding,
              experienceScope,
              experiencePoolSize,
              observationMemory,
              observationSource,
              observationContext,
              observationLogMaxChars,
              observationMaxPerChunk,
              observationSlots,
              liveToolPolicy,
              liveToolQueries,
              liveToolResults,
              memoryProfile,
              recordRetries,
              retrievalOnly,
              log,
            )
        : (() => {
            throw new Error(`Unhandled arm: ${arm}`);
          })();
    const report = run.report;
    reports.set(arm, report);
    detailRecords.push(...run.details);
    const tokens = llm.totals.totalTokens - before.totalTokens;
    const calls = llm.totals.calls - before.calls;
    const wallMs = Date.now() - started;
    detailRecords.push({
      type: "arm-summary",
      arm,
      accuracy: report.overall.accuracy,
      n: report.overall.n,
      calls,
      tokens,
      wallMs,
    });
    log(
      `  [${arm}] overall ${pct(report.overall.accuracy)} ` +
        `(${(wallMs / 1000).toFixed(0)}s, ${calls} llm calls, ${tokens} tokens)`,
    );

    sections.push(`## arm: ${arm}\n`);
    sections.push("```\n" + formatMemoryQA(report) + "\n```\n");
    // Abstention questions are folded into their question_type category; report
    // their refusal accuracy explicitly.
    const absRecords = retrievalOnly
      ? []
      : report.records.filter((r) => sampled.find((s) => s.question.id === r.id)?.question.abstain);
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

  if (args["details-out"]) {
    await fs.writeFile(
      String(args["details-out"]),
      `${detailRecords.map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    log(`wrote ${String(args["details-out"])}`);
  }
}

main().catch((err) => {
  process.stderr.write(`[lme-qa] error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
