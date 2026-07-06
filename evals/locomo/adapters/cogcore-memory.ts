/**
 * `cogcore-memory` arm — the extraction rung (the product story).
 *
 * At ingest, GPT-5.5 reads each session and extracts durable, entity-tagged
 * facts. These are stored as cognitive-core observations, then the heuristic
 * `defragment()` consolidates them into cross-session ENTITY notes. At answer
 * time, cognitive-core's 3-tier retrieval surfaces the matching entity's
 * accumulated facts — the mechanism that should lift multi-hop off the
 * retrieval-only floor.
 *
 * cognitive-core is used memory-only: no playbooks, no learning pipeline. The
 * same base LLM (GPT-5.5) does extraction here and answering everywhere, so the
 * comparison stays fair.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { createObservation } from "cognitive-core";
import { createLlmMemoryEvolver, type MemoryEvolutionPlan } from "cognitive-core/memory";

import {
  answerFromBank,
  answerFromBankMultiQuery,
  closeBank,
  defaultScratchRoot,
  indexAndInject,
  openBank,
  type CogcoreState,
  type Embeddings,
  type MmrConfig,
} from "./cogcore-shared.js";
import type {
  AnswerResult,
  LocomoConversation,
  LocomoQuestion,
  LocomoSession,
  MemorySystemAdapter,
  UsageStats,
} from "../types.js";
import { LlmClient } from "../llm.js";

export interface CogcoreMemoryOptions {
  topK?: number;
  scratchRoot?: string;
  embeddings?: Embeddings;
  /** Concurrent extraction calls during ingest. */
  extractConcurrency?: number;
  /**
   * Cache LLM-extracted facts to disk keyed by sampleId (WS0). Makes ingest
   * deterministic and free on re-runs, so answer/consolidation/retrieval changes
   * can be A/B'd without extraction variance. Default: true.
   */
  cache?: boolean;
  /** Directory for the extraction cache. */
  cacheDir?: string;
  /** Distill each question to keywords via the LLM before retrieval. */
  keywordExpansion?: boolean;
  /** MMR diversity re-rank over a wide candidate pool (undefined = disabled). */
  mmr?: MmrConfig;
  /**
   * Also index the raw conversation turns alongside extracted facts (hybrid).
   * Extraction summarizes away answerable specifics (e.g. "made their own pots"
   * loses "a cup with a dog face"); keeping raw turns retrievable restores that
   * verbatim detail while facts still provide consolidated/temporal signal.
   */
  hybridRawTurns?: boolean;
  /**
   * Decompose each question into per-hop sub-queries, retrieve for each, and
   * interleave results so every hop is represented in the context. Targets the
   * multi_hop gap where single-query retrieval buries the second hop.
   */
  multiQuery?: boolean;
  /**
   * Run the agentic memory evolver at ingest (after extraction + defrag): an LLM
   * proposes merge/link/supersede actions over the extracted facts, applied via
   * cognitive-core's evolve() to pre-compute cross-fact structure for multi_hop.
   * Raw-turn observations are excluded from the evolver's snapshot (they remain
   * a retrievable detail floor).
   */
  evolve?: boolean;
}

interface ExtractedFact {
  fact: string;
  entities: string[];
}

/** Bump when the extraction prompt/format changes, to invalidate old caches.
 *  v2: preserve concrete modifiers/temporal phrasing/emotions + split enumerations.
 *  v3: chunk long sessions so extraction never truncates (GPT-5.5 reasoning tokens
 *      were blowing the 4096 completion budget on big sessions → empty output →
 *      zero-fact sessions). Plus salvage-parse of truncated JSON. */
const EXTRACTION_CACHE_VERSION = 3;

/** Max transcript turns per extraction call. Long sessions are split into
 *  windows so the JSON output (plus GPT-5.5 reasoning tokens) fits comfortably
 *  under max_completion_tokens. Small enough to stay thorough, large enough to
 *  keep local context (pronoun/topic resolution) intact. */
const CHUNK_TURNS = 10;

interface ExtractionCache {
  version: number;
  sampleId: string;
  /** Facts keyed by session.index. */
  sessions: Record<number, ExtractedFact[]>;
}

function buildExtractionPrompt(
  conversation: LocomoConversation,
  session: LocomoSession,
  turns: LocomoSession["turns"] = session.turns,
): string {
  const transcript = turns
    .map((t) => `${t.speaker}: ${t.text}${t.imageCaption ? ` [image: ${t.imageCaption}]` : ""}`)
    .join("\n");
  return [
    "You are building a long-term memory of a conversation between two people.",
    "Extract the durable, factual information from THIS session as a JSON array of atomic memories.",
    "",
    'Each item: {"fact": "<one self-contained fact in the third person; resolve pronouns to names; include the date/time when relevant>", "entities": ["<proper nouns: people, pets, places, orgs, named things>"]}',
    "",
    "Rules:",
    "- One fact per item; each fact must stand alone without the transcript.",
    "- PRESERVE CONCRETE SPECIFICS VERBATIM — do NOT paraphrase them away:",
    "    • descriptive modifiers/adjectives (e.g. 'a cup with a DOG FACE on it', not 'a pottery bowl');",
    "    • feelings, opinions, evaluations (e.g. 'in awe of the universe');",
    "    • exact quantities, names, and outcomes (e.g. 'got hurt and took a break', not just 'had a setback').",
    "- KEEP THE EXACT TEMPORAL PHRASING the speaker used ('the Friday before', 'since 2016', '10 years ago');",
    "  add the absolute date too when known, but never drop the original relative phrasing.",
    "- SPLIT ENUMERATIONS into separate items: 'pets Oliver, Luna, and Bailey' → three facts, one per pet;",
    "  'plays clarinet and violin' → two facts. Each list member must be independently retrievable.",
    "- Capture names, dates, numbers, preferences, plans, events, relationships, outcomes.",
    "- Skip pure greetings/pleasantries that carry no lasting information.",
    "- Prefer the speakers' names as entities where relevant.",
    "",
    `Session date: ${session.dateTime || "unknown"}`,
    `Speakers: ${conversation.speakerA}, ${conversation.speakerB}`,
    "",
    "Transcript:",
    transcript,
    "",
    "Return ONLY the JSON array, no prose.",
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

/**
 * Scan a string for top-level `{...}` objects, respecting string literals and
 * escapes, and parse each independently. Recovers facts from a JSON array that
 * was TRUNCATED mid-output (no closing `]`) — the failure that silently produced
 * zero-fact sessions before chunking.
 */
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

/** Tolerant JSON-array parse: strips code fences, tries a full array parse, then
 *  falls back to object-by-object salvage for truncated output. */
function parseFacts(raw: string): ExtractedFact[] {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(s.slice(start, end + 1)) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map(coerceFact).filter((f): f is ExtractedFact => f !== null);
      }
    } catch {
      // Fall through to salvage.
    }
  }
  return salvageObjects(start !== -1 ? s.slice(start) : s);
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class CogcoreMemoryAdapter implements MemorySystemAdapter {
  readonly name = "cogcore-memory";
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
  private readonly llm: LlmClient;
  private state: CogcoreState | null = null;

  constructor(llm: LlmClient, opts?: CogcoreMemoryOptions) {
    this.llm = llm;
    this.topK = opts?.topK ?? 10;
    this.scratchRoot = opts?.scratchRoot ?? defaultScratchRoot();
    this.embeddings = opts?.embeddings ?? "local";
    this.extractConcurrency = opts?.extractConcurrency ?? 4;
    this.cache = opts?.cache ?? true;
    this.cacheDir =
      opts?.cacheDir ?? path.resolve("evals/locomo/.cache/cogcore-extractions");
    this.keywordExpansion = opts?.keywordExpansion ?? false;
    this.mmr = opts?.mmr;
    this.hybridRawTurns = opts?.hybridRawTurns ?? false;
    this.multiQuery = opts?.multiQuery ?? false;
    this.evolveMemory = opts?.evolve ?? false;
  }

  /** LLM hook for keyword expansion (returns only the completion text). */
  private keywordHook(): ((prompt: string) => Promise<string>) | undefined {
    if (!this.keywordExpansion) return undefined;
    return async (prompt: string) => (await this.llm.chat([{ role: "user", content: prompt }])).text;
  }

  private cachePath(sampleId: string): string {
    return path.join(this.cacheDir, `${sampleId}.json`);
  }

  private async loadCache(sampleId: string): Promise<ExtractionCache | null> {
    if (!this.cache) return null;
    try {
      const raw = await fs.readFile(this.cachePath(sampleId), "utf-8");
      const parsed = JSON.parse(raw) as ExtractionCache;
      if (parsed.version === EXTRACTION_CACHE_VERSION && parsed.sampleId === sampleId) {
        return parsed;
      }
    } catch {
      // Miss or corrupt — re-extract.
    }
    return null;
  }

  private async saveCache(sampleId: string, sessions: Record<number, ExtractedFact[]>): Promise<void> {
    if (!this.cache) return;
    const payload: ExtractionCache = { version: EXTRACTION_CACHE_VERSION, sampleId, sessions };
    await fs.mkdir(this.cacheDir, { recursive: true });
    await fs.writeFile(this.cachePath(sampleId), JSON.stringify(payload), "utf-8");
  }

  private planPath(sampleId: string): string {
    return path.join(this.cacheDir, "..", "cogcore-evolve-plans", `${sampleId}.json`);
  }

  private async loadPlan(sampleId: string): Promise<MemoryEvolutionPlan | null> {
    if (!this.cache) return null;
    try {
      const raw = await fs.readFile(this.planPath(sampleId), "utf-8");
      const parsed = JSON.parse(raw) as { version: number; plan: MemoryEvolutionPlan };
      if (parsed.version === EXTRACTION_CACHE_VERSION) return parsed.plan;
    } catch {
      // Miss — re-evolve.
    }
    return null;
  }

  private async savePlan(sampleId: string, plan: MemoryEvolutionPlan): Promise<void> {
    if (!this.cache) return;
    const p = this.planPath(sampleId);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, JSON.stringify({ version: EXTRACTION_CACHE_VERSION, plan }), "utf-8");
  }

  async ingest(conversation: LocomoConversation): Promise<UsageStats> {
    const started = Date.now();
    const state = await openBank(this.scratchRoot, "locomo-ccm-");
    this.state = state;

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    // Extract facts per session — from cache when available (deterministic, free),
    // otherwise via GPT-5.5, then persist for future runs (WS0).
    const cached = await this.loadCache(conversation.sampleId);
    let perSession: Array<{ session: LocomoSession; facts: ExtractedFact[] }>;
    if (cached) {
      perSession = conversation.sessions.map((session) => ({
        session,
        facts: cached.sessions[session.index] ?? [],
      }));
    } else {
      // Split long sessions into bounded turn-windows so no single extraction
      // call truncates. Each chunk is extracted independently; facts are unioned
      // back per session (order preserved).
      const chunks: Array<{ index: number; turns: LocomoSession["turns"] }> = [];
      for (const session of conversation.sessions) {
        const t = session.turns;
        if (t.length <= CHUNK_TURNS) {
          chunks.push({ index: session.index, turns: t });
        } else {
          for (let i = 0; i < t.length; i += CHUNK_TURNS) {
            chunks.push({ index: session.index, turns: t.slice(i, i + CHUNK_TURNS) });
          }
        }
      }
      const sessionByIndex = new Map(conversation.sessions.map((s) => [s.index, s]));
      const chunkResults = await mapPool(chunks, this.extractConcurrency, async (chunk) => {
        const session = sessionByIndex.get(chunk.index)!;
        const { text, usage } = await this.llm.chat([
          { role: "user", content: buildExtractionPrompt(conversation, session, chunk.turns) },
        ]);
        promptTokens += usage.promptTokens;
        completionTokens += usage.completionTokens;
        totalTokens += usage.totalTokens;
        return { index: chunk.index, facts: parseFacts(text) };
      });
      const byIndex: Record<number, ExtractedFact[]> = {};
      for (const session of conversation.sessions) byIndex[session.index] = [];
      for (const { index, facts } of chunkResults) byIndex[index].push(...facts);
      perSession = conversation.sessions.map((session) => ({
        session,
        facts: byIndex[session.index],
      }));
      await this.saveCache(conversation.sampleId, byIndex);
    }

    // Store extracted facts as entity-tagged observations (serialized).
    let n = 0;
    for (const { session, facts } of perSession) {
      const when = session.dateTime ? `[${session.dateTime}] ` : "";
      for (const f of facts) {
        await state.kb.addObservation(
          createObservation({
            id: `k-${String(n).padStart(5, "0")}`,
            title: `session-${session.index}`,
            body: `${when}${f.fact}`,
            domain: [conversation.sampleId],
            entities: f.entities,
            tags: [`session-${session.index}`],
            confidence: 0.8,
            source: { origin: "extracted" },
          }),
        );
        n++;
      }
    }

    // Hybrid: also index raw turns so extraction's dropped specifics stay
    // retrievable (verbatim detail that facts summarize away).
    if (this.hybridRawTurns) {
      let r = 0;
      for (const session of conversation.sessions) {
        const when = session.dateTime ? `[${session.dateTime}] ` : "";
        for (const turn of session.turns) {
          const img = turn.imageCaption ? ` [shared image: ${turn.imageCaption}]` : "";
          await state.kb.addObservation(
            createObservation({
              id: `t-${String(r).padStart(5, "0")}`,
              title: turn.diaId,
              body: `${when}${turn.speaker}: ${turn.text}${img}`,
              domain: [conversation.sampleId],
              entities: [],
              tags: [`session-${session.index}`, "raw-turn"],
              confidence: 0.7,
              source: { origin: "imported" },
            }),
          );
          r++;
        }
      }
    }

    // Heuristic consolidation → cross-session entity notes (no LLM).
    await state.kb.defragment();

    // Agentic evolution: an LLM proposes merge/link/supersede over the extracted
    // facts (raw turns excluded from its view but kept as a detail floor),
    // pre-computing cross-fact structure so multi_hop answers from one lookup.
    if (this.evolveMemory) {
      // Cache the evolution plan (keyed by sampleId) so re-runs reuse a byte-
      // identical evolved bank — deterministic, LLM-free A/B of read-side changes
      // without re-extracting or re-evolving. Note ids are stable (padded ingest
      // order over cached facts), so a cached plan's references stay valid.
      let plan = await this.loadPlan(conversation.sampleId);
      if (!plan) {
        // Dedicated client with a large completion budget: the plan is a big JSON
        // doc and GPT-5.5's reasoning tokens count against the budget — 4096 gets
        // fully consumed by reasoning, yielding empty output. 16384 leaves room.
        const evolveLlm = new LlmClient({ maxCompletionTokens: 16384 });
        const evolver = createLlmMemoryEvolver(
          async (prompt: string) => {
            const { text, usage } = await evolveLlm.chat([{ role: "user", content: prompt }]);
            promptTokens += usage.promptTokens;
            completionTokens += usage.completionTokens;
            totalTokens += usage.totalTokens;
            return text;
          },
          { excludeTags: ["raw-turn"] },
        );
        plan = await evolver({
          notes: await state.kb.getAllNotes(),
          domains: await state.kb.listDomains(),
          entities: await state.kb.listEntities(),
        });
        await this.savePlan(conversation.sampleId, plan);
      }
      const evo = await state.kb.applyEvolutionPlan(plan);
      process.stderr.write(
        `[cogcore-evolve] ${conversation.sampleId}: merged=${evo.merged} linked=${evo.linked} superseded=${evo.superseded} skipped=${evo.skipped}\n`,
      );
    }

    await indexAndInject(state, this.embeddings, this.topK, this.keywordHook(), this.mmr);

    return { latencyMs: Date.now() - started, promptTokens, completionTokens, totalTokens };
  }

  async answer(question: LocomoQuestion): Promise<AnswerResult> {
    if (!this.state) throw new Error("ingest() must run before answer()");
    return this.multiQuery
      ? answerFromBankMultiQuery(this.state, this.llm, question, this.topK)
      : answerFromBank(this.state, this.llm, question, this.topK);
  }

  async reset(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    await closeBank(this.state);
    this.state = null;
  }
}
