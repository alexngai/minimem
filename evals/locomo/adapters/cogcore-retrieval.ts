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
} from "./cogcore-shared.js";
import type {
  LocomoConversation,
  LocomoQuestion,
  MemorySystemAdapter,
  UsageStats,
} from "../types.js";
import type { LlmClient } from "../llm.js";

export interface CogcoreRetrievalOptions {
  topK?: number;
  scratchRoot?: string;
  /** "local" enables minimem hybrid (BM25 + local embeddings); "none" = BM25. */
  embeddings?: Embeddings;
}

export class CogcoreRetrievalAdapter implements MemorySystemAdapter {
  readonly name = "cogcore-retrieval";
  protected readonly topK: number;
  protected readonly scratchRoot: string;
  protected readonly embeddings: Embeddings;
  protected readonly llm: LlmClient;
  protected state: CogcoreState | null = null;

  constructor(llm: LlmClient, opts?: CogcoreRetrievalOptions) {
    this.llm = llm;
    this.topK = opts?.topK ?? 8;
    this.scratchRoot = opts?.scratchRoot ?? defaultScratchRoot();
    this.embeddings = opts?.embeddings ?? "local";
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

    await indexAndInject(state, this.embeddings, this.topK);
    return { latencyMs: Date.now() - started, totalTokens: 0 };
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
