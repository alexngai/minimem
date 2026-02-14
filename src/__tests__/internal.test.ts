import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  chunkMarkdown,
  stripPrivateContent,
  extractChunkMetadata,
  hashText,
  buildFileEntry,
  listMemoryFiles,
  cosineSimilarity,
  isMemoryPath,
  normalizeRelPath,
  truncateUtf16Safe,
} from "../internal.js";

describe("chunkMarkdown", () => {
  it("splits overly long lines into max-sized chunks", () => {
    const chunkTokens = 400;
    const maxChars = chunkTokens * 4;
    const content = "a".repeat(maxChars * 3 + 25);
    const chunks = chunkMarkdown(content, { tokens: chunkTokens, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    }
  });

  it("creates chunks with correct line numbers", () => {
    const content = "line1\nline2\nline3\nline4\nline5";
    const chunks = chunkMarkdown(content, { tokens: 10, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[chunks.length - 1].endLine).toBe(5);
  });

  it("handles overlap between chunks", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const content = lines.join("\n");
    const chunksWithOverlap = chunkMarkdown(content, { tokens: 20, overlap: 5 });
    const chunksWithoutOverlap = chunkMarkdown(content, { tokens: 20, overlap: 0 });

    // With overlap, chunks should share some content
    expect(chunksWithOverlap.length).toBeGreaterThanOrEqual(chunksWithoutOverlap.length);
  });

  it("handles empty content gracefully", () => {
    // Empty string splits into one line, which creates one chunk
    const chunks = chunkMarkdown("", { tokens: 256, overlap: 32 });
    expect(chunks.length).toBeLessThanOrEqual(1);
    if (chunks.length > 0) {
      expect(chunks[0].text).toBe("");
    }
  });

  it("assigns hash to each chunk", () => {
    const content = "Hello world\nThis is a test";
    const chunks = chunkMarkdown(content, { tokens: 256, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.hash).toBeDefined();
      expect(chunk.hash.length).toBe(64); // SHA256 hex length
    }
  });
});

describe("stripPrivateContent", () => {
  it("strips single-line private block", () => {
    const input = "public\n<private>secret</private>\nmore public";
    const result = stripPrivateContent(input);
    expect(result).toBe("public\n\nmore public");
  });

  it("strips multi-line private block preserving line count", () => {
    const input = "line1\n<private>\nsecret1\nsecret2\n</private>\nline6";
    const result = stripPrivateContent(input);
    const lines = result.split("\n");
    // Original has 6 lines, result should too
    expect(lines.length).toBe(6);
    expect(lines[0]).toBe("line1");
    expect(lines[5]).toBe("line6");
    // Middle lines should be empty
    expect(lines[1]).toBe("");
    expect(lines[2]).toBe("");
    expect(lines[3]).toBe("");
    expect(lines[4]).toBe("");
  });

  it("strips multiple private blocks", () => {
    const input = "a\n<private>x</private>\nb\n<private>y</private>\nc";
    const result = stripPrivateContent(input);
    expect(result).toBe("a\n\nb\n\nc");
  });

  it("is case-insensitive", () => {
    const input = "a\n<PRIVATE>secret</PRIVATE>\nb";
    const result = stripPrivateContent(input);
    expect(result).toBe("a\n\nb");
  });

  it("returns content unchanged when no private tags", () => {
    const input = "no secrets here\njust plain text";
    expect(stripPrivateContent(input)).toBe(input);
  });

  it("handles empty content", () => {
    expect(stripPrivateContent("")).toBe("");
  });

  it("leaves unclosed private tag unchanged", () => {
    const input = "text\n<private>no closing tag here\nmore text";
    expect(stripPrivateContent(input)).toBe(input);
  });

  it("leaves orphaned closing tag unchanged", () => {
    const input = "text\n</private>\nmore text";
    expect(stripPrivateContent(input)).toBe(input);
  });

  it("handles mixed case tags", () => {
    expect(stripPrivateContent("a\n<Private>x</Private>\nb")).toBe("a\n\nb");
    expect(stripPrivateContent("a\n<pRiVaTe>x</pRiVaTe>\nb")).toBe("a\n\nb");
  });

  it("handles private block with only newlines inside", () => {
    const input = "a\n<private>\n\n\n</private>\nb";
    const result = stripPrivateContent(input);
    expect(result.split("\n").length).toBe(input.split("\n").length);
    expect(result).not.toContain("<private>");
  });

  it("handles adjacent private blocks", () => {
    const input = "<private>a</private><private>b</private>";
    const result = stripPrivateContent(input);
    expect(result).not.toContain("a");
    expect(result).not.toContain("b");
    expect(result).not.toContain("<private>");
  });
});

describe("chunkMarkdown with private content", () => {
  it("excludes private content from chunks", () => {
    const content = "public info\n<private>API_KEY=sk-123</private>\nmore public";
    const chunks = chunkMarkdown(content, { tokens: 256, overlap: 0 });
    for (const chunk of chunks) {
      expect(chunk.text).not.toContain("API_KEY");
      expect(chunk.text).not.toContain("sk-123");
      expect(chunk.text).not.toContain("<private>");
    }
  });

  it("preserves line numbers when private content is stripped", () => {
    const content = "line1\n<private>\nsecret\n</private>\nline5";
    const chunks = chunkMarkdown(content, { tokens: 256, overlap: 0 });
    // line5 is on line 5 in the original, should stay on line 5
    const allText = chunks.map((c) => c.text).join("\n");
    expect(allText).toContain("line1");
    expect(allText).toContain("line5");
    expect(allText).not.toContain("secret");
  });
});

describe("extractChunkMetadata", () => {
  it("extracts type from HTML comment", () => {
    const text = "### 2026-02-13 14:30\n<!-- type: decision -->\nDecided to use BM25";
    expect(extractChunkMetadata(text)).toEqual({ type: "decision" });
  });

  it("is case-insensitive", () => {
    const text = "<!-- Type: BugFix -->\nFixed off-by-one error";
    expect(extractChunkMetadata(text)).toEqual({ type: "bugfix" });
  });

  it("returns empty object when no type comment", () => {
    const text = "Just plain text with no metadata";
    expect(extractChunkMetadata(text)).toEqual({});
  });

  it("extracts first type when multiple present", () => {
    const text = "<!-- type: feature -->\n<!-- type: discovery -->\nSome text";
    expect(extractChunkMetadata(text)).toEqual({ type: "feature" });
  });

  it("handles various type values", () => {
    expect(extractChunkMetadata("<!-- type: discovery -->")).toEqual({ type: "discovery" });
    expect(extractChunkMetadata("<!-- type: context -->")).toEqual({ type: "context" });
    expect(extractChunkMetadata("<!-- type: note -->")).toEqual({ type: "note" });
  });

  it("handles hyphenated type values", () => {
    expect(extractChunkMetadata("<!-- type: bug-fix -->")).toEqual({ type: "bug-fix" });
    expect(extractChunkMetadata("<!-- type: api-change -->")).toEqual({ type: "api-change" });
  });

  it("handles underscored type values", () => {
    expect(extractChunkMetadata("<!-- type: feature_flag -->")).toEqual({ type: "feature_flag" });
  });

  it("handles whitespace variations in comment", () => {
    expect(extractChunkMetadata("<!--type:decision-->")).toEqual({ type: "decision" });
    expect(extractChunkMetadata("<!--  type:  decision  -->")).toEqual({ type: "decision" });
    expect(extractChunkMetadata("<!-- type:decision -->")).toEqual({ type: "decision" });
  });

  it("does not match empty type value", () => {
    expect(extractChunkMetadata("<!-- type: -->")).toEqual({});
    expect(extractChunkMetadata("<!-- type:  -->")).toEqual({});
  });

  it("does not match unclosed comment", () => {
    expect(extractChunkMetadata("<!-- type: decision")).toEqual({});
  });

  it("does not match partial comment syntax", () => {
    expect(extractChunkMetadata("type: decision")).toEqual({});
    expect(extractChunkMetadata("// type: decision")).toEqual({});
  });

  it("normalizes mixed case type to lowercase", () => {
    expect(extractChunkMetadata("<!-- type: DeciSion -->")).toEqual({ type: "decision" });
    expect(extractChunkMetadata("<!-- type: BUGFIX -->")).toEqual({ type: "bugfix" });
  });
});

describe("hashText", () => {
  it("returns consistent SHA256 hash", () => {
    const hash1 = hashText("hello world");
    const hash2 = hashText("hello world");
    expect(hash1).toBe(hash2);
    expect(hash1.length).toBe(64);
  });

  it("returns different hashes for different inputs", () => {
    const hash1 = hashText("hello");
    const hash2 = hashText("world");
    expect(hash1).not.toBe(hash2);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const vec = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    const vec1 = [1, 0, 0];
    const vec2 = [0, 1, 0];
    expect(cosineSimilarity(vec1, vec2)).toBeCloseTo(0);
  });

  it("returns -1 for opposite vectors", () => {
    const vec1 = [1, 2, 3];
    const vec2 = [-1, -2, -3];
    expect(cosineSimilarity(vec1, vec2)).toBeCloseTo(-1);
  });

  it("handles empty vectors", () => {
    expect(cosineSimilarity([], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [])).toBe(0);
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("handles zero vectors", () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });
});

describe("isMemoryPath", () => {
  it("accepts MEMORY.md", () => {
    expect(isMemoryPath("MEMORY.md")).toBe(true);
    expect(isMemoryPath("memory.md")).toBe(true);
  });

  it("accepts paths in memory directory", () => {
    expect(isMemoryPath("memory/2024-01-01.md")).toBe(true);
    expect(isMemoryPath("memory/topic/notes.md")).toBe(true);
  });

  it("rejects non-memory paths", () => {
    expect(isMemoryPath("README.md")).toBe(false);
    expect(isMemoryPath("src/index.ts")).toBe(false);
    expect(isMemoryPath("")).toBe(false);
  });

  it("handles leading dots and slashes", () => {
    expect(isMemoryPath("./MEMORY.md")).toBe(true);
    expect(isMemoryPath("./memory/test.md")).toBe(true);
  });
});

describe("normalizeRelPath", () => {
  it("removes leading dots and slashes", () => {
    expect(normalizeRelPath("./foo/bar")).toBe("foo/bar");
    expect(normalizeRelPath("../foo/bar")).toBe("foo/bar");
    expect(normalizeRelPath("///foo")).toBe("foo");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalizeRelPath("foo\\bar\\baz")).toBe("foo/bar/baz");
  });

  it("trims whitespace", () => {
    expect(normalizeRelPath("  foo/bar  ")).toBe("foo/bar");
  });
});

describe("truncateUtf16Safe", () => {
  it("returns original string if under limit", () => {
    expect(truncateUtf16Safe("hello", 10)).toBe("hello");
  });

  it("truncates string at limit", () => {
    expect(truncateUtf16Safe("hello world", 5)).toBe("hello");
  });
});

describe("listMemoryFiles", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("finds MEMORY.md at root", async () => {
    await fs.writeFile(path.join(tempDir, "MEMORY.md"), "# Memory");
    const files = await listMemoryFiles(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("MEMORY.md");
  });

  it("finds files in memory directory", async () => {
    await fs.mkdir(path.join(tempDir, "memory"));
    await fs.writeFile(path.join(tempDir, "memory", "2024-01-01.md"), "# Log");
    await fs.writeFile(path.join(tempDir, "memory", "notes.md"), "# Notes");

    const files = await listMemoryFiles(tempDir);
    expect(files).toHaveLength(2);
  });

  it("recursively finds files in nested directories", async () => {
    await fs.mkdir(path.join(tempDir, "memory", "topics"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "memory", "topics", "project.md"), "# Project");

    const files = await listMemoryFiles(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain("project.md");
  });

  it("returns empty array when no memory files exist", async () => {
    const files = await listMemoryFiles(tempDir);
    expect(files).toHaveLength(0);
  });

  it("only includes .md files", async () => {
    await fs.mkdir(path.join(tempDir, "memory"));
    await fs.writeFile(path.join(tempDir, "memory", "notes.md"), "# Notes");
    await fs.writeFile(path.join(tempDir, "memory", "notes.txt"), "text");
    await fs.writeFile(path.join(tempDir, "memory", "data.json"), "{}");

    const files = await listMemoryFiles(tempDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toContain(".md");
  });
});

describe("buildFileEntry", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("builds correct file entry", async () => {
    const content = "# Test content";
    const filePath = path.join(tempDir, "test.md");
    await fs.writeFile(filePath, content);

    const entry = await buildFileEntry(filePath, tempDir);

    expect(entry.path).toBe("test.md");
    expect(entry.absPath).toBe(filePath);
    expect(entry.hash).toBe(hashText(content));
    expect(entry.size).toBe(content.length);
    expect(entry.mtimeMs).toBeGreaterThan(0);
  });

  it("handles nested paths", async () => {
    await fs.mkdir(path.join(tempDir, "memory"));
    const filePath = path.join(tempDir, "memory", "2024-01-01.md");
    await fs.writeFile(filePath, "# Log");

    const entry = await buildFileEntry(filePath, tempDir);

    expect(entry.path).toBe("memory/2024-01-01.md");
  });
});
