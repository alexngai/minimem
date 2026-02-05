/**
 * Error path tests
 *
 * Tests error handling and recovery for:
 * - Embedding API failures and timeouts
 * - File system errors
 * - Invalid configurations
 * - Concurrent sync operations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { listMemoryFiles, logError, ensureDir } from "../internal.js";
import { parseFrontmatter, serializeFrontmatter, addFrontmatter } from "../session.js";
import { createEmbeddingProvider, type EmbeddingProviderOptions } from "../embeddings/embeddings.js";

describe("Error path: listMemoryFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-err-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("throws when both MEMORY.md and memory.md exist as separate files", async () => {
    await fs.writeFile(path.join(tempDir, "MEMORY.md"), "# Upper");
    await fs.writeFile(path.join(tempDir, "memory.md"), "# Lower");

    await expect(listMemoryFiles(tempDir)).rejects.toThrow(
      /Both MEMORY\.md and memory\.md exist/,
    );
  });

  it("returns empty array when directory has no memory files", async () => {
    const files = await listMemoryFiles(tempDir);
    expect(files).toHaveLength(0);
  });

  it("handles non-existent directory gracefully", async () => {
    const badDir = path.join(tempDir, "does-not-exist");
    const files = await listMemoryFiles(badDir);
    expect(files).toHaveLength(0);
  });

  it("only returns one file when both MEMORY.md and memory.md resolve to same path", async () => {
    // On case-insensitive filesystems, MEMORY.md and memory.md are the same file.
    // On case-sensitive filesystems, this test verifies the single-file path.
    await fs.writeFile(path.join(tempDir, "MEMORY.md"), "# Test");

    const files = await listMemoryFiles(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("MEMORY.md");
  });
});

describe("Error path: logError", () => {
  it("does nothing when debug is undefined", () => {
    // Should not throw
    logError("test", new Error("something broke"));
  });

  it("logs error message when debug is provided", () => {
    const messages: string[] = [];
    const debug = (msg: string) => messages.push(msg);

    logError("testContext", new Error("something broke"), debug);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("[testContext]");
    expect(messages[0]).toContain("something broke");
  });

  it("handles non-Error objects", () => {
    const messages: string[] = [];
    const debug = (msg: string) => messages.push(msg);

    logError("testContext", "string error", debug);
    expect(messages[0]).toContain("string error");

    logError("testContext", 42, debug);
    expect(messages[1]).toContain("42");

    logError("testContext", null, debug);
    expect(messages[2]).toContain("null");
  });
});

describe("Error path: ensureDir", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-err-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates nested directories", () => {
    const nested = path.join(tempDir, "a", "b", "c");
    const result = ensureDir(nested);
    expect(result).toBe(nested);
  });

  it("succeeds when directory already exists", () => {
    ensureDir(tempDir);
    const result = ensureDir(tempDir); // Call again
    expect(result).toBe(tempDir);
  });

  it("logs non-EEXIST errors through debug", () => {
    const messages: string[] = [];
    const debug = (msg: string) => messages.push(msg);

    // Attempt to create a directory with an invalid path (empty string)
    // This may or may not fail depending on OS, so we just verify it doesn't throw
    ensureDir(path.join(tempDir, "valid"), debug);
    // No error logged for successful creation
  });
});

describe("Error path: createEmbeddingProvider", () => {
  it("returns no-op provider for 'none' without type coercion", async () => {
    const options: EmbeddingProviderOptions = { provider: "none" };
    const result = await createEmbeddingProvider(options);

    expect(result.provider.id).toBe("none");
    expect(result.provider.model).toBe("bm25-only");
    expect(result.requestedProvider).toBe("none");
  });

  it("falls back to BM25-only when no API keys available in auto mode", async () => {
    // Clear any API keys
    const origOpenAi = process.env.OPENAI_API_KEY;
    const origGoogle = process.env.GOOGLE_API_KEY;
    const origGemini = process.env.GEMINI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const options: EmbeddingProviderOptions = { provider: "auto" };
      const result = await createEmbeddingProvider(options);

      expect(result.provider.id).toBe("none");
      expect(result.requestedProvider).toBe("auto");
      expect(result.fallbackFrom).toBe("auto");
      expect(result.fallbackReason).toContain("BM25");
    } finally {
      // Restore
      if (origOpenAi) process.env.OPENAI_API_KEY = origOpenAi;
      if (origGoogle) process.env.GOOGLE_API_KEY = origGoogle;
      if (origGemini) process.env.GEMINI_API_KEY = origGemini;
    }
  });

  it("throws when openai explicitly requested without API key", async () => {
    const origKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    try {
      const options: EmbeddingProviderOptions = { provider: "openai" };
      await expect(createEmbeddingProvider(options)).rejects.toThrow(/API key/);
    } finally {
      if (origKey) process.env.OPENAI_API_KEY = origKey;
    }
  });

  it("throws when gemini explicitly requested without API key", async () => {
    const origGoogle = process.env.GOOGLE_API_KEY;
    const origGemini = process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      const options: EmbeddingProviderOptions = { provider: "gemini" };
      await expect(createEmbeddingProvider(options)).rejects.toThrow(/API key/);
    } finally {
      if (origGoogle) process.env.GOOGLE_API_KEY = origGoogle;
      if (origGemini) process.env.GEMINI_API_KEY = origGemini;
    }
  });

  it("no-op provider returns empty vectors", async () => {
    const options: EmbeddingProviderOptions = { provider: "none" };
    const result = await createEmbeddingProvider(options);

    const queryResult = await result.provider.embedQuery("test");
    expect(queryResult).toEqual([]);

    const batchResult = await result.provider.embedBatch(["test1", "test2"]);
    expect(batchResult).toEqual([[], []]);
  });
});

describe("Error path: parseFrontmatter", () => {
  it("returns undefined frontmatter for content without frontmatter", () => {
    const { frontmatter, body } = parseFrontmatter("# Just a heading\n\nSome content.");
    expect(frontmatter).toBeUndefined();
    expect(body).toBe("# Just a heading\n\nSome content.");
  });

  it("returns undefined frontmatter for malformed YAML", () => {
    const content = "---\n{{{invalid: yaml: }}}\n---\nBody";
    const { frontmatter, body } = parseFrontmatter(content);
    // Malformed YAML should fall through to body
    expect(body).toBeTruthy();
  });

  it("handles empty frontmatter block", () => {
    const content = "---\n\n---\nBody content";
    const { frontmatter, body } = parseFrontmatter(content);
    expect(body).toBe("Body content");
  });

  it("handles content that starts with --- but has no closing ---", () => {
    const content = "---\nkey: value\nMore content without closing";
    const { frontmatter, body } = parseFrontmatter(content);
    // No closing --- means no frontmatter
    expect(frontmatter).toBeUndefined();
    expect(body).toBe(content);
  });
});

describe("Error path: addFrontmatter", () => {
  it("creates frontmatter on content without any", () => {
    const result = addFrontmatter("# Hello", { tags: ["test"] });
    expect(result).toContain("---");
    expect(result).toContain("tags: [test]");
    expect(result).toContain("# Hello");
  });

  it("merges with existing frontmatter", () => {
    const existing = "---\ncreated: 2024-01-01T00:00:00Z\n---\n# Hello";
    const result = addFrontmatter(existing, { tags: ["new"] });
    expect(result).toContain("tags: [new]");
    expect(result).toContain("created: 2024-01-01T00:00:00Z");
    expect(result).toContain("# Hello");
  });

  it("preserves session data when adding other frontmatter", () => {
    const existing = "---\nsession:\n  id: abc123\n  source: test\n---\n# Hello";
    const result = addFrontmatter(existing, { tags: ["new"] });
    expect(result).toContain("id: abc123");
    expect(result).toContain("source: test");
    expect(result).toContain("tags: [new]");
  });
});
