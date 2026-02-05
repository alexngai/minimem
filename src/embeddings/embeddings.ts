import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import type { Llama, LlamaEmbeddingContext, LlamaModel } from "node-llama-cpp";

export type EmbeddingProvider = {
  id: string;
  model: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
};

export type EmbeddingProviderResult = {
  provider: EmbeddingProvider;
  requestedProvider: "openai" | "local" | "gemini" | "auto" | "none";
  fallbackFrom?: "openai" | "local" | "gemini" | "auto";
  fallbackReason?: string;
  openAi?: OpenAiEmbeddingClient;
  gemini?: GeminiEmbeddingClient;
};

export type EmbeddingProviderOptions = {
  provider: "openai" | "local" | "gemini" | "auto" | "none";
  model?: string;
  fallback?: "openai" | "gemini" | "local" | "none";
  openai?: {
    apiKey?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
  };
  gemini?: {
    apiKey?: string;
    baseUrl?: string;
    headers?: Record<string, string>;
  };
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
};

export type OpenAiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
};

export type GeminiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  modelPath: string;
};

const DEFAULT_LOCAL_MODEL = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Creates a no-op embedding provider that returns empty vectors.
 * Used for BM25-only mode when no embedding API is available.
 */
function createNoOpEmbeddingProvider(): EmbeddingProvider {
  return {
    id: "none",
    model: "bm25-only",
    embedQuery: async () => [],
    embedBatch: async (texts) => texts.map(() => []),
  };
}

function resolveUserPath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function canAutoSelectLocal(options: EmbeddingProviderOptions): boolean {
  const modelPath = options.local?.modelPath?.trim();
  if (!modelPath) return false;
  if (/^(hf:|https?:)/i.test(modelPath)) return false;
  const resolved = resolveUserPath(modelPath);
  try {
    return fsSync.statSync(resolved).isFile();
  } catch {
    return false;
  }
}

function isMissingApiKeyError(err: unknown): boolean {
  const message = formatError(err);
  return message.includes("API key") || message.includes("apiKey");
}

async function importNodeLlamaCpp() {
  const llama = await import("node-llama-cpp");
  return llama;
}

async function createLocalEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProvider> {
  const modelPath = options.local?.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
  const modelCacheDir = options.local?.modelCacheDir?.trim();

  const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();

  let llama: Llama | null = null;
  let embeddingModel: LlamaModel | null = null;
  let embeddingContext: LlamaEmbeddingContext | null = null;

  const ensureContext = async () => {
    if (!llama) {
      llama = await getLlama({ logLevel: LlamaLogLevel.error });
    }
    if (!embeddingModel) {
      const resolved = await resolveModelFile(modelPath, modelCacheDir || undefined);
      embeddingModel = await llama.loadModel({ modelPath: resolved });
    }
    if (!embeddingContext) {
      embeddingContext = await embeddingModel.createEmbeddingContext();
    }
    return embeddingContext;
  };

  return {
    id: "local",
    model: modelPath,
    embedQuery: async (text) => {
      const ctx = await ensureContext();
      const embedding = await ctx.getEmbeddingFor(text);
      return Array.from(embedding.vector) as number[];
    },
    embedBatch: async (texts) => {
      const ctx = await ensureContext();
      const embeddings = await Promise.all(
        texts.map(async (text) => {
          const embedding = await ctx.getEmbeddingFor(text);
          return Array.from(embedding.vector) as number[];
        }),
      );
      return embeddings;
    },
  };
}

function normalizeOpenAiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return DEFAULT_OPENAI_EMBEDDING_MODEL;
  if (trimmed.startsWith("openai/")) return trimmed.slice("openai/".length);
  return trimmed;
}

function resolveOpenAiApiKey(options: EmbeddingProviderOptions): string {
  const apiKey = options.openai?.apiKey?.trim();
  if (apiKey) return apiKey;
  const envKey = process.env.OPENAI_API_KEY?.trim();
  if (envKey) return envKey;
  throw new Error("OpenAI API key not found. Set OPENAI_API_KEY env var or pass openai.apiKey option.");
}

export async function createOpenAiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OpenAiEmbeddingClient }> {
  const apiKey = resolveOpenAiApiKey(options);
  const baseUrl = options.openai?.baseUrl?.trim() || DEFAULT_OPENAI_BASE_URL;
  const headerOverrides = options.openai?.headers ?? {};
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...headerOverrides,
  };
  const model = normalizeOpenAiModel(options.model || "");
  const client: OpenAiEmbeddingClient = { baseUrl, headers, model };
  const url = `${baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) return [];
    const res = await fetch(url, {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({ model: client.model, input }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`openai embeddings failed: ${res.status} ${text}`);
    }
    const payload = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
    };
    const data = payload.data ?? [];
    return data.map((entry) => entry.embedding ?? []);
  };

  return {
    provider: {
      id: "openai",
      model: client.model,
      embedQuery: async (text) => {
        const [vec] = await embed([text]);
        return vec ?? [];
      },
      embedBatch: embed,
    },
    client,
  };
}

function normalizeGeminiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) return DEFAULT_GEMINI_EMBEDDING_MODEL;
  const withoutPrefix = trimmed.replace(/^models\//, "");
  if (withoutPrefix.startsWith("gemini/")) return withoutPrefix.slice("gemini/".length);
  if (withoutPrefix.startsWith("google/")) return withoutPrefix.slice("google/".length);
  return withoutPrefix;
}

function normalizeGeminiBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  const openAiIndex = trimmed.indexOf("/openai");
  if (openAiIndex > -1) return trimmed.slice(0, openAiIndex);
  return trimmed;
}

function buildGeminiModelPath(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

function resolveGeminiApiKey(options: EmbeddingProviderOptions): string {
  const apiKey = options.gemini?.apiKey?.trim();
  if (apiKey) return apiKey;
  const googleKey = process.env.GOOGLE_API_KEY?.trim();
  if (googleKey) return googleKey;
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (geminiKey) return geminiKey;
  throw new Error("Gemini API key not found. Set GOOGLE_API_KEY or GEMINI_API_KEY env var or pass gemini.apiKey option.");
}

export async function createGeminiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: GeminiEmbeddingClient }> {
  const apiKey = resolveGeminiApiKey(options);
  const rawBaseUrl = options.gemini?.baseUrl?.trim() || DEFAULT_GEMINI_BASE_URL;
  const baseUrl = normalizeGeminiBaseUrl(rawBaseUrl);
  const headerOverrides = options.gemini?.headers ?? {};
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-goog-api-key": apiKey,
    ...headerOverrides,
  };
  const model = normalizeGeminiModel(options.model || "");
  const modelPath = buildGeminiModelPath(model);
  const client: GeminiEmbeddingClient = { baseUrl, headers, model, modelPath };

  const embedUrl = `${baseUrl}/${modelPath}:embedContent`;
  const batchUrl = `${baseUrl}/${modelPath}:batchEmbedContents`;

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) return [];
    const res = await fetch(embedUrl, {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_QUERY",
      }),
    });
    if (!res.ok) {
      const payload = await res.text();
      throw new Error(`gemini embeddings failed: ${res.status} ${payload}`);
    }
    const payload = (await res.json()) as { embedding?: { values?: number[] } };
    return payload.embedding?.values ?? [];
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) return [];
    const requests = texts.map((text) => ({
      model: modelPath,
      content: { parts: [{ text }] },
      taskType: "RETRIEVAL_DOCUMENT",
    }));
    const res = await fetch(batchUrl, {
      method: "POST",
      headers: client.headers,
      body: JSON.stringify({ requests }),
    });
    if (!res.ok) {
      const payload = await res.text();
      throw new Error(`gemini embeddings failed: ${res.status} ${payload}`);
    }
    const payload = (await res.json()) as { embeddings?: Array<{ values?: number[] }> };
    const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
    return texts.map((_, index) => embeddings[index]?.values ?? []);
  };

  return {
    provider: {
      id: "gemini",
      model: client.model,
      embedQuery,
      embedBatch,
    },
    client,
  };
}

export async function createEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<EmbeddingProviderResult> {
  const requestedProvider = options.provider;
  const fallback = options.fallback ?? "none";

  // Handle explicit "none" provider (BM25-only mode)
  if (requestedProvider === "none") {
    return {
      provider: createNoOpEmbeddingProvider(),
      requestedProvider: "none",
    };
  }

  const createProvider = async (id: "openai" | "local" | "gemini") => {
    if (id === "local") {
      const provider = await createLocalEmbeddingProvider(options);
      return { provider };
    }
    if (id === "gemini") {
      const { provider, client } = await createGeminiEmbeddingProvider(options);
      return { provider, gemini: client };
    }
    const { provider, client } = await createOpenAiEmbeddingProvider(options);
    return { provider, openAi: client };
  };

  const formatPrimaryError = (err: unknown, provider: "openai" | "local" | "gemini") =>
    provider === "local" ? formatLocalSetupError(err) : formatError(err);

  if (requestedProvider === "auto") {
    const missingKeyErrors: string[] = [];
    let localError: string | null = null;

    if (canAutoSelectLocal(options)) {
      try {
        const local = await createProvider("local");
        return { ...local, requestedProvider };
      } catch (err) {
        localError = formatLocalSetupError(err);
      }
    }

    for (const provider of ["openai", "gemini"] as const) {
      try {
        const result = await createProvider(provider);
        return { ...result, requestedProvider };
      } catch (err) {
        const message = formatPrimaryError(err, provider);
        if (isMissingApiKeyError(err)) {
          missingKeyErrors.push(message);
          continue;
        }
        throw new Error(message);
      }
    }

    // Fall back to BM25-only mode instead of throwing
    // This allows the system to work without any API keys using full-text search only
    return {
      provider: createNoOpEmbeddingProvider(),
      requestedProvider,
      fallbackFrom: "auto",
      fallbackReason: "No embedding API available. Using BM25 full-text search only.",
    };
  }

  try {
    const primary = await createProvider(requestedProvider);
    return { ...primary, requestedProvider };
  } catch (primaryErr) {
    const reason = formatPrimaryError(primaryErr, requestedProvider);
    if (fallback && fallback !== "none" && fallback !== requestedProvider) {
      try {
        const fallbackResult = await createProvider(fallback);
        return {
          ...fallbackResult,
          requestedProvider,
          fallbackFrom: requestedProvider,
          fallbackReason: reason,
        };
      } catch (fallbackErr) {
        throw new Error(`${reason}\n\nFallback to ${fallback} failed: ${formatError(fallbackErr)}`);
      }
    }
    throw new Error(reason);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function isNodeLlamaCppMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as Error & { code?: unknown }).code;
  if (code === "ERR_MODULE_NOT_FOUND") {
    return err.message.includes("node-llama-cpp");
  }
  return false;
}

function formatLocalSetupError(err: unknown): string {
  const detail = formatError(err);
  const missing = isNodeLlamaCppMissing(err);
  return [
    "Local embeddings unavailable.",
    missing
      ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)."
      : detail
        ? `Reason: ${detail}`
        : undefined,
    missing && detail ? `Detail: ${detail}` : null,
    "To enable local embeddings:",
    "1) Use Node 22 LTS (recommended for installs/updates)",
    missing ? "2) Install node-llama-cpp: npm install node-llama-cpp" : null,
    "3) If you use pnpm: pnpm approve-builds (select node-llama-cpp), then pnpm rebuild node-llama-cpp",
    'Or set provider = "openai" or "gemini" (remote).',
  ]
    .filter(Boolean)
    .join("\n");
}
