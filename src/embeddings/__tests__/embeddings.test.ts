import { afterEach, describe, expect, it, vi } from "vitest";

const createFetchMock = (response?: unknown) =>
  vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => response ?? { data: [{ embedding: [1, 2, 3] }] },
    text: async () => JSON.stringify(response ?? { data: [{ embedding: [1, 2, 3] }] }),
  })) as unknown as typeof fetch;

describe("OpenAI embedding provider", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it("makes requests with correct authorization", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createOpenAiEmbeddingProvider } = await import("../embeddings.js");

    const result = await createOpenAiEmbeddingProvider({
      provider: "openai",
      openai: {
        apiKey: "test-api-key",
      },
      model: "text-embedding-3-small",
    });

    await result.provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-api-key");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("uses custom base URL", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createOpenAiEmbeddingProvider } = await import("../embeddings.js");

    await createOpenAiEmbeddingProvider({
      provider: "openai",
      openai: {
        apiKey: "test-key",
        baseUrl: "https://custom.api.com/v1",
      },
    });

    const result = await import("../embeddings.js").then((m) =>
      m.createOpenAiEmbeddingProvider({
        provider: "openai",
        openai: {
          apiKey: "test-key",
          baseUrl: "https://custom.api.com/v1",
        },
      }),
    );

    await result.provider.embedQuery("hello");

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://custom.api.com/v1/embeddings");
  });

  it("uses OPENAI_API_KEY env var when no apiKey provided", async () => {
    process.env.OPENAI_API_KEY = "env-api-key";

    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createOpenAiEmbeddingProvider } = await import("../embeddings.js");

    const result = await createOpenAiEmbeddingProvider({
      provider: "openai",
    });

    await result.provider.embedQuery("hello");

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer env-api-key");
  });

  it("throws when no API key available", async () => {
    const { createOpenAiEmbeddingProvider } = await import("../embeddings.js");

    await expect(
      createOpenAiEmbeddingProvider({
        provider: "openai",
      }),
    ).rejects.toThrow(/API key/i);
  });

  it("embedBatch sends multiple texts", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }, { embedding: [0, 0, 1] }],
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { createOpenAiEmbeddingProvider } = await import("../embeddings.js");

    const result = await createOpenAiEmbeddingProvider({
      provider: "openai",
      openai: { apiKey: "test-key" },
    });

    const embeddings = await result.provider.embedBatch(["hello", "world", "test"]);

    expect(embeddings).toHaveLength(3);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body ?? "{}"));
    expect(body.input).toEqual(["hello", "world", "test"]);
  });

  it("includes custom headers", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createOpenAiEmbeddingProvider } = await import("../embeddings.js");

    const result = await createOpenAiEmbeddingProvider({
      provider: "openai",
      openai: {
        apiKey: "test-key",
        headers: { "X-Custom": "value" },
      },
    });

    await result.provider.embedQuery("hello");

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["X-Custom"]).toBe("value");
  });
});

describe("Gemini embedding provider", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("makes requests with x-goog-api-key header", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: [1, 2, 3] } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { createGeminiEmbeddingProvider } = await import("../embeddings.js");

    const result = await createGeminiEmbeddingProvider({
      provider: "gemini",
      gemini: {
        apiKey: "gemini-test-key",
      },
    });

    await result.provider.embedQuery("hello");

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toContain("generativelanguage.googleapis.com");
    expect(url).toContain(":embedContent");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("gemini-test-key");
  });

  it("uses GOOGLE_API_KEY env var", async () => {
    process.env.GOOGLE_API_KEY = "google-env-key";

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: [1, 2, 3] } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { createGeminiEmbeddingProvider } = await import("../embeddings.js");

    const result = await createGeminiEmbeddingProvider({
      provider: "gemini",
    });

    await result.provider.embedQuery("hello");

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("google-env-key");
  });

  it("uses GEMINI_API_KEY env var as fallback", async () => {
    process.env.GEMINI_API_KEY = "gemini-env-key";

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: [1, 2, 3] } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { createGeminiEmbeddingProvider } = await import("../embeddings.js");

    const result = await createGeminiEmbeddingProvider({
      provider: "gemini",
    });

    await result.provider.embedQuery("hello");

    const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("gemini-env-key");
  });

  it("embedBatch uses batchEmbedContents endpoint", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: [{ values: [1, 0] }, { values: [0, 1] }],
      }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { createGeminiEmbeddingProvider } = await import("../embeddings.js");

    const result = await createGeminiEmbeddingProvider({
      provider: "gemini",
      gemini: { apiKey: "test-key" },
    });

    const embeddings = await result.provider.embedBatch(["hello", "world"]);

    expect(embeddings).toHaveLength(2);
    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toContain(":batchEmbedContents");
  });

  it("uses custom model", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: [1, 2, 3] } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { createGeminiEmbeddingProvider } = await import("../embeddings.js");

    const result = await createGeminiEmbeddingProvider({
      provider: "gemini",
      gemini: { apiKey: "test-key" },
      model: "text-embedding-004",
    });

    await result.provider.embedQuery("hello");

    const [url] = fetchMock.mock.calls[0] ?? [];
    expect(url).toContain("models/text-embedding-004");
  });
});

describe("createEmbeddingProvider auto selection", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;
  });

  it("prefers OpenAI when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "openai-key";

    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("../embeddings.js");

    const result = await createEmbeddingProvider({
      provider: "auto",
    });

    expect(result.requestedProvider).toBe("auto");
    expect(result.provider.id).toBe("openai");
  });

  it("falls back to Gemini when OpenAI key missing", async () => {
    process.env.GOOGLE_API_KEY = "google-key";

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: [1, 2, 3] } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("../embeddings.js");

    const result = await createEmbeddingProvider({
      provider: "auto",
    });

    expect(result.requestedProvider).toBe("auto");
    expect(result.provider.id).toBe("gemini");
  });

  it("falls back to BM25-only when no providers available", async () => {
    const { createEmbeddingProvider } = await import("../embeddings.js");

    const result = await createEmbeddingProvider({
      provider: "auto",
    });

    // Should fall back to BM25-only (no-op provider)
    expect(result.provider.id).toBe("none");
    expect(result.provider.model).toBe("bm25-only");
    expect(result.fallbackFrom).toBe("auto");
    expect(result.fallbackReason).toContain("BM25");

    // No-op provider should return empty embeddings
    const queryEmbed = await result.provider.embedQuery("test");
    expect(queryEmbed).toEqual([]);

    const batchEmbed = await result.provider.embedBatch(["test1", "test2"]);
    expect(batchEmbed).toEqual([[], []]);
  });
});

describe("createEmbeddingProvider with fallback", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  it("falls back to specified provider on failure", async () => {
    process.env.GOOGLE_API_KEY = "google-key";

    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: { values: [1, 2, 3] } }),
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("../embeddings.js");

    const result = await createEmbeddingProvider({
      provider: "openai",
      fallback: "gemini",
    });

    expect(result.provider.id).toBe("gemini");
    expect(result.fallbackFrom).toBe("openai");
    expect(result.fallbackReason).toContain("API key");
  });

  it("throws when fallback is none", async () => {
    const { createEmbeddingProvider } = await import("../embeddings.js");

    await expect(
      createEmbeddingProvider({
        provider: "openai",
        fallback: "none",
      }),
    ).rejects.toThrow(/API key/i);
  });
});

describe("local embedding provider", () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
    vi.doUnmock("node-llama-cpp");
  });

  it("throws helpful error when node-llama-cpp is missing", async () => {
    vi.doMock("node-llama-cpp", () => {
      throw Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    });

    const { createEmbeddingProvider } = await import("../embeddings.js");

    await expect(
      createEmbeddingProvider({
        provider: "local",
        fallback: "none",
      }),
    ).rejects.toThrow(/node-llama-cpp/i);
  });

  it("falls back to OpenAI when local fails", async () => {
    process.env.OPENAI_API_KEY = "openai-key";

    vi.doMock("node-llama-cpp", () => {
      throw Object.assign(new Error("Cannot find package 'node-llama-cpp'"), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    });

    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const { createEmbeddingProvider } = await import("../embeddings.js");

    const result = await createEmbeddingProvider({
      provider: "local",
      fallback: "openai",
    });

    expect(result.provider.id).toBe("openai");
    expect(result.fallbackFrom).toBe("local");
    expect(result.fallbackReason).toContain("node-llama-cpp");
  });
});
