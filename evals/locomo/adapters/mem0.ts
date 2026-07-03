/**
 * `mem0` arm — the external memory-system baseline (competitor).
 *
 * Uses mem0's open-source self-hosted `Memory` class (`mem0ai/oss`). To keep the
 * fight fair, mem0 runs on the SAME base LLM as every other arm (Azure GPT-5.5)
 * for its extraction/update pipeline, and its retrieved memories are handed to
 * the SAME answer prompt + model we use elsewhere. Only the memory layer differs.
 *
 * Embeddings: mem0 needs its own embedder and there is no hosted embedding key
 * available, so it uses a local Ollama model (`nomic-embed-text`, 768-dim) via
 * the container started by the harness. The vector store is mem0's in-process
 * `memory` store (no external DB).
 *
 * Cost caveat: mem0's ingest-time extraction runs through mem0's own OpenAI
 * client, which does not surface token usage to us — so ingest tokens are NOT
 * captured here (latency is). Answer + judge tokens ARE captured (shared
 * LlmClient), so the per-question answer cost is directly comparable.
 */

import { Memory } from "mem0ai/oss";

import { buildAnswerPrompt, type RetrievedExcerpt } from "../judge.js";
import type {
  LocomoConversation,
  LocomoQuestion,
  LocomoSession,
  MemorySystemAdapter,
  UsageStats,
} from "../types.js";
import type { LlmClient } from "../llm.js";

export interface Mem0Options {
  /** Memories retrieved per question. */
  topK?: number;
  /** Ollama base URL for the embedder. */
  ollamaUrl?: string;
  /** Ollama embedding model. */
  embedModel?: string;
  /** Embedding dimensionality (must match the model). */
  embedDims?: number;
}

/** Build the mem0 self-hosted config from Azure env + local Ollama. */
function buildMem0Config(opts: Required<Pick<Mem0Options, "ollamaUrl" | "embedModel" | "embedDims">>) {
  const base = process.env.AZURE_API_BASE;
  const apiKey = process.env.AZURE_API_KEY;
  const apiVersion = process.env.AZURE_API_VERSION;
  const deployment = process.env.AZURE_DEPLOYMENT ?? "gpt-5.5";
  if (!base) throw new Error("AZURE_API_BASE is not set");
  if (!apiKey) throw new Error("AZURE_API_KEY is not set");
  if (!apiVersion) throw new Error("AZURE_API_VERSION is not set");

  return {
    llm: {
      provider: "azure_openai",
      config: {
        apiKey,
        model: deployment,
        // mem0's Azure LLM does NOT send max_tokens/temperature, so GPT-5.5's
        // reasoning-model constraints are respected as-is.
        modelProperties: {
          endpoint: base.replace(/\/$/, ""),
          deployment,
          apiVersion,
        },
      },
    },
    embedder: {
      provider: "ollama",
      config: {
        model: opts.embedModel,
        url: opts.ollamaUrl,
        embeddingDims: opts.embedDims,
      },
    },
    vectorStore: {
      provider: "memory",
      config: { collectionName: "locomo", dimension: opts.embedDims },
    },
    disableHistory: true,
  };
}

export class Mem0Adapter implements MemorySystemAdapter {
  readonly name = "mem0";
  private readonly topK: number;
  private readonly llm: LlmClient;
  private readonly cfg: ReturnType<typeof buildMem0Config>;

  private memory: Memory | null = null;
  private userId = "";

  constructor(llm: LlmClient, opts?: Mem0Options) {
    this.llm = llm;
    this.topK = opts?.topK ?? 8;
    this.cfg = buildMem0Config({
      ollamaUrl: opts?.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434",
      embedModel: opts?.embedModel ?? "nomic-embed-text",
      embedDims: opts?.embedDims ?? 768,
    });
  }

  async ingest(conversation: LocomoConversation): Promise<UsageStats> {
    const started = Date.now();
    // Fresh in-process store per conversation.
    this.memory = new Memory(this.cfg as never);
    this.userId = `locomo-${conversation.sampleId}`;

    // Add one mem0 call per session so extraction context stays bounded and the
    // session date is available for temporal facts.
    for (const session of conversation.sessions) {
      const messages = sessionToMessages(conversation, session);
      if (messages.length === 0) continue;
      await this.memory.add(messages, {
        userId: this.userId,
        metadata: { session: session.index, date: session.dateTime },
      });
    }

    return { latencyMs: Date.now() - started, totalTokens: 0 };
  }

  async answer(question: LocomoQuestion): Promise<{ text: string } & UsageStats> {
    if (!this.memory) throw new Error("ingest() must run before answer()");

    const res = await this.memory.search(question.question, {
      filters: { user_id: this.userId },
      topK: this.topK,
    });

    const excerpts: RetrievedExcerpt[] = res.results.map((r) => ({
      ref: typeof r.metadata?.date === "string" ? r.metadata.date : r.id,
      text: r.memory,
    }));

    const prompt = buildAnswerPrompt(question, excerpts);
    const { text, usage } = await this.llm.chat([{ role: "user", content: prompt }]);
    return { text: text.trim(), ...usage };
  }

  async reset(): Promise<void> {
    this.memory = null;
    this.userId = "";
  }

  async close(): Promise<void> {
    this.memory = null;
  }
}

/** Map a LOCOMO session to mem0 chat messages (speaker A → user, B → assistant). */
function sessionToMessages(
  conversation: LocomoConversation,
  session: LocomoSession,
): { role: "user" | "assistant"; content: string }[] {
  const messages: { role: "user" | "assistant"; content: string }[] = [];
  for (const turn of session.turns) {
    const text = turn.imageCaption
      ? `${turn.text} [shared image: ${turn.imageCaption}]`
      : turn.text;
    if (!text || !text.trim()) continue;
    const role: "user" | "assistant" =
      turn.speaker === conversation.speakerA ? "user" : "assistant";
    messages.push({
      role,
      content: `${turn.speaker} (on ${session.dateTime}): ${text}`,
    });
  }
  return messages;
}
