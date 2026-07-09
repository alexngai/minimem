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
  KnowledgeBankConfigSchema,
  createExperience,
  createMemorySystem,
  createObservation,
  createSqlitePersistence,
  type MemorySystem,
  type SqlitePersistence,
} from "cognitive-core";
import { HashEmbeddingProvider } from "cognitive-core/embeddings";
import { createLlmMemoryEvolver, type MemoryEvolutionPlan } from "cognitive-core/memory";
import type { MemQAInstance, MemQuestion } from "swarmkit-eval";

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

export type ExperienceGranularity = "session" | "chunk" | "turn";
export type ExperienceEmbedding = "none" | "hash";
export type ExperienceScope = "knowledge-sessions" | "all";

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

export interface RetrievedExcerpt {
  ref: string;
  text: string;
  channel?: "knowledge" | "experience";
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

export interface AnswerResult {
  answer: string;
  usage: LlmUsage;
  retrieved: RetrievedExcerpt[];
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

export const COGCORE_EXTRACTION_CACHE_VERSION = 3;
const DEFAULT_CHUNK_TURNS = 40;
const DEFAULT_MAX_FACTS_PER_CHUNK = 60;
const DEFAULT_EXPERIENCE_CHUNK_TURNS = 8;
const MAX_EXCERPT_CHARS = 1200;
const MAX_KNOWLEDGE_TOKENS = 1_000_000;

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

function sessionIdsFromKnowledge(excerpts: RetrievedExcerpt[]): Set<string> {
  const out = new Set<string>();
  for (const excerpt of excerpts) {
    const match = /#\s+([^\s:]+(?::[^\s:]+)*):\d+/.exec(excerpt.text);
    if (match?.[1]) out.add(match[1]);
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
        this.experienceGranularity === "turn"
          ? turns.map((turn, index) => ({ turns: [turn], label: `turn ${index + 1}` }))
          : this.experienceGranularity === "chunk"
            ? chunkArray(turns, this.experienceChunkTurns).map((chunk, index) => ({
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
        const idSuffix = this.experienceGranularity === "session" ? session.id : `${session.id}-${chunk.label}`;
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
      { role: "user", content: buildLongMemEvalAnswerPrompt(question.question, question.date, excerpts) },
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
