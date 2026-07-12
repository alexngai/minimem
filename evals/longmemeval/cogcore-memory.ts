/**
 * cognitive-core adapter for LongMemEval.
 *
 * This mirrors the LOCOMO cogcore-memory ladder, but consumes swarmkit-eval's
 * normalized MemQAInstance directly:
 *   - cogcore-memory: extracted facts + cognitive-core defrag/indexing
 *   - cogcore-hybrid: extracted facts + raw turns as a verbatim detail floor
 *   - cogcore-hybrid-mq: hybrid plus multi-query retrieval
 *   - cogcore-evolve: hybrid plus cognitive-core LLM memory evolution
 *   - cogcore-system: hybrid plus cognitive-core ExperienceMemory sessions
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  createAtlas,
  KnowledgeBankConfigSchema,
  createTask,
  createExperience,
  createMemorySystem,
  createObservation,
  createSqlitePersistence,
  type Atlas,
  type AtlasConfig,
  type MemoryQueryResultV2,
  type MemorySystem,
  type SqlitePersistence,
  type KnowledgeMatch,
} from "cognitive-core";
import { HashEmbeddingProvider } from "cognitive-core/embeddings";
import { createLlmMemoryEvolver, type MemoryEvolutionPlan } from "cognitive-core/memory";
import type { MemQAInstance, MemQuestion } from "swarmkit-eval";

import { MemoryToolExecutor, type ToolResult } from "../../src/index.js";
import {
  closeBank,
  defaultScratchRoot,
  indexAndInject,
  openBank,
  type CogcoreState,
  type Embeddings,
  type MmrConfig,
} from "../locomo/adapters/cogcore-shared.js";
import { LlmClient, type LlmUsage } from "../locomo/llm.js";
import { buildLongMemEvalAnswerPrompt } from "./prompt.js";

export type CogcoreLongMemEvalArm =
  | "cogcore-memory"
  | "cogcore-hybrid"
  | "cogcore-hybrid-mq"
  | "cogcore-evolve"
  | "cogcore-system"
  | "cogcore-system-evolve";
export type CogcoreLiveLongMemEvalArm = "cogcore-live";

export type ExperienceGranularity = "session" | "chunk" | "turn";
export type ExperienceEmbedding = "none" | "hash";
export type ExperienceScope = "knowledge-sessions" | "all";
export type ObservationMemoryMode = "off" | "kb";
export type ObservationExtractionSource = "chunks" | "combined";
export type ObservationContextMode = "retrieved" | "log" | "both";
export type LiveToolPolicy = "auto" | "always" | "off";

export interface CogcoreLongMemEvalOptions {
  topK?: number;
  scratchRoot?: string;
  embeddings?: Embeddings;
  extractConcurrency?: number;
  cache?: boolean;
  cacheDir?: string;
  keywordExpansion?: boolean;
  mmr?: MmrConfig;
  hybridRawTurns?: boolean;
  multiQuery?: boolean;
  evolve?: boolean;
  systemMemory?: boolean;
  /** Number of final context slots reserved for ExperienceMemory in system arms. */
  experienceSlots?: number;
  /** Minimum ExperienceMemory score required for final context inclusion. */
  experienceMinScore?: number;
  /** Unit stored into ExperienceMemory. */
  experienceGranularity?: ExperienceGranularity;
  /** Number of turns per ExperienceMemory chunk when granularity=chunk. */
  experienceChunkTurns?: number;
  /** Optional embedder for ExperienceMemory retrieval only. */
  experienceEmbedding?: ExperienceEmbedding;
  /** Candidate scope for ExperienceMemory retrieval. */
  experienceScope?: ExperienceScope;
  /** Number of ExperienceMemory candidates to score before scope/slot selection. */
  experiencePoolSize?: number;
  /** Number of dated turns per extraction call. */
  chunkTurns?: number;
  /** Upper bound on extracted facts kept from each chunk. */
  maxFactsPerChunk?: number;
  /** Maximum agent-facing minimem tool searches in the live delegate. */
  liveToolQueries?: number;
  /** Policy for whether live-agent minimem tools should run for a question. */
  liveToolPolicy?: LiveToolPolicy;
  /** Maximum minimem results per live tool search. */
  liveToolResults?: number;
  /** Write Mastra-like distilled observations into KnowledgeBank during ingestion. */
  observationMemory?: ObservationMemoryMode;
  /** Cache directory for LLM-generated observation memory. */
  observationCacheDir?: string;
  /** Extraction path used to produce observation memory. */
  observationSource?: ObservationExtractionSource;
  /** Agent-facing observation channel. */
  observationContext?: ObservationContextMode;
  /** Maximum characters of chronological observation log to inject. */
  observationLogMaxChars?: number;
  /** Upper bound on observation records extracted from each transcript chunk. */
  observationMaxPerChunk?: number;
  /** Maximum observation notes allowed to preempt normal scoped KnowledgeBank notes. */
  observationSlots?: number;
  /** Optional progress hook for long extraction/indexing steps. */
  onProgress?: (message: string) => void;
}

interface ExtractedFact {
  fact: string;
  entities: string[];
}

interface ExtractionCache {
  version: number;
  instanceId: string;
  chunkTurns: number;
  maxFactsPerChunk: number;
  facts: ExtractedFact[];
}

interface EvolutionCache {
  version: number;
  instanceId: string;
  chunkTurns: number;
  maxFactsPerChunk: number;
  plan: MemoryEvolutionPlan;
}

type ObservationKind =
  | "event"
  | "preference"
  | "state_update"
  | "plan"
  | "commitment"
  | "relationship"
  | "assistant_answer"
  | "inventory"
  | "temporal"
  | "other";

type ObservationStatus = "current" | "historical" | "planned" | "completed" | "cancelled" | "superseded" | "unknown";

interface ExtractedObservation {
  statement: string;
  type: ObservationKind;
  date?: string;
  status: ObservationStatus;
  entities: string[];
  turnIds: string[];
}

interface ObservationCache {
  version: number;
  instanceId: string;
  chunkTurns: number;
  maxObservationsPerChunk: number;
  source?: ObservationExtractionSource;
  observations: ExtractedObservation[];
}

interface CombinedExtraction {
  facts: ExtractedFact[];
  observations: ExtractedObservation[];
}

export interface RetrievedExcerpt {
  ref: string;
  text: string;
  channel?: "knowledge" | "experience" | "tool";
  query?: string;
  sourceRank?: number;
  sourceScore?: number;
  noteId?: string;
  matchType?: string;
  experienceId?: string;
  sessionId?: string;
  turnIds?: string[];
  date?: string;
  selectedBy?: string;
}

export interface LiveToolTrace {
  tool: "memory_search" | "knowledge_search";
  query: string;
  output: string;
  error?: string;
}

export interface LiveAnswerTrace {
  systemContextChars: number;
  formattedKnowledgeChars: number;
  injectedExperienceCount: number;
  injectedPlaybookCount: number;
  queryV2KnowledgeCount: number;
  scopedSystemKnowledgeCount: number;
  surfacedKnowledgeCount: number;
  observationKnowledgeCount?: number;
  observationContext?: ObservationContextMode;
  observationLogContextChars?: number;
  liveToolPolicy?: LiveToolPolicy;
  effectiveLiveToolQueries?: number;
  toolCalls: LiveToolTrace[];
}

export interface AnswerResult {
  answer: string;
  usage: LlmUsage;
  retrieved: RetrievedExcerpt[];
  liveTrace?: LiveAnswerTrace;
}

interface UsageAccumulator {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
}

interface DatedTurn {
  id: string;
  sessionId: string;
  speaker: string;
  text: string;
  date?: string;
}

interface KnowMatch {
  note: { body?: string; frontmatter: { id: string } };
  matchType?: string;
  score?: number;
}

interface AgentDelegateOptions {
  cwd: string;
  systemContext?: string;
  injectedKnowledge?: MemoryQueryResultV2;
  timeoutMs?: number;
}

interface AgentDelegate {
  execute(prompt: string, options: AgentDelegateOptions): Promise<{ success: boolean; output: string; structured?: unknown }>;
}

export const COGCORE_EXTRACTION_CACHE_VERSION = 3;
export const COGCORE_OBSERVATION_CACHE_VERSION = 1;
const DEFAULT_CHUNK_TURNS = 40;
const DEFAULT_MAX_FACTS_PER_CHUNK = 60;
const DEFAULT_EXPERIENCE_CHUNK_TURNS = 8;
const DEFAULT_OBSERVATION_SOURCE: ObservationExtractionSource = "chunks";
const DEFAULT_OBSERVATION_CONTEXT: ObservationContextMode = "retrieved";
const DEFAULT_OBSERVATION_LOG_MAX_CHARS = 80_000;
const DEFAULT_OBSERVATION_MAX_PER_CHUNK = 12;
const DEFAULT_OBSERVATION_SLOTS = 12;
const COMBINED_EMPTY_RETRIES = 1;
const MAX_EXCERPT_CHARS = 1200;
const MAX_KNOWLEDGE_TOKENS = 1_000_000;
const MAX_SCOPED_SYSTEM_KNOWLEDGE_NOTES = 32;
const OBSERVATION_TYPES = new Set<ObservationKind>([
  "event",
  "preference",
  "state_update",
  "plan",
  "commitment",
  "relationship",
  "assistant_answer",
  "inventory",
  "temporal",
  "other",
]);
const OBSERVATION_STATUSES = new Set<ObservationStatus>([
  "current",
  "historical",
  "planned",
  "completed",
  "cancelled",
  "superseded",
  "unknown",
]);

export function defaultSystemExperienceSlots(topK: number): number {
  return Math.min(4, Math.max(1, Math.floor(topK / 4)));
}

function addUsage(a: UsageAccumulator, u: LlmUsage): void {
  a.promptTokens += u.promptTokens;
  a.completionTokens += u.completionTokens;
  a.totalTokens += u.totalTokens;
  a.latencyMs += u.latencyMs;
}

function safeFileName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

function excerptForQuery(body: string, question: string): string {
  if (body.length <= MAX_EXCERPT_CHARS) return body;
  const sections = body.split(/\n(?=##\s)/);
  if (sections.length <= 1) return excerptLinesForQuery(body, question);

  const header = /^##\s/.test(sections[0] ?? "") ? "" : sections.shift() ?? "";
  const qTokens = tokenize(question);
  const scored = sections.map((s) => {
    let overlap = 0;
    for (const t of tokenize(s)) if (qTokens.has(t)) overlap++;
    return { s, overlap };
  });
  scored.sort((a, b) => b.overlap - a.overlap);

  let out = header ? `${header.trim()}\n` : "";
  for (const { s } of scored) {
    if (out.length + s.length + 1 > MAX_EXCERPT_CHARS) continue;
    out += `${s.trim()}\n`;
  }
  return out.trim();
}

function excerptLinesForQuery(body: string, question: string): string {
  const lines = body.split(/\n+/).map((line, index) => ({ line: line.trim(), index })).filter((x) => x.line);
  if (lines.length <= 1) return `${body.slice(0, MAX_EXCERPT_CHARS)}...`;
  const qTokens = tokenize(question);
  const scored = lines.map((x) => {
    let overlap = 0;
    for (const t of tokenize(x.line)) if (qTokens.has(t)) overlap++;
    return { ...x, overlap };
  });
  const picked = scored
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    .filter((x) => x.overlap > 0)
    .slice(0, 20)
    .sort((a, b) => a.index - b.index);

  let out = "";
  for (const { line } of picked.length > 0 ? picked : scored.slice(0, 20)) {
    if (out.length + line.length + 1 > MAX_EXCERPT_CHARS) continue;
    out += `${line}\n`;
  }
  return out.trim() || `${body.slice(0, MAX_EXCERPT_CHARS)}...`;
}

function buildExtractionPrompt(instance: MemQAInstance, turns: DatedTurn[], maxFacts: number): string {
  const transcript = turns
    .map((t) => `[${t.sessionId}${t.date ? ` @ ${t.date}` : ""}] ${t.speaker}: ${t.text}`)
    .join("\n");
  return [
    "You are building long-term memory for an AI assistant from past user/assistant chat sessions.",
    "Extract durable, answer-bearing information from the transcript below as a JSON array of atomic memories.",
    "",
    'Each item must be: {"fact":"<one self-contained fact; include speaker role and date/time when relevant>", "entities":["<proper nouns: people, pets, places, orgs, named things>"]}',
    "",
    "Rules:",
    "- Capture USER facts, preferences, plans, state changes, relationships, dates, quantities, and outcomes.",
    "- Capture ASSISTANT-provided answers, recommendations, explanations, decisions, and commitments when they may be asked about later.",
    "- Preserve exact names, numbers, list members, descriptive modifiers, and emotionally loaded phrasing.",
    "- Preserve the original temporal phrasing, and include the session date when useful.",
    "- If a fact supersedes an earlier state, make the replacement explicit.",
    "- Split enumerations into separate facts so each item is independently retrievable.",
    `- Return at most ${maxFacts} facts for this chunk; prefer the most durable, specific, answer-bearing facts.`,
    "- Skip greetings and filler with no lasting information.",
    "- Return ONLY the JSON array, no prose.",
    "",
    `Instance: ${instance.id}`,
    "Transcript:",
    transcript,
  ].join("\n");
}

function buildObservationPrompt(instance: MemQAInstance, turns: DatedTurn[], maxObservations: number): string {
  const transcript = turns
    .map((t) => `[${t.sessionId}${t.date ? ` @ ${t.date}` : ""} turn ${t.id}] ${t.speaker}: ${t.text}`)
    .join("\n");
  return [
    "You are writing an observation log for an AI assistant's long-term memory.",
    "Distill the transcript below into compact chronological observations that will be injected directly into a future agent's context.",
    "",
    "Return a JSON array. Each item must be:",
    '{"statement":"<one self-contained observation; include exact names, numbers, dates, and role when relevant>", "type":"event|preference|state_update|plan|commitment|relationship|assistant_answer|inventory|temporal|other", "date":"<best YYYY/MM/DD or source date string, if known>", "status":"current|historical|planned|completed|cancelled|superseded|unknown", "entities":["<important people, places, items, orgs, named concepts>"], "turnIds":["<source turn id>", "..."]}',
    "",
    "Rules:",
    "- Preserve chronology, source dates, relative-date phrases, quantities, prices, ordered lists, and countable events.",
    "- Capture USER facts, preferences, plans, state changes, relationships, possessions, completed actions, and corrections.",
    "- Capture ASSISTANT-provided answers, recommendations, explanations, and commitments if they may later be asked about.",
    "- Mark planned or pending things as planned; mark completed things as completed; mark cancelled/returned/discarded items explicitly.",
    "- For updates, make the latest state explicit and mention what changed.",
    "- Split enumerations into separate observations when each item could be counted later.",
    "- Include only observations supported by the transcript, and include the exact source turn ids.",
    `- Return at most ${maxObservations} observations for this chunk, and do not fill the quota unless the chunk truly contains that many durable observations.`,
    "- Prefer a compact observation log: many chunks should produce fewer than the cap.",
    "- Return ONLY the JSON array, no prose.",
    "",
    `Instance: ${instance.id}`,
    "Transcript:",
    transcript,
  ].join("\n");
}

function buildCombinedExtractionPrompt(
  instance: MemQAInstance,
  turns: DatedTurn[],
  maxFacts: number,
  maxObservations: number,
): string {
  const transcript = turns
    .map((t) => `[${t.sessionId}${t.date ? ` @ ${t.date}` : ""} turn ${t.id}] ${t.speaker}: ${t.text}`)
    .join("\n");
  return [
    "You are building long-term memory for an AI assistant from past user/assistant chat sessions.",
    "In one pass, extract both atomic answer-bearing facts and compact chronological observation-log entries.",
    "",
    "Return ONLY a JSON object with this exact shape:",
    "{",
    '  "facts": [{"fact":"<one self-contained fact; include speaker role and date/time when relevant>", "entities":["<proper nouns: people, pets, places, orgs, named things>"]}],',
    '  "observations": [{"statement":"<one self-contained observation; include exact names, numbers, dates, and role when relevant>", "type":"event|preference|state_update|plan|commitment|relationship|assistant_answer|inventory|temporal|other", "date":"<best YYYY/MM/DD or source date string, if known>", "status":"current|historical|planned|completed|cancelled|superseded|unknown", "entities":["<important people, places, items, orgs, named concepts>"], "turnIds":["<source turn id>", "..."]}]',
    "}",
    "",
    "Fact rules:",
    "- Capture USER facts, preferences, plans, state changes, relationships, dates, quantities, and outcomes.",
    "- Capture ASSISTANT-provided answers, recommendations, explanations, decisions, and commitments when they may be asked about later.",
    "- Preserve exact names, numbers, list members, descriptive modifiers, and emotionally loaded phrasing.",
    "- Preserve the original temporal phrasing, and include the session date when useful.",
    "- If a fact supersedes an earlier state, make the replacement explicit.",
    "- Split enumerations into separate facts so each item is independently retrievable.",
    `- Return at most ${maxFacts} facts for this chunk; prefer the most durable, specific, answer-bearing facts.`,
    "",
    "Observation rules:",
    "- Preserve chronology, source dates, relative-date phrases, quantities, prices, ordered lists, and countable events.",
    "- Capture USER facts, preferences, plans, state changes, relationships, possessions, completed actions, and corrections.",
    "- Capture ASSISTANT-provided answers, recommendations, explanations, and commitments if they may later be asked about.",
    "- Mark planned or pending things as planned; mark completed things as completed; mark cancelled/returned/discarded items explicitly.",
    "- For updates, make the latest state explicit and mention what changed.",
    "- Split enumerations into separate observations when each item could be counted later.",
    "- Include only observations supported by the transcript, and include the exact source turn ids.",
    `- Return at most ${maxObservations} observations for this chunk, and do not fill the quota unless the chunk truly contains that many durable observations.`,
    "- Prefer a compact observation log: many chunks should produce fewer than the cap.",
    "",
    "General rules:",
    "- Skip greetings and filler with no lasting information.",
    "- Do not invent or infer unsupported memories.",
    "",
    `Instance: ${instance.id}`,
    "Transcript:",
    transcript,
  ].join("\n");
}

function coerceFact(item: unknown): ExtractedFact | null {
  if (!item || typeof item !== "object") return null;
  const f = item as ExtractedFact;
  if (typeof f.fact !== "string" || !f.fact.trim()) return null;
  return {
    fact: f.fact.trim(),
    entities: Array.isArray(f.entities)
      ? f.entities.filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim())
      : [],
  };
}

function normalizeObservationType(value: unknown): ObservationKind {
  return typeof value === "string" && OBSERVATION_TYPES.has(value as ObservationKind)
    ? (value as ObservationKind)
    : "other";
}

function normalizeObservationStatus(value: unknown): ObservationStatus {
  return typeof value === "string" && OBSERVATION_STATUSES.has(value as ObservationStatus)
    ? (value as ObservationStatus)
    : "unknown";
}

function coerceObservation(item: unknown): ExtractedObservation | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as {
    statement?: unknown;
    type?: unknown;
    date?: unknown;
    status?: unknown;
    entities?: unknown;
    turnIds?: unknown;
    sourceTurnIds?: unknown;
  };
  if (typeof obj.statement !== "string" || !obj.statement.trim()) return null;
  const turnIdsRaw = Array.isArray(obj.turnIds) ? obj.turnIds : obj.sourceTurnIds;
  const turnIds = Array.isArray(turnIdsRaw)
    ? turnIdsRaw.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
    : [];
  return {
    statement: obj.statement.trim(),
    type: normalizeObservationType(obj.type),
    ...(typeof obj.date === "string" && obj.date.trim() ? { date: obj.date.trim() } : {}),
    status: normalizeObservationStatus(obj.status),
    entities: Array.isArray(obj.entities)
      ? obj.entities.filter((e): e is string => typeof e === "string" && e.trim().length > 0).map((e) => e.trim())
      : [],
    turnIds,
  };
}

function salvageObjects(s: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const fact = coerceFact(JSON.parse(s.slice(start, i + 1)));
          if (fact) facts.push(fact);
        } catch {
          // Skip malformed object.
        }
        start = -1;
      }
    }
  }
  return facts;
}

function salvageObservationObjects(s: string): ExtractedObservation[] {
  const observations: ExtractedObservation[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const obs = coerceObservation(JSON.parse(s.slice(start, i + 1)));
          if (obs) observations.push(obs);
        } catch {
          // Skip malformed object.
        }
        start = -1;
      }
    }
  }
  return observations;
}

function parseFacts(raw: string): ExtractedFact[] {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(s.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed)) return parsed.map(coerceFact).filter((f): f is ExtractedFact => f !== null);
    } catch {
      // Fall through to salvage.
    }
  }
  return salvageObjects(start !== -1 ? s.slice(start) : s);
}

function parseObservations(raw: string): ExtractedObservation[] {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(s.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map(coerceObservation).filter((o): o is ExtractedObservation => o !== null);
      }
    } catch {
      // Fall through to salvage.
    }
  }
  return salvageObservationObjects(start !== -1 ? s.slice(start) : s);
}

function coerceCombinedExtraction(value: unknown): CombinedExtraction | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as { facts?: unknown; observations?: unknown };
  const facts = Array.isArray(obj.facts)
    ? obj.facts.map(coerceFact).filter((f): f is ExtractedFact => f !== null)
    : [];
  const observations = Array.isArray(obj.observations)
    ? obj.observations.map(coerceObservation).filter((o): o is ExtractedObservation => o !== null)
    : [];
  if (facts.length === 0 && observations.length === 0) return null;
  return { facts, observations };
}

function parseCombinedExtraction(raw: string): CombinedExtraction {
  const s = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const candidates = [s];
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(s.slice(start, end + 1));

  for (const candidate of candidates) {
    try {
      const parsed = coerceCombinedExtraction(JSON.parse(candidate));
      if (parsed) return parsed;
    } catch {
      // Fall through to the next candidate or salvage below.
    }
  }

  return {
    facts: salvageObjects(start !== -1 ? s.slice(start) : s),
    observations: salvageObservationObjects(start !== -1 ? s.slice(start) : s),
  };
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function flattenTurns(instance: MemQAInstance): DatedTurn[] {
  return instance.sessions.flatMap((session) =>
    session.turns.map((turn) => ({
      id: turn.id,
      sessionId: session.id,
      speaker: turn.speaker,
      text: turn.text,
      date: session.date,
    })),
  );
}

function chunkTurns(turns: DatedTurn[], size: number): DatedTurn[][] {
  const chunks: DatedTurn[][] = [];
  for (let i = 0; i < turns.length; i += size) chunks.push(turns.slice(i, i + size));
  return chunks;
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function buildExperienceItems(
  instance: MemQAInstance,
  granularity: ExperienceGranularity,
  chunkTurns: number,
): Array<{
  id: string;
  taskInput: string;
  solutionOutput: string;
  sessionId: string;
  date?: string;
  turnIds: string[];
}> {
  const items: Array<{
    id: string;
    taskInput: string;
    solutionOutput: string;
    sessionId: string;
    date?: string;
    turnIds: string[];
  }> = [];

  for (const session of instance.sessions) {
    const turns = session.turns.map((turn) => ({
      ...turn,
      line: `${turn.speaker}: ${turn.text}`,
    }));
    const chunks =
      granularity === "turn"
        ? turns.map((turn, index) => ({ turns: [turn], label: `turn ${index + 1}` }))
        : granularity === "chunk"
          ? chunkArray(turns, chunkTurns).map((chunk, index) => ({
              turns: chunk,
              label: `chunk ${index + 1}`,
            }))
          : [{ turns, label: "session" }];

    for (const chunk of chunks) {
      const transcript = chunk.turns.map((turn) => turn.line).join("\n");
      const title = [
        `LongMemEval ${chunk.label}`,
        `session ${session.id}`,
        session.date ? `on ${session.date}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      const turnIds = chunk.turns.map((turn) => turn.id);
      const idSuffix = granularity === "session" ? session.id : `${session.id}-${chunk.label}`;
      items.push({
        id: `e-${safeFileName(idSuffix)}`,
        taskInput: `${title}\nTurn ids: ${turnIds.join(", ")}\n\nTranscript:\n${transcript}`,
        solutionOutput: transcript,
        sessionId: session.id,
        date: session.date,
        turnIds,
      });
    }
  }

  return items;
}

function sessionIdsFromKnowledge(excerpts: RetrievedExcerpt[]): Set<string> {
  const out = new Set<string>();
  for (const excerpt of excerpts) {
    const match = /#\s+([^\s:]+(?::[^\s:]+)*):\d+/.exec(excerpt.text);
    if (match?.[1]) out.add(match[1]);
    for (const turnMatch of excerpt.text.matchAll(/\b([A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)*):\d+\b/g)) {
      if (turnMatch[1]) out.add(turnMatch[1]);
    }
  }
  return out;
}

async function decomposeQuestion(llm: LlmClient, question: string): Promise<string[]> {
  try {
    const { text } = await llm.chat([
      {
        role: "user",
        content: [
          "Decide whether a question needs MULTIPLE separate memory lookups to answer.",
          "Most questions do NOT. Only split comparisons, intersections, or questions combining facts about distinct subjects/events.",
          "When splitting, write one self-contained lookup query per hop. Max 4.",
          "Return ONLY a JSON array of strings.",
          "",
          `Question: ${question}`,
        ].join("\n"),
      },
    ]);
    const parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")) as unknown;
    if (Array.isArray(parsed)) {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const q of [question, ...parsed]) {
        if (typeof q !== "string" || !q.trim()) continue;
        const key = q.trim().toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          out.push(q.trim());
        }
      }
      return out.slice(0, 5);
    }
  } catch {
    // Fall back to single-query retrieval.
  }
  return [question];
}

function zeroUsage(): LlmUsage {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0 };
}

function addLlmUsage(a: LlmUsage, u: LlmUsage): void {
  a.promptTokens += u.promptTokens;
  a.completionTokens += u.completionTokens;
  a.totalTokens += u.totalTokens;
  a.latencyMs += u.latencyMs;
}

function stripJsonFence(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

interface PlannedToolQuery {
  tool: "memory_search" | "knowledge_search";
  query: string;
}

function parsePlannedToolQueries(raw: string, maxQueries: number): PlannedToolQuery[] {
  try {
    const parsed = JSON.parse(stripJsonFence(raw)) as unknown;
    const value =
      parsed && typeof parsed === "object" && Array.isArray((parsed as { queries?: unknown }).queries)
        ? (parsed as { queries: unknown[] }).queries
        : Array.isArray(parsed)
          ? parsed
          : [];
    const out: PlannedToolQuery[] = [];
    const seen = new Set<string>();
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const obj = item as { tool?: unknown; query?: unknown };
      const tool = obj.tool === "knowledge_search" ? "knowledge_search" : "memory_search";
      if (typeof obj.query !== "string" || !obj.query.trim()) continue;
      const query = obj.query.trim();
      const key = `${tool}:${query.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tool, query });
      if (out.length >= maxQueries) break;
    }
    return out;
  } catch {
    return [];
  }
}

function questionNeedsStructuredToolPass(question: MemQuestion): boolean {
  const q = question.question.toLowerCase();
  return (
    question.category === "multi-session" ||
    question.category === "temporal-reasoning" ||
    question.category === "knowledge-update" ||
    /\b(how many|count|list|all|which|order|ordered|timeline|first|last|before|after|latest|current|changed|updated|prefer|recommend)\b/.test(
      q,
    )
  );
}

function addUniquePlannedToolQuery(queries: PlannedToolQuery[], query: PlannedToolQuery): void {
  const key = `${query.tool}:${query.query.toLowerCase()}`;
  if (!queries.some((q) => `${q.tool}:${q.query.toLowerCase()}` === key)) queries.push(query);
}

function knowledgeToExcerpt(match: KnowledgeMatch, question: string, index: number, selectedBy: string): RetrievedExcerpt {
  const body = match.note.body ?? "";
  const type = match.matchType ?? "semantic";
  const id = match.note.frontmatter.id;
  return {
    ref: `${id} [${type}]`,
    text: excerptForQuery(body, question),
    channel: "knowledge",
    query: question,
    sourceRank: index + 1,
    sourceScore: match.score,
    noteId: id,
    matchType: type,
    selectedBy,
  };
}

function isObservationMemoryMatch(match: KnowledgeMatch): boolean {
  return match.note.frontmatter.tags.includes("observation-memory");
}

function observationBody(match: KnowledgeMatch): string {
  return match.note.body ?? "";
}

function observationTypeOf(match: KnowledgeMatch): ObservationKind | null {
  const tag = match.note.frontmatter.tags.find((t) => t.startsWith("observation-") && t !== "observation-memory");
  const value = tag?.slice("observation-".length);
  return OBSERVATION_TYPES.has(value as ObservationKind) ? (value as ObservationKind) : null;
}

function observationDateOf(match: KnowledgeMatch): string {
  return /^Observation date:\s*(.+)$/m.exec(observationBody(match))?.[1]?.trim() ?? "unknown";
}

function observationIntent(question: MemQuestion): "money" | "temporal" | "preference" | "general" {
  const q = question.question.toLowerCase();
  if (question.category === "temporal-reasoning" || /\b(order|earliest|latest|timeline|before|after|first|last)\b/.test(q)) {
    return "temporal";
  }
  if (/\b(spent|spend|cost|costs|price|prices|expense|expenses|paid|purchase|bought|total money|\$)\b/.test(q)) {
    return "money";
  }
  if (question.category === "single-session-preference" || /\b(prefer|preference|like|suggest|recommend)\b/.test(q)) {
    return "preference";
  }
  return "general";
}

function observationIntentScore(question: MemQuestion, match: KnowledgeMatch, sourceRank: number): number {
  const intent = observationIntent(question);
  const type = observationTypeOf(match);
  const body = observationBody(match);
  const lower = body.toLowerCase();
  let score = (match.score ?? 0) - sourceRank * 0.001;

  if (intent === "money") {
    if (/\$\s?\d|\b\d+\s?(?:dollars|usd)\b/i.test(body)) score += 8;
    if (/\b(bought|paid|spent|cost|costs|price|purchase|purchased|installed|investment|expense)\b/.test(lower)) {
      score += 5;
    }
    if (type === "inventory" || type === "event") score += 3;
    if (type === "assistant_answer" || type === "preference") score -= 4;
    if (/\b(goal|mileage|miles|route|insurance|rack)\b/.test(lower) && !/\$\s?\d/.test(body)) score -= 3;
  } else if (intent === "temporal") {
    if (type === "event") score += 7;
    if (type === "inventory" || type === "state_update") score += 2;
    if (type === "preference" || type === "plan") score -= 4;
    if (type === "assistant_answer") score -= 3;
    if (/\b(visited|attended|participated|took|tour|exhibition|museum|gallery)\b/.test(lower)) score += 4;
    if (/\brecently\b/.test(lower)) score -= 2;
  } else if (intent === "preference") {
    if (type === "preference") score += 7;
    if (type === "state_update" || type === "event") score += 2;
    if (type === "assistant_answer") score -= 2;
  } else {
    if (type === "assistant_answer") score -= 1;
  }

  const qTokens = tokenize(question.question);
  for (const token of tokenize(body)) if (qTokens.has(token)) score += 0.05;
  return score;
}

function selectObservationMatches(question: MemQuestion, matches: KnowledgeMatch[], limit: number): KnowledgeMatch[] {
  const ranked = matches
    .map((match, index) => ({ match, score: observationIntentScore(question, match, index) }))
    .sort((a, b) => b.score - a.score);

  if (observationIntent(question) !== "temporal") return ranked.slice(0, limit).map((x) => x.match);

  const selected: KnowledgeMatch[] = [];
  const seen = new Set<string>();
  const dateCounts = new Map<string, number>();
  for (const { match } of ranked) {
    const id = match.note.frontmatter.id;
    if (seen.has(id)) continue;
    const date = observationDateOf(match);
    if ((dateCounts.get(date) ?? 0) >= 1) continue;
    seen.add(id);
    dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1);
    selected.push(match);
    if (selected.length >= limit) return selected;
  }
  for (const { match } of ranked) {
    const id = match.note.frontmatter.id;
    if (seen.has(id)) continue;
    const date = observationDateOf(match);
    if ((dateCounts.get(date) ?? 0) >= 2) continue;
    seen.add(id);
    dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1);
    selected.push(match);
    if (selected.length >= limit) return selected;
  }
  for (const { match } of ranked) {
    const id = match.note.frontmatter.id;
    if (seen.has(id)) continue;
    seen.add(id);
    selected.push(match);
    if (selected.length >= limit) return selected;
  }
  return selected;
}

function observationSortKey(obs: ExtractedObservation): string {
  const date = obs.date?.replace(/\//g, "-") ?? "9999-99-99";
  const turn = obs.turnIds[0] ?? "";
  return `${date}\t${turn}\t${obs.type}\t${obs.statement}`;
}

function truncateStableContext(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const headChars = Math.floor(maxChars * 0.55);
  const tailChars = Math.max(0, maxChars - headChars - 120);
  return [
    text.slice(0, headChars).trimEnd(),
    "",
    `... [observation log truncated to ${maxChars} chars; middle omitted] ...`,
    "",
    text.slice(text.length - tailChars).trimStart(),
  ].join("\n");
}

function formatObservationLogContext(observations: ExtractedObservation[], maxChars: number): string {
  if (observations.length === 0 || maxChars <= 0) return "";
  const sorted = [...observations].sort((a, b) => observationSortKey(a).localeCompare(observationSortKey(b)));
  const lines = [
    "## Chronological Observation Log",
    "This is stable long-term memory distilled from past sessions. Treat each line as evidence only for what it explicitly states.",
    "Use dates, statuses, and source turn ids carefully. For relative-date questions, anchor relative phrases to the source turn date and verify against raw turns if available. Do not infer facts that are only adjacent or related.",
    "",
    ...sorted.map((obs, index) => {
      const date = obs.date ?? "unknown";
      const turns = obs.turnIds.length > 0 ? obs.turnIds.join(",") : "unknown";
      return `${index + 1}. [${date}] ${obs.type}/${obs.status}: ${obs.statement} (turns: ${turns})`;
    }),
  ].join("\n");
  return truncateStableContext(lines, maxChars);
}

function mergeKnowledgeMatches(primary: KnowledgeMatch[], secondary: KnowledgeMatch[], limit: number): KnowledgeMatch[] {
  const out: KnowledgeMatch[] = [];
  const seen = new Set<string>();
  for (const match of [...primary, ...secondary]) {
    const id = match.note.frontmatter.id;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(match);
    if (out.length >= limit) break;
  }
  return out;
}

function injectedMemoryToExcerpts(
  memory: MemoryQueryResultV2 | undefined,
  question: string,
  injectedExperienceCount: number,
  selectedBy = "atlas-injected-experience",
): RetrievedExcerpt[] {
  if (!memory) return [];
  const out: RetrievedExcerpt[] = [];
  for (const [index, match] of memory.experiences.slice(0, injectedExperienceCount).entries()) {
    const metadata = (match.experience.metadata ?? {}) as Record<string, unknown>;
    const turnIds = Array.isArray(metadata.turnIds)
      ? metadata.turnIds.filter((x): x is string => typeof x === "string")
      : undefined;
    out.push({
      ref: `${match.experience.id} [experience:${match.score.toFixed(3)}]`,
      text: excerptForQuery(match.experience.taskInput, question),
      channel: "experience",
      query: question,
      sourceRank: index + 1,
      sourceScore: match.score,
      experienceId: match.experience.id,
      sessionId: typeof metadata.sessionId === "string" ? metadata.sessionId : undefined,
      turnIds,
      date: typeof metadata.date === "string" ? metadata.date : undefined,
      selectedBy,
    });
  }
  return out;
}

class LongMemEvalLiveDelegate implements AgentDelegate {
  readonly usage = zeroUsage();
  readonly toolCalls: LiveToolTrace[] = [];
  systemContextChars = 0;

  constructor(
    private readonly llm: LlmClient,
    private readonly question: MemQuestion,
    private readonly toolExecutor: MemoryToolExecutor | null,
    private readonly maxToolQueries: number,
    private readonly maxToolResults: number,
  ) {}

  async execute(prompt: string, options: AgentDelegateOptions): Promise<{ success: boolean; output: string }> {
    const systemContext = options.systemContext ?? "";
    this.systemContextChars = systemContext.length;

    const toolOutputs = this.toolExecutor ? await this.runMemoryTools(prompt, systemContext) : [];
    const excerpts = [
      ...(systemContext ? [{ ref: "atlas-system-context", text: systemContext }] : []),
      ...toolOutputs.map((t, index) => ({
        ref: `minimem-tool-${index + 1}:${t.tool}`,
        text: `Query: ${t.query}\n${t.output}`,
      })),
    ];
    const finalPrompt = [
      "You are a live cognitive-core agent with Atlas memory already injected and minimem memory tools available.",
      "Use the injected context and any tool results as your only source of past-memory evidence.",
      "The context may contain KnowledgeBank notes, raw imported turns, extracted facts, and ExperienceMemory excerpts.",
      "",
      buildLongMemEvalAnswerPrompt(this.question.question, this.question.date, excerpts, this.question.category),
    ].join("\n");
    const res = await this.llm.chat([{ role: "user", content: finalPrompt }]);
    addLlmUsage(this.usage, res.usage);
    return { success: true, output: res.text.trim() };
  }

  private async runMemoryTools(prompt: string, systemContext: string): Promise<LiveToolTrace[]> {
    const queries: PlannedToolQuery[] = [];
    addUniquePlannedToolQuery(queries, { tool: "memory_search", query: this.question.question });
    if (this.maxToolQueries > 1 && questionNeedsStructuredToolPass(this.question)) {
      addUniquePlannedToolQuery(queries, { tool: "knowledge_search", query: this.question.question });
    }
    if (queries.length < this.maxToolQueries) {
      const planPrompt = [
        "You are deciding whether to use minimem memory tools before answering a long-term memory question.",
        "Return ONLY JSON: {\"queries\":[{\"tool\":\"memory_search|knowledge_search\",\"query\":\"...\"}]}",
        `Return at most ${this.maxToolQueries - queries.length} additional queries. Use no query if the existing searches are enough.`,
        "",
        "Available tools:",
        "- memory_search: semantic search over raw and knowledge memory files.",
        "- knowledge_search: metadata-aware search over structured knowledge notes.",
        "",
        "Question date:",
        this.question.date ?? "unknown",
        "Question:",
        prompt,
        "",
        "Injected context preview:",
        systemContext.slice(0, 12000),
      ].join("\n");
      const planned = await this.llm.chat([{ role: "user", content: planPrompt }]);
      addLlmUsage(this.usage, planned.usage);
      for (const query of parsePlannedToolQueries(planned.text, this.maxToolQueries - queries.length)) {
        addUniquePlannedToolQuery(queries, query);
      }
    }

    for (const query of queries.slice(0, this.maxToolQueries)) {
      try {
        const result = await this.toolExecutor!.execute(query.tool, {
          query: query.query,
          maxResults: this.maxToolResults,
          minScore: 0,
          detail: "full",
        });
        const output = toolResultText(result);
        this.toolCalls.push({ ...query, output });
      } catch (err) {
        this.toolCalls.push({ ...query, output: "", error: err instanceof Error ? err.message : String(err) });
      }
    }
    return this.toolCalls;
  }
}

function toolResultText(result: ToolResult): string {
  return result.content.map((c) => c.text).join("\n\n");
}

export class CogcoreLongMemEvalAdapter {
  readonly name: CogcoreLongMemEvalArm;
  private readonly topK: number;
  private readonly scratchRoot: string;
  private readonly embeddings: Embeddings;
  private readonly extractConcurrency: number;
  private readonly cache: boolean;
  private readonly cacheDir: string;
  private readonly keywordExpansion: boolean;
  private readonly mmr?: MmrConfig;
  private readonly hybridRawTurns: boolean;
  private readonly multiQuery: boolean;
  private readonly evolveMemory: boolean;
  private readonly systemMemory: boolean;
  private readonly experienceSlots: number;
  private readonly experienceMinScore: number | undefined;
  private readonly experienceGranularity: ExperienceGranularity;
  private readonly experienceChunkTurns: number;
  private readonly experienceEmbedding: ExperienceEmbedding;
  private readonly experienceScope: ExperienceScope;
  private readonly experiencePoolSize: number;
  private readonly chunkTurnCount: number;
  private readonly maxFactsPerChunk: number;
  private readonly onProgress?: (message: string) => void;
  private state: CogcoreState | null = null;
  private system: MemorySystem | null = null;
  private persistence: SqlitePersistence | null = null;
  private currentInstanceId: string | null = null;

  constructor(private readonly llm: LlmClient, name: CogcoreLongMemEvalArm, opts: CogcoreLongMemEvalOptions = {}) {
    this.name = name;
    this.topK = opts.topK ?? 16;
    this.scratchRoot = opts.scratchRoot ?? defaultScratchRoot();
    this.embeddings = opts.embeddings ?? "local";
    this.extractConcurrency = opts.extractConcurrency ?? 2;
    this.cache = opts.cache ?? true;
    this.cacheDir = opts.cacheDir ?? path.resolve("evals/longmemeval/.cache/cogcore-extractions");
    this.keywordExpansion = opts.keywordExpansion ?? false;
    this.mmr = opts.mmr;
    this.hybridRawTurns = opts.hybridRawTurns ?? name !== "cogcore-memory";
    this.multiQuery = opts.multiQuery ?? name === "cogcore-hybrid-mq";
    this.evolveMemory = opts.evolve ?? (name === "cogcore-evolve" || name === "cogcore-system-evolve");
    this.systemMemory = opts.systemMemory ?? (name === "cogcore-system" || name === "cogcore-system-evolve");
    this.experienceSlots = opts.experienceSlots ?? defaultSystemExperienceSlots(this.topK);
    this.experienceMinScore = opts.experienceMinScore;
    this.experienceGranularity = opts.experienceGranularity ?? "session";
    this.experienceChunkTurns = opts.experienceChunkTurns ?? DEFAULT_EXPERIENCE_CHUNK_TURNS;
    this.experienceEmbedding = opts.experienceEmbedding ?? "none";
    this.experienceScope = opts.experienceScope ?? "knowledge-sessions";
    this.experiencePoolSize = opts.experiencePoolSize ?? Math.max(this.topK, this.experienceSlots * 8, 32);
    this.chunkTurnCount = opts.chunkTurns ?? DEFAULT_CHUNK_TURNS;
    this.maxFactsPerChunk = opts.maxFactsPerChunk ?? DEFAULT_MAX_FACTS_PER_CHUNK;
    this.onProgress = opts.onProgress;
  }

  private keywordHook(): ((prompt: string) => Promise<string>) | undefined {
    if (!this.keywordExpansion) return undefined;
    return async (prompt: string) => (await this.llm.chat([{ role: "user", content: prompt }])).text;
  }

  private cachePath(instanceId: string): string {
    return path.join(this.cacheDir, `${safeFileName(instanceId)}.json`);
  }

  private async loadCache(instanceId: string): Promise<ExtractedFact[] | null> {
    if (!this.cache) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(this.cachePath(instanceId), "utf-8")) as ExtractionCache;
      if (
        parsed.version === COGCORE_EXTRACTION_CACHE_VERSION &&
        parsed.instanceId === instanceId &&
        parsed.chunkTurns === this.chunkTurnCount &&
        parsed.maxFactsPerChunk === this.maxFactsPerChunk
      ) {
        return parsed.facts;
      }
    } catch {
      // Cache miss.
    }
    return null;
  }

  private async saveCache(instanceId: string, facts: ExtractedFact[]): Promise<void> {
    if (!this.cache) return;
    const payload: ExtractionCache = {
      version: COGCORE_EXTRACTION_CACHE_VERSION,
      instanceId,
      chunkTurns: this.chunkTurnCount,
      maxFactsPerChunk: this.maxFactsPerChunk,
      facts,
    };
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.writeFile(this.cachePath(instanceId), JSON.stringify(payload), "utf-8");
  }

  private planPath(instanceId: string): string {
    return path.join(this.cacheDir, "..", "cogcore-evolve-plans", `${safeFileName(instanceId)}.json`);
  }

  private async loadPlan(instanceId: string): Promise<MemoryEvolutionPlan | null> {
    if (!this.cache) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(this.planPath(instanceId), "utf-8")) as EvolutionCache;
      if (
        parsed.version === COGCORE_EXTRACTION_CACHE_VERSION &&
        parsed.instanceId === instanceId &&
        parsed.chunkTurns === this.chunkTurnCount &&
        parsed.maxFactsPerChunk === this.maxFactsPerChunk
      ) {
        return parsed.plan;
      }
    } catch {
      // Cache miss.
    }
    return null;
  }

  private async savePlan(instanceId: string, plan: MemoryEvolutionPlan): Promise<void> {
    if (!this.cache) return;
    const payload: EvolutionCache = {
      version: COGCORE_EXTRACTION_CACHE_VERSION,
      instanceId,
      chunkTurns: this.chunkTurnCount,
      maxFactsPerChunk: this.maxFactsPerChunk,
      plan,
    };
    const p = this.planPath(instanceId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify(payload), "utf-8");
  }

  private async openSystemState(): Promise<CogcoreState> {
    const dir = await fs.mkdtemp(path.join(this.scratchRoot, "lme-ccs-"));
    const baseDir = path.join(dir, "system");
    const persistence = createSqlitePersistence({ baseDir });
    await persistence.init();
    const system = createMemorySystem(
      persistence,
      baseDir,
      {
        maxExperiences: this.topK,
        maxStrategies: 0,
        maxSkills: 0,
        maxContextTokens: 16_000,
        seedMetaPlaybooks: false,
        seedMetaStrategies: false,
        proceduralMemory: {
          source: "sqlite",
          dir: "playbooks",
          strictStartup: false,
          pruneSqliteOnly: false,
          watch: false,
          watchDebounceMs: 150,
          watchUsePolling: false,
          watchPollIntervalMs: 100,
          structuralDualWrite: { enabled: false, dir: "playbooks" },
        },
      },
      KnowledgeBankConfigSchema.parse({ enabled: true, memoryDir: "memory" }),
    );
    await system.init();
    if (this.experienceEmbedding === "hash") {
      system.experiences.setEmbeddingProvider(new HashEmbeddingProvider({ dimension: 512 }), { embedOnStore: true });
    }
    if (!system.knowledgeBank) throw new Error("cogcore-system initialized without a KnowledgeBank");
    this.system = system;
    this.persistence = persistence;
    return { dir, memoryDir: path.join(baseDir, "memory"), kb: system.knowledgeBank, mm: null };
  }

  private async addSessionExperiences(instance: MemQAInstance): Promise<number> {
    if (!this.system) return 0;
    let n = 0;
    for (const item of this.buildExperienceItems(instance)) {
      await this.system.experiences.add(
        createExperience({
          id: item.id,
          taskInput: item.taskInput,
          solutionOutput: item.solutionOutput,
          feedback: "Imported user/assistant session as episodic memory.",
          success: true,
          domain: instance.id,
          trajectoryId: `${instance.id}:${item.sessionId}`,
          metadata: {
            instanceId: instance.id,
            sessionId: item.sessionId,
            date: item.date,
            kind: "longmemeval-session",
            granularity: this.experienceGranularity,
            turnIds: item.turnIds,
          },
        }),
      );
      n++;
    }
    return n;
  }

  private buildExperienceItems(instance: MemQAInstance): Array<{
    id: string;
    taskInput: string;
    solutionOutput: string;
    sessionId: string;
    date?: string;
    turnIds: string[];
  }> {
    return buildExperienceItems(instance, this.experienceGranularity, this.experienceChunkTurns);
  }

  async ingest(instance: MemQAInstance): Promise<UsageAccumulator> {
    await this.close();
    const started = Date.now();
    const usage: UsageAccumulator = { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0 };
    this.currentInstanceId = instance.id;
    const state = this.systemMemory ? await this.openSystemState() : await openBank(this.scratchRoot, "lme-ccm-");
    this.state = state;

    let facts = await this.loadCache(instance.id);
    if (!facts) {
      const chunks = chunkTurns(flattenTurns(instance), this.chunkTurnCount).map((turns, index) => ({ turns, index }));
      this.onProgress?.(`extracting ${chunks.length} chunks for ${instance.id}`);
      const perChunk = await mapPool(chunks, this.extractConcurrency, async (chunk) => {
        const res = await this.llm.chat([
          { role: "user", content: buildExtractionPrompt(instance, chunk.turns, this.maxFactsPerChunk) },
        ]);
        addUsage(usage, res.usage);
        const parsed = parseFacts(res.text).slice(0, this.maxFactsPerChunk);
        this.onProgress?.(`chunk ${chunk.index + 1}/${chunks.length}: ${parsed.length} facts`);
        return parsed;
      });
      facts = perChunk.flat();
      await this.saveCache(instance.id, facts);
      this.onProgress?.(`extracted ${facts.length} facts for ${instance.id}`);
    } else {
      this.onProgress?.(`cache hit for ${instance.id}: ${facts.length} facts`);
    }

    let n = 0;
    for (const fact of facts) {
      await state.kb.addObservation(
        createObservation({
          id: `k-${String(n).padStart(6, "0")}`,
          title: `fact-${String(n).padStart(6, "0")}`,
          body: fact.fact,
          domain: [instance.id],
          entities: fact.entities,
          tags: ["extracted"],
          confidence: 0.8,
          source: { origin: "extracted" },
        }),
      );
      n++;
    }

    if (this.hybridRawTurns) {
      let r = 0;
      for (const turn of flattenTurns(instance)) {
        const when = turn.date ? `[${turn.date}] ` : "";
        await state.kb.addObservation(
          createObservation({
            id: `t-${String(r).padStart(6, "0")}`,
            title: turn.id,
            body: `${when}${turn.speaker}: ${turn.text}`,
            domain: [instance.id],
            entities: [],
            tags: [`session-${turn.sessionId}`, "raw-turn"],
            confidence: 0.7,
            source: { origin: "imported" },
          }),
        );
        r++;
      }
    }

    if (this.systemMemory) {
      const sessionCount = await this.addSessionExperiences(instance);
      this.onProgress?.(`stored ${sessionCount} ${this.experienceGranularity} experiences for ${instance.id}`);
    }

    this.onProgress?.(
      `indexing ${facts.length} extracted facts${this.hybridRawTurns ? " + raw turns" : ""}${
        this.systemMemory ? ` + ${this.experienceGranularity} experiences` : ""
      } for ${instance.id}`,
    );
    await state.kb.defragment();

    if (this.evolveMemory) {
      let plan = await this.loadPlan(instance.id);
      if (!plan) {
        this.onProgress?.(`evolving memory for ${instance.id}`);
        const evolveLlm = new LlmClient({ maxCompletionTokens: 16384 });
        const evolver = createLlmMemoryEvolver(
          async (prompt: string) => {
            const res = await evolveLlm.chat([{ role: "user", content: prompt }]);
            addUsage(usage, res.usage);
            return res.text;
          },
          { excludeTags: ["raw-turn"] },
        );
        plan = await evolver({
          notes: await state.kb.getAllNotes(),
          domains: await state.kb.listDomains(),
          entities: await state.kb.listEntities(),
        });
        await this.savePlan(instance.id, plan);
      } else {
        this.onProgress?.(`evolve plan cache hit for ${instance.id}: ${plan.actions.length} actions`);
      }
      const evo = await state.kb.applyEvolutionPlan(plan);
      this.onProgress?.(
        `evolved actions=${plan.actions.length} merged=${evo.merged} linked=${evo.linked} superseded=${evo.superseded} skipped=${evo.skipped}`,
      );
    }

    await indexAndInject(state, this.embeddings, this.topK, this.keywordHook(), this.mmr);
    usage.latencyMs += Date.now() - started;
    return usage;
  }

  async retrieve(question: MemQuestion): Promise<RetrievedExcerpt[]> {
    if (!this.state) throw new Error("ingest() must run before retrieve()");
    const queries = this.multiQuery ? await decomposeQuestion(this.llm, question.question) : [question.question];
    const perQuery = await Promise.all(queries.map((q) => this.retrieveForQuery(q)));

    const merged: RetrievedExcerpt[] = [];
    const seen = new Set<string>();
    for (let rank = 0; merged.length < this.topK; rank++) {
      let advanced = false;
      for (const list of perQuery) {
        if (rank >= list.length) continue;
        advanced = true;
        const item = list[rank]!;
        if (!seen.has(item.ref)) {
          seen.add(item.ref);
          merged.push(item);
          if (merged.length >= this.topK) break;
        }
      }
      if (!advanced) break;
    }

    return merged;
  }

  private async retrieveForQuery(query: string): Promise<RetrievedExcerpt[]> {
    if (!this.state) throw new Error("ingest() must run before answer()");
    const knowledge = (await this.state.kb.getRelevantKnowledge(
      { description: query },
      { maxNotes: this.topK, maxTokens: MAX_KNOWLEDGE_TOKENS },
    )) as KnowMatch[];
    const knowledgeExcerpts = knowledge.map((m, index): RetrievedExcerpt => {
      const type = m.matchType ?? "semantic";
      const body = m.note.body ?? "";
      const id = m.note.frontmatter.id;
      return {
        ref: `${id} [${type}]`,
        text: excerptForQuery(body, query),
        channel: "knowledge",
        query,
        sourceRank: index + 1,
        sourceScore: m.score,
        noteId: id,
        matchType: type,
        selectedBy: this.system ? "knowledge-primary" : "knowledge-only",
      };
    });

    if (!this.system || !this.currentInstanceId) return knowledgeExcerpts;

    const experienceSlots = Math.min(this.experienceSlots, Math.max(0, this.topK - 1));
    const knowledgeSlots = Math.max(1, this.topK - experienceSlots);
    const retainedKnowledge = knowledgeExcerpts.slice(0, knowledgeSlots);

    const experiences = await this.system.experiences.findSimilar(query, {
      k: this.experiencePoolSize,
      domain: this.currentInstanceId,
      successOnly: true,
      ...(this.experienceMinScore !== undefined ? { minScore: this.experienceMinScore } : {}),
    });
    const allowedSessionIds = sessionIdsFromKnowledge(retainedKnowledge);
    const rankedExperiences = experiences.map((hit, index) => ({ ...hit, sourceRank: index + 1 }));
    const scopedExperiences =
      this.experienceScope === "knowledge-sessions" && allowedSessionIds.size > 0
        ? rankedExperiences.filter(({ experience }) => {
            const metadata = experience.metadata as Record<string, unknown>;
            return typeof metadata.sessionId === "string" && allowedSessionIds.has(metadata.sessionId);
          })
        : rankedExperiences;
    const experienceExcerpts = scopedExperiences.map(({ experience, score, sourceRank }): RetrievedExcerpt => {
      const metadata = experience.metadata as Record<string, unknown>;
      const turnIds = Array.isArray(metadata.turnIds)
        ? metadata.turnIds.filter((x): x is string => typeof x === "string")
        : undefined;
      return {
        ref: `${experience.id} [experience:${score.toFixed(3)}]`,
        text: excerptForQuery(experience.taskInput, query),
        channel: "experience",
        query,
        sourceRank,
        sourceScore: score,
        experienceId: experience.id,
        sessionId: typeof metadata.sessionId === "string" ? metadata.sessionId : undefined,
        turnIds,
        date: typeof metadata.date === "string" ? metadata.date : undefined,
        selectedBy: `experience-tail:${this.experienceGranularity}:${this.experienceScope}`,
      };
    });
    return [...retainedKnowledge, ...experienceExcerpts.slice(0, experienceSlots)];
  }

  async answer(question: MemQuestion): Promise<AnswerResult> {
    const excerpts = await this.retrieve(question);
    const res = await this.llm.chat([
      { role: "user", content: buildLongMemEvalAnswerPrompt(question.question, question.date, excerpts, question.category) },
    ]);
    return { answer: res.text.trim(), usage: res.usage, retrieved: excerpts };
  }

  async close(): Promise<void> {
    await this.system?.close();
    this.persistence?.close();
    this.system = null;
    this.persistence = null;
    await closeBank(this.state);
    this.state = null;
    this.currentInstanceId = null;
  }
}

export class CogcoreLiveLongMemEvalAdapter {
  readonly name: CogcoreLiveLongMemEvalArm;
  private readonly topK: number;
  private readonly scratchRoot: string;
  private readonly embeddings: Embeddings;
  private readonly extractConcurrency: number;
  private readonly cache: boolean;
  private readonly cacheDir: string;
  private readonly keywordExpansion: boolean;
  private readonly mmr?: MmrConfig;
  private readonly experienceGranularity: ExperienceGranularity;
  private readonly experienceChunkTurns: number;
  private readonly experienceEmbedding: ExperienceEmbedding;
  private readonly experienceScope: ExperienceScope;
  private readonly experiencePoolSize: number;
  private readonly chunkTurnCount: number;
  private readonly maxFactsPerChunk: number;
  private readonly liveToolQueries: number;
  private readonly liveToolPolicy: LiveToolPolicy;
  private readonly liveToolResults: number;
  private readonly observationMemory: ObservationMemoryMode;
  private readonly observationCacheDir: string;
  private readonly observationSource: ObservationExtractionSource;
  private readonly observationContext: ObservationContextMode;
  private readonly observationLogMaxChars: number;
  private readonly observationMaxPerChunk: number;
  private readonly observationSlots: number;
  private readonly onProgress?: (message: string) => void;
  private atlas: Atlas | null = null;
  private state: CogcoreState | null = null;
  private toolExecutor: MemoryToolExecutor | null = null;
  private currentInstanceId: string | null = null;
  private lastInjectedMemory: MemoryQueryResultV2 | undefined;
  private lastScopedKnowledge: KnowledgeMatch[] = [];
  private lastObservationKnowledge: KnowledgeMatch[] = [];
  private lastObservationLogContext = "";
  private lastFormattedKnowledge = "";
  private lastInjectedExperienceCount = 0;
  private lastInjectedPlaybookCount = 0;

  constructor(private readonly llm: LlmClient, name: CogcoreLiveLongMemEvalArm, opts: CogcoreLongMemEvalOptions = {}) {
    this.name = name;
    this.topK = opts.topK ?? 16;
    this.scratchRoot = opts.scratchRoot ?? defaultScratchRoot();
    this.embeddings = opts.embeddings ?? "local";
    this.extractConcurrency = opts.extractConcurrency ?? 2;
    this.cache = opts.cache ?? true;
    this.cacheDir = opts.cacheDir ?? path.resolve("evals/longmemeval/.cache/cogcore-extractions");
    this.keywordExpansion = opts.keywordExpansion ?? false;
    this.mmr = opts.mmr;
    this.experienceGranularity = opts.experienceGranularity ?? "chunk";
    this.experienceChunkTurns = opts.experienceChunkTurns ?? DEFAULT_EXPERIENCE_CHUNK_TURNS;
    this.experienceEmbedding = opts.experienceEmbedding ?? "hash";
    this.experienceScope = opts.experienceScope ?? "knowledge-sessions";
    this.experiencePoolSize = opts.experiencePoolSize ?? Math.max(this.topK, 64);
    this.chunkTurnCount = opts.chunkTurns ?? DEFAULT_CHUNK_TURNS;
    this.maxFactsPerChunk = opts.maxFactsPerChunk ?? DEFAULT_MAX_FACTS_PER_CHUNK;
    this.liveToolQueries = opts.liveToolQueries ?? 2;
    this.liveToolPolicy = opts.liveToolPolicy ?? "auto";
    this.liveToolResults = opts.liveToolResults ?? Math.min(8, this.topK);
    this.observationMemory = opts.observationMemory ?? "off";
    this.observationCacheDir = opts.observationCacheDir ?? path.resolve("evals/longmemeval/.cache/cogcore-observations");
    this.observationSource = opts.observationSource ?? DEFAULT_OBSERVATION_SOURCE;
    this.observationContext = opts.observationContext ?? DEFAULT_OBSERVATION_CONTEXT;
    this.observationLogMaxChars = opts.observationLogMaxChars ?? DEFAULT_OBSERVATION_LOG_MAX_CHARS;
    this.observationMaxPerChunk = opts.observationMaxPerChunk ?? DEFAULT_OBSERVATION_MAX_PER_CHUNK;
    this.observationSlots = opts.observationSlots ?? DEFAULT_OBSERVATION_SLOTS;
    this.onProgress = opts.onProgress;
  }

  private keywordHook(): ((prompt: string) => Promise<string>) | undefined {
    if (!this.keywordExpansion) return undefined;
    return async (prompt: string) => (await this.llm.chat([{ role: "user", content: prompt }])).text;
  }

  private cachePath(instanceId: string): string {
    return path.join(this.cacheDir, `${safeFileName(instanceId)}.json`);
  }

  private observationCachePath(instanceId: string): string {
    const sourceSuffix = this.observationSource === "chunks" ? "" : `.${this.observationSource}`;
    return path.join(this.observationCacheDir, `${safeFileName(instanceId)}${sourceSuffix}.json`);
  }

  private async loadCache(instanceId: string): Promise<ExtractedFact[] | null> {
    if (!this.cache) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(this.cachePath(instanceId), "utf-8")) as ExtractionCache;
      if (
        parsed.version === COGCORE_EXTRACTION_CACHE_VERSION &&
        parsed.instanceId === instanceId &&
        parsed.chunkTurns === this.chunkTurnCount &&
        parsed.maxFactsPerChunk === this.maxFactsPerChunk
      ) {
        return parsed.facts;
      }
    } catch {
      // Cache miss.
    }
    return null;
  }

  private async saveCache(instanceId: string, facts: ExtractedFact[]): Promise<void> {
    if (!this.cache) return;
    const payload: ExtractionCache = {
      version: COGCORE_EXTRACTION_CACHE_VERSION,
      instanceId,
      chunkTurns: this.chunkTurnCount,
      maxFactsPerChunk: this.maxFactsPerChunk,
      facts,
    };
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.writeFile(this.cachePath(instanceId), JSON.stringify(payload), "utf-8");
  }

  private async loadObservationCache(instanceId: string): Promise<ExtractedObservation[] | null> {
    if (!this.cache || this.observationMemory === "off") return null;
    try {
      const parsed = JSON.parse(await fs.readFile(this.observationCachePath(instanceId), "utf-8")) as ObservationCache;
      if (
        parsed.version === COGCORE_OBSERVATION_CACHE_VERSION &&
        parsed.instanceId === instanceId &&
        parsed.chunkTurns === this.chunkTurnCount &&
        parsed.maxObservationsPerChunk === this.observationMaxPerChunk &&
        (parsed.source ?? "chunks") === this.observationSource
      ) {
        return parsed.observations;
      }
    } catch {
      // Cache miss.
    }
    return null;
  }

  private async saveObservationCache(instanceId: string, observations: ExtractedObservation[]): Promise<void> {
    if (!this.cache || this.observationMemory === "off") return;
    const payload: ObservationCache = {
      version: COGCORE_OBSERVATION_CACHE_VERSION,
      instanceId,
      chunkTurns: this.chunkTurnCount,
      maxObservationsPerChunk: this.observationMaxPerChunk,
      source: this.observationSource,
      observations,
    };
    await fs.mkdir(this.observationCacheDir, { recursive: true });
    await fs.writeFile(this.observationCachePath(instanceId), JSON.stringify(payload), "utf-8");
  }

  private async openAtlas(instanceId: string): Promise<CogcoreState> {
    const dir = await fs.mkdtemp(path.join(this.scratchRoot, "lme-ccl-"));
    const baseDir = path.join(dir, "atlas");
    const config = {
      storage: { baseDir },
      memory: {
        maxExperiences: this.topK,
        maxStrategies: 0,
        maxSkills: 0,
        maxContextTokens: 16_000,
        seedMetaPlaybooks: false,
        seedMetaStrategies: false,
        proceduralMemory: {
          source: "sqlite",
          dir: "playbooks",
          strictStartup: false,
          pruneSqliteOnly: false,
          watch: false,
          structuralDualWrite: { enabled: false, dir: "playbooks" },
        },
      },
      knowledgeBank: { enabled: true, memoryDir: "memory", coherenceChecking: false },
      curatedPlaybooks: { loadBundledSeedPack: false },
      features: {
        reflexion: false,
        temporalCompression: true,
        dreamQueue: false,
        coherenceChecking: false,
      },
      execution: {
        defaultAgentType: "delegate",
        captureToolCalls: true,
        maxExecutionTime: 300,
      },
      refinement: {
        maxIterations: 0,
        useAgentEvaluation: false,
        triggerOnStrategies: [],
      },
    } as unknown as Partial<AtlasConfig>;
    const atlas = createAtlas(config);
    await atlas.init();
    atlas.setAgentManager([]);
    atlas.disableAgenticAnalysis();
    if (this.experienceEmbedding === "hash") {
      atlas.getMemory().experiences.setEmbeddingProvider(new HashEmbeddingProvider({ dimension: 512 }), { embedOnStore: true });
    }
    const kb = atlas.getKnowledgeBank();
    if (!kb) throw new Error("cogcore-live initialized without a KnowledgeBank");
    this.atlas = atlas;
    const memoryDir = path.join(baseDir, "memory");
    this.currentInstanceId = instanceId;
    return { dir, memoryDir, kb, mm: null };
  }

  private async addSessionExperiences(instance: MemQAInstance): Promise<number> {
    if (!this.atlas) return 0;
    let n = 0;
    for (const item of buildExperienceItems(instance, this.experienceGranularity, this.experienceChunkTurns)) {
      await this.atlas.getMemory().experiences.add(
        createExperience({
          id: item.id,
          taskInput: item.taskInput,
          solutionOutput: item.solutionOutput,
          feedback: "Imported user/assistant session as episodic memory.",
          success: true,
          domain: instance.id,
          trajectoryId: `${instance.id}:${item.sessionId}`,
          metadata: {
            instanceId: instance.id,
            sessionId: item.sessionId,
            date: item.date,
            kind: "longmemeval-session",
            granularity: this.experienceGranularity,
            turnIds: item.turnIds,
          },
        }),
      );
      n++;
    }
    return n;
  }

  private async extractFacts(instance: MemQAInstance, usage: UsageAccumulator): Promise<ExtractedFact[]> {
    const chunks = chunkTurns(flattenTurns(instance), this.chunkTurnCount).map((turns, index) => ({ turns, index }));
    this.onProgress?.(`extracting ${chunks.length} chunks for ${instance.id}`);
    const perChunk = await mapPool(chunks, this.extractConcurrency, async (chunk) => {
      const res = await this.llm.chat([
        { role: "user", content: buildExtractionPrompt(instance, chunk.turns, this.maxFactsPerChunk) },
      ]);
      addUsage(usage, res.usage);
      const parsed = parseFacts(res.text).slice(0, this.maxFactsPerChunk);
      this.onProgress?.(`chunk ${chunk.index + 1}/${chunks.length}: ${parsed.length} facts`);
      return parsed;
    });
    const facts = perChunk.flat();
    this.onProgress?.(`extracted ${facts.length} facts for ${instance.id}`);
    return facts;
  }

  private async extractCombinedMemories(instance: MemQAInstance, usage: UsageAccumulator): Promise<CombinedExtraction> {
    const chunks = chunkTurns(flattenTurns(instance), this.chunkTurnCount).map((turns, index) => ({ turns, index }));
    this.onProgress?.(`extracting ${chunks.length} combined fact+observation chunks for ${instance.id}`);
    const perChunk = await mapPool(chunks, this.extractConcurrency, async (chunk) => {
      let parsed: CombinedExtraction = { facts: [], observations: [] };
      for (let attempt = 0; attempt <= COMBINED_EMPTY_RETRIES; attempt++) {
        const res = await this.llm.chat([
          {
            role: "user",
            content: buildCombinedExtractionPrompt(
              instance,
              chunk.turns,
              this.maxFactsPerChunk,
              this.observationMaxPerChunk,
            ),
          },
        ]);
        addUsage(usage, res.usage);
        parsed = parseCombinedExtraction(res.text);
        if (parsed.facts.length > 0 || parsed.observations.length > 0) break;
        if (attempt < COMBINED_EMPTY_RETRIES) {
          this.onProgress?.(`combined chunk ${chunk.index + 1}/${chunks.length}: empty parse, retrying`);
        }
      }

      if (parsed.facts.length === 0 && parsed.observations.length === 0) {
        this.onProgress?.(`combined chunk ${chunk.index + 1}/${chunks.length}: empty after retry, falling back`);
        const [factRes, observationRes] = await Promise.all([
          this.llm.chat([{ role: "user", content: buildExtractionPrompt(instance, chunk.turns, this.maxFactsPerChunk) }]),
          this.llm.chat([
            { role: "user", content: buildObservationPrompt(instance, chunk.turns, this.observationMaxPerChunk) },
          ]),
        ]);
        addUsage(usage, factRes.usage);
        addUsage(usage, observationRes.usage);
        parsed = {
          facts: parseFacts(factRes.text),
          observations: parseObservations(observationRes.text),
        };
      }

      const facts = parsed.facts.slice(0, this.maxFactsPerChunk);
      const observations = parsed.observations.slice(0, this.observationMaxPerChunk);
      this.onProgress?.(
        `combined chunk ${chunk.index + 1}/${chunks.length}: ${facts.length} facts, ` +
          `${observations.length} observations`,
      );
      return { facts, observations };
    });
    const combined = {
      facts: perChunk.flatMap((chunk) => chunk.facts),
      observations: perChunk.flatMap((chunk) => chunk.observations),
    };
    this.onProgress?.(
      `extracted ${combined.facts.length} facts + ${combined.observations.length} observations for ${instance.id}`,
    );
    return combined;
  }

  private async loadOrExtractObservations(instance: MemQAInstance, usage: UsageAccumulator): Promise<ExtractedObservation[]> {
    if (this.observationMemory === "off") return [];
    let observations = await this.loadObservationCache(instance.id);
    if (observations) {
      this.onProgress?.(`observation cache hit for ${instance.id}: ${observations.length} observations`);
      return observations;
    }

    const chunks = chunkTurns(flattenTurns(instance), this.chunkTurnCount).map((turns, index) => ({ turns, index }));
    this.onProgress?.(`extracting ${chunks.length} observation chunks for ${instance.id}`);
    const perChunk = await mapPool(chunks, this.extractConcurrency, async (chunk) => {
      const res = await this.llm.chat([
        { role: "user", content: buildObservationPrompt(instance, chunk.turns, this.observationMaxPerChunk) },
      ]);
      addUsage(usage, res.usage);
      const parsed = parseObservations(res.text).slice(0, this.observationMaxPerChunk);
      this.onProgress?.(`observation chunk ${chunk.index + 1}/${chunks.length}: ${parsed.length} observations`);
      return parsed;
    });
    observations = perChunk.flat();
    await this.saveObservationCache(instance.id, observations);
    this.onProgress?.(`extracted ${observations.length} observations for ${instance.id}`);
    return observations;
  }

  private async addObservationKnowledge(instance: MemQAInstance, observations: ExtractedObservation[]): Promise<number> {
    if (!this.state || this.observationMemory === "off") return 0;
    let n = 0;
    for (const obs of observations) {
      const id = `o-${String(n).padStart(6, "0")}`;
      const sourceTurnIds = obs.turnIds.length > 0 ? obs.turnIds.join(", ") : "unknown";
      const body = [
        `Observation date: ${obs.date ?? "unknown"}`,
        `Observation type: ${obs.type}`,
        `Status: ${obs.status}`,
        `Statement: ${obs.statement}`,
        `Source turn ids: ${sourceTurnIds}`,
      ].join("\n");
      await this.state.kb.addObservation(
        createObservation({
          id,
          title: `observation-${String(n).padStart(6, "0")}`,
          body,
          domain: [instance.id],
          entities: obs.entities,
          tags: [
            "observation-memory",
            `observation-${obs.type}`,
            `status-${obs.status}`,
            ...obs.turnIds.map((turnId) => `turn-${safeFileName(turnId)}`),
          ],
          confidence: 0.82,
          source: { origin: "extracted" },
        }),
      );
      n++;
    }
    return n;
  }

  private async scopedInjectedMemory(question: MemQuestion): Promise<MemoryQueryResultV2> {
    if (!this.atlas || !this.currentInstanceId || !this.state) throw new Error("ingest() must run before answer()");
    const base = await this.atlas.queryMemory(question.question, {
      domains: [this.currentInstanceId],
      includeExperiences: false,
      includePlaybooks: false,
    });
    const experienceSlots = defaultSystemExperienceSlots(this.topK);
    if (experienceSlots <= 0) return { ...base, experiences: [] };

    const knowledgeSlots = Math.max(1, this.topK - experienceSlots);
    const scopedKnowledgeNotes = Math.min(MAX_SCOPED_SYSTEM_KNOWLEDGE_NOTES, Math.max(this.topK, knowledgeSlots * 2));
    const surfacedCandidates = (await this.state.kb.getRelevantKnowledge(
      { description: question.question, domain: this.currentInstanceId },
      { maxNotes: scopedKnowledgeNotes, maxTokens: MAX_KNOWLEDGE_TOKENS },
    )) as KnowledgeMatch[];
    const surfaced =
      this.observationMemory === "kb" && this.observationContext === "log"
        ? surfacedCandidates.filter((match) => !isObservationMemoryMatch(match))
        : surfacedCandidates;
    const observationKnowledge =
      this.observationMemory === "kb" && this.observationSlots > 0 && this.observationContext !== "log"
        ? selectObservationMatches(
            question,
            ((await this.state.kb.getRelevantKnowledge(
              {
                description:
                  `${question.question}\n` +
                  "Find a broad candidate set of compact chronological observation-memory notes. " +
                  "For spending questions include purchases, prices, dollar amounts, paid costs, and inventory. " +
                  "For temporal/order questions include all dated completed visit/event observations across different dates. " +
                  "For preference questions include durable preferences and latest state updates.",
                domain: this.currentInstanceId,
              },
              {
                maxNotes: Math.max(scopedKnowledgeNotes * 4, this.observationSlots * 12, 128),
                maxTokens: MAX_KNOWLEDGE_TOKENS,
              },
            )) as KnowledgeMatch[]).filter(isObservationMemoryMatch),
            this.observationSlots,
          )
        : [];
    this.lastObservationKnowledge = observationKnowledge;
    this.lastScopedKnowledge = mergeKnowledgeMatches(observationKnowledge, surfaced, scopedKnowledgeNotes);
    const sessionAnchorKnowledge = surfaced
      .map((m, index) => knowledgeToExcerpt(m, question.question, index, "scope-anchor-knowledge"));
    const sessionAnchorObservations = observationKnowledge.map((m, index) =>
      knowledgeToExcerpt(m, question.question, index, "scope-anchor-observation-knowledge"),
    );
    const allowedSessionIds = sessionIdsFromKnowledge([...sessionAnchorObservations, ...sessionAnchorKnowledge]);
    const rankedExperiences = (
      await this.atlas.getMemory().experiences.findSimilar(question.question, {
        k: this.experiencePoolSize,
        domain: this.currentInstanceId,
        successOnly: true,
      })
    ).map((hit, index) => ({ ...hit, sourceRank: index + 1 }));
    const scopedExperiences =
      this.experienceScope === "knowledge-sessions" && allowedSessionIds.size > 0
        ? rankedExperiences.filter(({ experience }) => {
            const metadata = (experience.metadata ?? {}) as Record<string, unknown>;
            return typeof metadata.sessionId === "string" && allowedSessionIds.has(metadata.sessionId);
          })
        : rankedExperiences;

    return { ...base, experiences: scopedExperiences.slice(0, experienceSlots) };
  }

  private scopedSystemPromptAdditions(): string | undefined {
    if (!this.state) return undefined;
    const sections: string[] = [];
    if (this.observationMemory === "kb" && this.observationContext !== "retrieved" && this.lastObservationLogContext) {
      sections.push(this.lastObservationLogContext);
    }
    if (this.lastScopedKnowledge.length > 0) {
      sections.push(
        [
          "## LongMemEval Memory Evidence",
          "Use these KnowledgeBank notes as primary past-memory evidence. Consider all relevant notes before answering. For latest-state or correction questions, prefer later user corrections over earlier assistant claims.",
          "",
          this.state.kb.formatKnowledgeForPrompt(this.lastScopedKnowledge, {
            maxTokens: MAX_KNOWLEDGE_TOKENS,
            includeEvidence: true,
            includeLinks: true,
          }),
        ].join("\n"),
      );
    }
    return sections.length > 0 ? sections.join("\n\n") : undefined;
  }

  private effectiveLiveToolQueries(question: MemQuestion): number {
    if (this.liveToolPolicy === "off") return 0;
    if (
      this.liveToolPolicy === "auto" &&
      this.observationMemory === "kb" &&
      (this.observationContext === "log" || this.observationContext === "both") &&
      question.category === "temporal-reasoning"
    ) {
      return 0;
    }
    return this.liveToolQueries;
  }

  async ingest(instance: MemQAInstance): Promise<UsageAccumulator> {
    await this.close();
    const started = Date.now();
    const usage: UsageAccumulator = { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: 0 };
    const state = await this.openAtlas(instance.id);
    this.state = state;

    let facts = await this.loadCache(instance.id);
    let observations: ExtractedObservation[] | null = null;
    const useCombinedObservations = this.observationMemory !== "off" && this.observationSource === "combined";
    if (useCombinedObservations) {
      observations = await this.loadObservationCache(instance.id);
      if (observations) {
        this.onProgress?.(`combined observation cache hit for ${instance.id}: ${observations.length} observations`);
      }
    }

    if (!facts) {
      if (useCombinedObservations && !observations) {
        const combined = await this.extractCombinedMemories(instance, usage);
        facts = combined.facts;
        observations = combined.observations;
        await this.saveObservationCache(instance.id, observations);
      } else {
        facts = await this.extractFacts(instance, usage);
      }
      await this.saveCache(instance.id, facts);
    } else {
      this.onProgress?.(`cache hit for ${instance.id}: ${facts.length} facts`);
    }

    if (useCombinedObservations && !observations) {
      const combined = await this.extractCombinedMemories(instance, usage);
      observations = combined.observations;
      await this.saveObservationCache(instance.id, observations);
    }

    let n = 0;
    for (const fact of facts) {
      await state.kb.addObservation(
        createObservation({
          id: `k-${String(n).padStart(6, "0")}`,
          title: `fact-${String(n).padStart(6, "0")}`,
          body: fact.fact,
          domain: [instance.id],
          entities: fact.entities,
          tags: ["extracted"],
          confidence: 0.8,
          source: { origin: "extracted" },
        }),
      );
      n++;
    }

    let r = 0;
    for (const turn of flattenTurns(instance)) {
      const when = turn.date ? `[${turn.date}] ` : "";
      await state.kb.addObservation(
        createObservation({
          id: `t-${String(r).padStart(6, "0")}`,
          title: turn.id,
          body: `${when}${turn.speaker}: ${turn.text}`,
          domain: [instance.id],
          entities: [],
          tags: [`session-${turn.sessionId}`, "raw-turn"],
          confidence: 0.7,
          source: { origin: "imported" },
        }),
      );
      r++;
    }

    const observationsToWrite = useCombinedObservations
      ? (observations ?? [])
      : await this.loadOrExtractObservations(instance, usage);
    this.lastObservationLogContext =
      this.observationMemory === "kb" && this.observationContext !== "retrieved"
        ? formatObservationLogContext(observationsToWrite, this.observationLogMaxChars)
        : "";
    const observationCount = await this.addObservationKnowledge(instance, observationsToWrite);
    const sessionCount = await this.addSessionExperiences(instance);
    this.onProgress?.(
      `indexing ${facts.length} extracted facts + raw turns + ${observationCount} observations + ` +
        `${sessionCount} ${this.experienceGranularity} experiences for ${instance.id}`,
    );
    await state.kb.defragment();
    await indexAndInject(state, this.embeddings, this.topK, this.keywordHook(), this.mmr);
    if (state.mm) {
      this.toolExecutor = new MemoryToolExecutor({ minimem: state.mm, memoryDir: state.memoryDir, name: instance.id });
    }
    usage.latencyMs += Date.now() - started;
    return usage;
  }

  async retrieve(question: MemQuestion): Promise<RetrievedExcerpt[]> {
    if (!this.atlas || !this.currentInstanceId) throw new Error("ingest() must run before retrieve()");
    const injected = await this.scopedInjectedMemory(question);
    const knowledge = (injected.knowledge ?? []).map((m, index) =>
      knowledgeToExcerpt(m, question.question, index, "atlas-queryv2-knowledge"),
    );
    const experienceExcerpts = injectedMemoryToExcerpts(
      injected,
      question.question,
      defaultSystemExperienceSlots(this.topK),
      `atlas-scoped-experience:${this.experienceGranularity}:${this.experienceScope}`,
    );
    return [...knowledge, ...experienceExcerpts].slice(0, this.topK);
  }

  async answer(question: MemQuestion): Promise<AnswerResult> {
    if (!this.atlas || !this.state || !this.currentInstanceId) throw new Error("ingest() must run before answer()");
    this.lastInjectedMemory = undefined;
    this.lastScopedKnowledge = [];
    this.lastObservationKnowledge = [];
    this.lastFormattedKnowledge = "";
    this.lastInjectedExperienceCount = 0;
    this.lastInjectedPlaybookCount = 0;
    const effectiveLiveToolQueries = this.effectiveLiveToolQueries(question);
    const delegate = new LongMemEvalLiveDelegate(
      this.llm,
      question,
      this.toolExecutor,
      effectiveLiveToolQueries,
      this.liveToolResults,
    );
    this.atlas.setDelegate(delegate);
    const injectedKnowledge = await this.scopedInjectedMemory(question);
    const systemPromptAdditions = this.scopedSystemPromptAdditions();
    this.atlas.getAgentManager()?.setDiagnosticsCollector((diag) => {
      this.lastInjectedMemory = diag.knowledge;
      this.lastFormattedKnowledge = diag.formattedKnowledge;
      this.lastInjectedExperienceCount = diag.experienceCount;
      this.lastInjectedPlaybookCount = diag.playbookCount;
    });

    const task = createTask({
      id: question.id,
      domain: this.currentInstanceId,
      description: question.question,
      context: {
        questionDate: question.date,
        category: question.category,
        benchmark: "LongMemEval_S",
      },
    });
    const result = await this.atlas.solve(task, {
      spawnConfig: {
        systemPromptAdditions,
        injectedKnowledge,
        diagnosticKnowledge: injectedKnowledge,
      },
    });
    this.atlas.getAgentManager()?.setDiagnosticsCollector(undefined);
    const surfacedKnowledge = result.surfacedKnowledge ?? [];
    const retrieved: RetrievedExcerpt[] = [];
    if (this.lastObservationLogContext) {
      retrieved.push({
        ref: "observation-log-context",
        text: excerptForQuery(this.lastObservationLogContext, question.question),
        channel: "knowledge",
        query: question.question,
        selectedBy: "atlas-observation-log-context",
      });
    }
    for (const [index, match] of this.lastScopedKnowledge.entries()) {
      retrieved.push(
        knowledgeToExcerpt(
          match,
          question.question,
          index,
          isObservationMemoryMatch(match)
            ? "atlas-scoped-observation-knowledge"
            : "atlas-scoped-system-knowledge",
        ),
      );
    }
    retrieved.push(
      ...injectedMemoryToExcerpts(
        this.lastInjectedMemory,
        question.question,
        this.lastInjectedExperienceCount,
        `atlas-scoped-injected-experience:${this.experienceGranularity}:${this.experienceScope}`,
      ),
    );
    for (const [index, tool] of delegate.toolCalls.entries()) {
      retrieved.push({
        ref: `tool:${tool.tool}:${index + 1}`,
        text: `Query: ${tool.query}\n${tool.output || tool.error || ""}`,
        channel: "tool",
        query: tool.query,
        sourceRank: index + 1,
        selectedBy: `live-tool:${tool.tool}`,
      });
    }

    const injectedMemory = this.lastInjectedMemory as MemoryQueryResultV2 | undefined;
    return {
      answer: String(result.trajectory.outcome.solution ?? "").trim(),
      usage: delegate.usage,
      retrieved,
      liveTrace: {
        systemContextChars: delegate.systemContextChars,
        formattedKnowledgeChars: this.lastFormattedKnowledge.length,
        injectedExperienceCount: this.lastInjectedExperienceCount,
        injectedPlaybookCount: this.lastInjectedPlaybookCount,
        queryV2KnowledgeCount: injectedMemory?.knowledge?.length ?? 0,
        scopedSystemKnowledgeCount: this.lastScopedKnowledge.length,
        surfacedKnowledgeCount: surfacedKnowledge.length,
        observationKnowledgeCount: this.lastObservationKnowledge.length,
        observationContext: this.observationContext,
        observationLogContextChars: this.lastObservationLogContext.length,
        liveToolPolicy: this.liveToolPolicy,
        effectiveLiveToolQueries,
        toolCalls: delegate.toolCalls,
      },
    };
  }

  async close(): Promise<void> {
    const state = this.state;
    this.state = null;
    this.toolExecutor = null;
    this.lastInjectedMemory = undefined;
    this.lastScopedKnowledge = [];
    this.lastObservationKnowledge = [];
    this.lastObservationLogContext = "";
    this.lastFormattedKnowledge = "";
    this.lastInjectedExperienceCount = 0;
    this.lastInjectedPlaybookCount = 0;
    await this.atlas?.close();
    this.atlas = null;
    await closeBank(state);
    this.currentInstanceId = null;
  }
}
