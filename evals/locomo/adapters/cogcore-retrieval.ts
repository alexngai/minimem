/**
 * `cogcore-retrieval` arm — cognitive-core's KnowledgeBank over raw turns,
 * retrieved through OUR minimem (injected as the SearchProvider).
 *
 * No LLM extraction at ingest: each turn becomes a cognitive-core observation
 * note. Difference vs `minimem-alone`: cogcore's 3-tier retrieval
 * (domain/entity/semantic) and note structure, plus optional embeddings via
 * minimem hybrid. Middle rung of the ladder:
 *
 *   minimem-alone (BM25) → cogcore-retrieval (structured + hybrid) → cogcore-memory (extraction)
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
  type MmrConfig,
} from "./cogcore-shared.js";
import type {
  AnswerResult,
  LocomoConversation,
  LocomoQuestion,
  MemorySystemAdapter,
  UsageStats,
} from "../types.js";
import type { LlmClient } from "../llm.js";

export interface CogcoreRetrievalOptions {
  topK?: number;
  scratchRoot?: string;
  /** "local" = minimem hybrid; "nomic" = Ollama nomic-embed-text; "none" = BM25. */
  embeddings?: Embeddings;
  /** Distill each question to keywords via the LLM before retrieval. */
  keywordExpansion?: boolean;
  /** MMR diversity re-rank over a wide candidate pool (undefined = disabled). */
  mmr?: MmrConfig;
}

export class CogcoreRetrievalAdapter implements MemorySystemAdapter {
  readonly name = "cogcore-retrieval";
  protected readonly topK: number;
  protected readonly scratchRoot: string;
  protected readonly embeddings: Embeddings;
  protected readonly keywordExpansion: boolean;
  protected readonly mmr?: MmrConfig;
  protected readonly llm: LlmClient;
  protected state: CogcoreState | null = null;

  constructor(llm: LlmClient, opts?: CogcoreRetrievalOptions) {
    this.llm = llm;
    this.topK = opts?.topK ?? 10;
    this.scratchRoot = opts?.scratchRoot ?? defaultScratchRoot();
    this.embeddings = opts?.embeddings ?? "local";
    this.keywordExpansion = opts?.keywordExpansion ?? false;
    this.mmr = opts?.mmr;
  }

  /** LLM hook for keyword expansion (returns only the completion text). */
  protected keywordHook(): ((prompt: string) => Promise<string>) | undefined {
    if (!this.keywordExpansion) return undefined;
    return async (prompt: string) => (await this.llm.chat([{ role: "user", content: prompt }])).text;
  }

  async ingest(conversation: LocomoConversation): Promise<UsageStats> {
    const started = Date.now();
    const state = await openBank(this.scratchRoot, "locomo-ccr-");
    this.state = state;

    let n = 0;
    for (const session of conversation.sessions) {
      for (const turn of session.turns) {
        const when = session.dateTime ? `[${session.dateTime}] ` : "";
        const img = turn.imageCaption ? ` [shared image: ${turn.imageCaption}]` : "";
        await state.kb.addObservation(
          createObservation({
            id: `k-${String(n).padStart(5, "0")}`,
            title: turn.diaId,
            body: `${when}${turn.speaker}: ${turn.text}${img}`,
            domain: [conversation.sampleId],
            entities: [],
            tags: [`session-${session.index}`],
            confidence: 0.8,
            source: { origin: "imported" },
          }),
        );
        n++;
      }
    }

    await indexAndInject(state, this.embeddings, this.topK, this.keywordHook(), this.mmr);
    return { latencyMs: Date.now() - started, totalTokens: 0 };
  }

  async answer(question: LocomoQuestion): Promise<AnswerResult> {
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
