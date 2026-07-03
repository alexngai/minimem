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
 * Cost: mem0's ingest-time extraction runs through mem0's own OpenAI client, so
 * we capture its token usage by injecting a counting `fetch` into the Azure
 * client (mem0 forwards `modelProperties` straight to `new AzureOpenAI(...)`,
 * and openai@4 accepts a custom `fetch`). Embeddings use the separate Ollama
 * client, so the counter sees ONLY Azure LLM (extraction) tokens. Answer + judge
 * tokens are captured via the shared LlmClient — so mem0's full cost (ingest +
 * answer) is directly comparable to the other arms.
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

/** Running token tally for mem0's internal (Azure) LLM calls. */
interface TokenSink {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  calls: number;
}

/**
 * A `fetch` that transparently accumulates OpenAI/Azure `usage` from chat
 * completion responses. Reads a clone so the SDK still consumes the body.
 */
function makeCountingFetch(sink: TokenSink): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const res = await fetch(input, init);
    res
      .clone()
      .json()
      .then((j) => {
        const u = (j as { usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } })
          ?.usage;
        if (!u) return;
        sink.promptTokens += u.prompt_tokens ?? 0;
        sink.completionTokens += u.completion_tokens ?? 0;
        sink.totalTokens += u.total_tokens ?? 0;
        sink.calls += 1;
      })
      .catch(() => {});
    return res;
  };
}

/** Build the mem0 self-hosted config from Azure env + local Ollama. */
function buildMem0Config(
  opts: Required<Pick<Mem0Options, "ollamaUrl" | "embedModel" | "embedDims">>,
  countingFetch: typeof fetch,
) {
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
          // Forwarded into `new AzureOpenAI(...)`; lets us tally extraction tokens.
          fetch: countingFetch,
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
  /** Accumulates mem0's internal (Azure) extraction tokens. */
  private readonly tokens: TokenSink = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };

  private memory: Memory | null = null;
  private userId = "";

  constructor(llm: LlmClient, opts?: Mem0Options) {
    this.llm = llm;
    this.topK = opts?.topK ?? 8;
    this.cfg = buildMem0Config(
      {
        ollamaUrl: opts?.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://localhost:11434",
        embedModel: opts?.embedModel ?? "nomic-embed-text",
        embedDims: opts?.embedDims ?? 768,
      },
      makeCountingFetch(this.tokens),
    );
  }

  async ingest(conversation: LocomoConversation): Promise<UsageStats> {
    const started = Date.now();
    // Snapshot the token tally so we report THIS conversation's ingest cost.
    const t0 = { ...this.tokens };
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

    // Let any in-flight usage-accounting clones settle before reading the delta.
    await new Promise((r) => setTimeout(r, 250));
    return {
      latencyMs: Date.now() - started,
      promptTokens: this.tokens.promptTokens - t0.promptTokens,
      completionTokens: this.tokens.completionTokens - t0.completionTokens,
      totalTokens: this.tokens.totalTokens - t0.totalTokens,
    };
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
