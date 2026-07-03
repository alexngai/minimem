/**
 * `cogcore-retrieval` arm — cognitive-core's KnowledgeBank over raw turns,
 * retrieved through OUR minimem (injected as the SearchProvider).
 *
 * No LLM extraction at ingest: each turn becomes a cognitive-core observation
 * note. Difference vs `minimem-alone`: cogcore's 3-tier retrieval
 * (domain/entity/semantic) and note structure, plus optional embeddings via
 * minimem hybrid. This is the middle rung of the ladder:
 *
 *   minimem-alone (BM25) → cogcore-retrieval (structured + hybrid) → cogcore-memory (extraction)
 *
 * cognitive-core is used memory-only: no PlaybookLibrary, no learning pipeline.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KnowledgeBank, MinimemSearchProvider } from "cognitive-core/memory";
import { createObservation, KnowledgeBankConfigSchema } from "cognitive-core";

import { Minimem } from "../../../src/index.js";
import { buildAnswerPrompt, type RetrievedExcerpt } from "../judge.js";
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
  embeddings?: "local" | "none";
}

export class CogcoreRetrievalAdapter implements MemorySystemAdapter {
  readonly name = "cogcore-retrieval";
  private readonly topK: number;
  private readonly scratchRoot: string;
  private readonly embeddings: "local" | "none";
  private readonly llm: LlmClient;

  private dir: string | null = null;
  private kb: InstanceType<typeof KnowledgeBank> | null = null;
  private mm: Minimem | null = null;

  constructor(llm: LlmClient, opts?: CogcoreRetrievalOptions) {
    this.llm = llm;
    this.topK = opts?.topK ?? 8;
    this.scratchRoot = opts?.scratchRoot ?? os.tmpdir();
    this.embeddings = opts?.embeddings ?? "local";
  }

  async ingest(conversation: LocomoConversation): Promise<UsageStats> {
    const started = Date.now();
    const dir = await fs.mkdtemp(path.join(this.scratchRoot, "locomo-ccr-"));
    this.dir = dir;
    const memoryDir = path.join(dir, "memory");

    const cfg = KnowledgeBankConfigSchema.parse({ enabled: true });
    const kb = new KnowledgeBank(memoryDir, cfg);
    await kb.init();

    let n = 0;
    for (const session of conversation.sessions) {
      for (const turn of session.turns) {
        const when = session.dateTime ? `[${session.dateTime}] ` : "";
        const img = turn.imageCaption ? ` [shared image: ${turn.imageCaption}]` : "";
        await kb.addObservation(
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

    // Index the note files with OUR minimem and inject it as the search provider.
    this.mm = await Minimem.create({
      memoryDir,
      dbPath: path.join(dir, "index.db"),
      embedding: this.embeddings === "local" ? { provider: "local" } : { provider: "none" },
      hybrid:
        this.embeddings === "local"
          ? { enabled: true, fusion: "rrf" }
          : { enabled: true, vectorWeight: 0, textWeight: 1, ftsQueryMode: "or" },
      query: { maxResults: this.topK, minScore: 0 },
      watch: { enabled: false },
    });
    await this.mm.sync({ reason: "ingest" });

    const mm = this.mm;
    kb.setSearchProvider(
      new MinimemSearchProvider({
        search: (query, options) =>
          mm.search(query, { ...options, skipStaleCheck: true }),
      }),
    );
    this.kb = kb;

    return { latencyMs: Date.now() - started, totalTokens: 0 };
  }

  async answer(question: LocomoQuestion): Promise<{ text: string } & UsageStats> {
    if (!this.kb) throw new Error("ingest() must run before answer()");

    const matches = await this.kb.getRelevantKnowledge(
      { description: question.question, domain: undefined },
      { maxNotes: this.topK },
    );

    const excerpts: RetrievedExcerpt[] = matches.map((m) => ({
      ref: m.note.frontmatter.id,
      text: m.note.body ?? "",
    }));

    const prompt = buildAnswerPrompt(question, excerpts);
    const { text, usage } = await this.llm.chat([{ role: "user", content: prompt }]);
    return { text: text.trim(), ...usage };
  }

  async reset(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    await this.kb?.close?.();
    this.kb = null;
    this.mm?.close?.();
    this.mm = null;
    if (this.dir) {
      await fs.rm(this.dir, { recursive: true, force: true }).catch(() => {});
      this.dir = null;
    }
  }
}
