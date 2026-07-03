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

import { createObservation } from "cognitive-core";

import {
  answerFromBank,
  closeBank,
  defaultScratchRoot,
  indexAndInject,
  openBank,
  type CogcoreState,
  type Embeddings,
} from "./cogcore-shared.js";
import type {
  LocomoConversation,
  LocomoQuestion,
  LocomoSession,
  MemorySystemAdapter,
  UsageStats,
} from "../types.js";
import type { LlmClient } from "../llm.js";

export interface CogcoreMemoryOptions {
  topK?: number;
  scratchRoot?: string;
  embeddings?: Embeddings;
  /** Concurrent extraction calls during ingest. */
  extractConcurrency?: number;
}

interface ExtractedFact {
  fact: string;
  entities: string[];
}

function buildExtractionPrompt(
  conversation: LocomoConversation,
  session: LocomoSession,
): string {
  const transcript = session.turns
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
    "- Capture specifics: names, dates, numbers, preferences, plans, events, relationships, outcomes.",
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

/** Tolerant JSON-array parse: strips code fences, slices to the outermost [...]. */
function parseFacts(raw: string): ExtractedFact[] {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?/i, "").replace(/```$/,"").trim();
  const start = s.indexOf("[");
  const end = s.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return [];
  try {
    const parsed = JSON.parse(s.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) return [];
    const facts: ExtractedFact[] = [];
    for (const item of parsed) {
      if (item && typeof item === "object" && typeof (item as ExtractedFact).fact === "string") {
        const f = item as ExtractedFact;
        facts.push({
          fact: f.fact.trim(),
          entities: Array.isArray(f.entities)
            ? f.entities.filter((e) => typeof e === "string" && e.trim()).map((e) => e.trim())
            : [],
        });
      }
    }
    return facts;
  } catch {
    return [];
  }
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
  private readonly llm: LlmClient;
  private state: CogcoreState | null = null;

  constructor(llm: LlmClient, opts?: CogcoreMemoryOptions) {
    this.llm = llm;
    this.topK = opts?.topK ?? 8;
    this.scratchRoot = opts?.scratchRoot ?? defaultScratchRoot();
    this.embeddings = opts?.embeddings ?? "local";
    this.extractConcurrency = opts?.extractConcurrency ?? 4;
  }

  async ingest(conversation: LocomoConversation): Promise<UsageStats> {
    const started = Date.now();
    const state = await openBank(this.scratchRoot, "locomo-ccm-");
    this.state = state;

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;

    // Extract facts per session (concurrently), preserving session order.
    const perSession = await mapPool(conversation.sessions, this.extractConcurrency, async (session) => {
      const { text, usage } = await this.llm.chat([
        { role: "user", content: buildExtractionPrompt(conversation, session) },
      ]);
      promptTokens += usage.promptTokens;
      completionTokens += usage.completionTokens;
      totalTokens += usage.totalTokens;
      return { session, facts: parseFacts(text) };
    });

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

    // Heuristic consolidation → cross-session entity notes (no LLM).
    await state.kb.defragment();

    await indexAndInject(state, this.embeddings, this.topK);

    return { latencyMs: Date.now() - started, promptTokens, completionTokens, totalTokens };
  }

  async answer(question: LocomoQuestion): Promise<{ text: string } & UsageStats> {
    if (!this.state) throw new Error("ingest() must run before answer()");
    return answerFromBank(this.state, this.llm, question, this.topK);
  }

  async reset(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    await closeBank(this.state);
    this.state = null;
  }
}
