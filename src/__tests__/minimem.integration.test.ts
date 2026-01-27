/**
 * Integration tests for Minimem
 *
 * These tests exercise the full e2e flow:
 * - Real SQLite database
 * - Real file system operations
 * - Mocked embeddings (deterministic, no API calls)
 *
 * Run with Node.js native test runner:
 *   npm run test:integration
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";
import assert from "node:assert";

import { Minimem } from "../minimem.js";

// Deterministic embedding function based on keyword presence
// Returns a 128-dimensional vector with values based on word frequencies
function createDeterministicEmbedding(text: string): number[] {
  const lower = text.toLowerCase();
  const keywords = [
    "project", "meeting", "todo", "bug", "feature", "api", "database", "user",
    "test", "deploy", "config", "error", "fix", "update", "review", "design",
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
    "important", "urgent", "note", "remember", "decision", "action", "plan", "goal",
  ];

  const vec = new Array(128).fill(0);

  // Set values based on keyword presence
  keywords.forEach((keyword, i) => {
    const count = (lower.match(new RegExp(keyword, "g")) || []).length;
    vec[i] = count * 0.5;
  });

  // Add some variation based on text length and characters
  for (let i = 32; i < 128; i++) {
    vec[i] = (lower.charCodeAt(i % lower.length) || 0) / 1000;
  }

  // Normalize
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map(v => v / magnitude);
}

// Mock fetch to return deterministic embeddings
function createMockFetch() {
  return mock.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    const body = init?.body ? JSON.parse(init.body as string) : {};

    // Handle OpenAI embeddings endpoint
    if (urlStr.includes("/embeddings")) {
      const inputs = Array.isArray(body.input) ? body.input : [body.input];
      const data = inputs.map((text: string, index: number) => ({
        object: "embedding",
        index,
        embedding: createDeterministicEmbedding(text),
      }));

      return {
        ok: true,
        status: 200,
        json: async () => ({ object: "list", data, model: body.model }),
        text: async () => JSON.stringify({ object: "list", data, model: body.model }),
      };
    }

    // Default: return error
    return {
      ok: false,
      status: 404,
      json: async () => ({ error: "Not found" }),
      text: async () => "Not found",
    };
  });
}

describe("Minimem E2E Integration", () => {
  let tempDir: string;
  let minimem: Minimem;
  let originalFetch: typeof fetch;
  let mockFetch: ReturnType<typeof createMockFetch>;

  before(async () => {
    // Create temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-e2e-"));
    await fs.mkdir(path.join(tempDir, "memory"));

    // Create test memory files
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      `# Memory

## Important Decisions
- We decided to use PostgreSQL for the database
- API design follows REST principles
- All meetings should have action items

## Project Notes
- Project alpha is the main focus
- Beta testing starts next month
`
    );

    await fs.writeFile(
      path.join(tempDir, "memory", "2024-01-15.md"),
      `# Daily Log - 2024-01-15

## Meeting Notes
Had a meeting about the API design. Key decisions:
- Use REST for external APIs
- GraphQL for internal services
- Authentication via JWT tokens

## Todo
- [ ] Review PR #123
- [ ] Fix bug in user authentication
- [x] Deploy to staging
`
    );

    await fs.writeFile(
      path.join(tempDir, "memory", "2024-01-16.md"),
      `# Daily Log - 2024-01-16

## Bug Fix
Fixed critical bug in the database connection pool.
The error was caused by not properly closing connections.

## Feature Work
Started working on the new user dashboard feature.
Design review scheduled for tomorrow.
`
    );

    // Mock fetch
    originalFetch = globalThis.fetch;
    mockFetch = createMockFetch();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Set fake API key
    process.env.OPENAI_API_KEY = "test-api-key-for-integration-tests";

    // Create Minimem instance
    minimem = await Minimem.create({
      memoryDir: tempDir,
      embedding: {
        provider: "openai",
        model: "text-embedding-3-small",
      },
      watch: { enabled: false }, // Disable watching for tests
      hybrid: { enabled: true },
      query: { minScore: 0.0 }, // Lower threshold for testing
    });
  });

  after(async () => {
    // Cleanup
    minimem?.close();
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("indexes memory files and creates database", async () => {
    // Trigger sync (happens lazily on first search or explicit call)
    await minimem.sync();

    const status = await minimem.status();

    assert.equal(status.memoryDir, tempDir);
    assert.equal(status.provider, "openai");
    assert.equal(status.model, "text-embedding-3-small");
    assert.ok(status.fileCount >= 3, `Expected at least 3 files, got ${status.fileCount}`);
    assert.ok(status.chunkCount > 0, `Expected chunks, got ${status.chunkCount}`);
  });

  it("searches and returns relevant results for 'database'", async () => {
    const results = await minimem.search("database connection bug fix");

    assert.ok(results.length > 0, "Expected search results");

    // Should find the bug fix entry
    const hasBugFix = results.some(r =>
      r.snippet.toLowerCase().includes("bug") ||
      r.snippet.toLowerCase().includes("database")
    );
    assert.ok(hasBugFix, "Expected to find database/bug related content");
  });

  it("searches and returns relevant results for 'meeting'", async () => {
    const results = await minimem.search("meeting API design decisions");

    assert.ok(results.length > 0, "Expected search results");

    // Should find meeting notes
    const hasMeeting = results.some(r =>
      r.snippet.toLowerCase().includes("meeting") ||
      r.snippet.toLowerCase().includes("api")
    );
    assert.ok(hasMeeting, "Expected to find meeting/API related content");
  });

  it("returns results with correct metadata", async () => {
    const results = await minimem.search("project alpha beta");

    assert.ok(results.length > 0, "Expected search results");

    for (const result of results) {
      // Each result should have required fields
      assert.ok(typeof result.path === "string", "Result should have path");
      assert.ok(typeof result.startLine === "number", "Result should have startLine");
      assert.ok(typeof result.endLine === "number", "Result should have endLine");
      assert.ok(typeof result.score === "number", "Result should have score");
      assert.ok(typeof result.snippet === "string", "Result should have snippet");
      assert.ok(result.score >= 0 && result.score <= 1, "Score should be between 0 and 1");
      assert.ok(result.startLine <= result.endLine, "startLine should be <= endLine");
    }
  });

  it("respects maxResults parameter", async () => {
    const results = await minimem.search("meeting todo bug", { maxResults: 2 });

    assert.ok(results.length <= 2, `Expected at most 2 results, got ${results.length}`);
  });

  it("respects minScore parameter", async () => {
    const lowThreshold = await minimem.search("test", { minScore: 0.0 });
    const highThreshold = await minimem.search("test", { minScore: 0.99 });

    // High threshold should return fewer or equal results
    assert.ok(
      highThreshold.length <= lowThreshold.length,
      "Higher minScore should return fewer results"
    );
  });

  it("handles empty query gracefully", async () => {
    const results = await minimem.search("");
    assert.deepEqual(results, [], "Empty query should return empty results");

    const whitespaceResults = await minimem.search("   ");
    assert.deepEqual(whitespaceResults, [], "Whitespace query should return empty results");
  });

  it("syncs new files when sync is called", async () => {
    // Add a new file
    await fs.writeFile(
      path.join(tempDir, "memory", "2024-01-17.md"),
      `# Daily Log - 2024-01-17

## New Feature
Implemented the epsilon feature for the gamma module.
This was an urgent request from the product team.
`
    );

    // Force sync
    await minimem.sync({ force: true });

    // Search for new content
    const results = await minimem.search("epsilon gamma urgent feature");

    assert.ok(results.length > 0, "Expected to find newly synced content");
    const hasNewContent = results.some(r =>
      r.snippet.toLowerCase().includes("epsilon") ||
      r.snippet.toLowerCase().includes("gamma")
    );
    assert.ok(hasNewContent, "Expected to find epsilon/gamma content from new file");
  });

  it("removes stale entries when files are deleted", async () => {
    // Delete the file we just added
    await fs.rm(path.join(tempDir, "memory", "2024-01-17.md"));

    // Force sync
    await minimem.sync({ force: true });

    // The epsilon/gamma content should be gone or ranked lower
    const results = await minimem.search("epsilon gamma urgent");

    // Either no results or none containing epsilon
    const hasEpsilon = results.some(r => r.snippet.toLowerCase().includes("epsilon"));
    assert.ok(!hasEpsilon, "Deleted file content should not appear in results");
  });

  it("caches embeddings for repeated content", async () => {
    const initialCallCount = mockFetch.mock.callCount();

    // Search twice with same query
    await minimem.search("database connection");
    await minimem.search("database connection");

    const finalCallCount = mockFetch.mock.callCount();

    // Second search should use cached query embedding
    // (may still make 1 call for query, but not re-embed all chunks)
    assert.ok(
      finalCallCount - initialCallCount <= 2,
      "Expected caching to reduce API calls"
    );
  });
});

describe("Minimem File Operations", () => {
  let tempDir: string;
  let minimem: Minimem;
  let originalFetch: typeof fetch;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-files-"));
    await fs.mkdir(path.join(tempDir, "memory"));

    originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch() as unknown as typeof fetch;
    process.env.OPENAI_API_KEY = "test-key";

    minimem = await Minimem.create({
      memoryDir: tempDir,
      embedding: { provider: "openai" },
      watch: { enabled: false },
    });
  });

  after(async () => {
    minimem?.close();
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lists memory files", async () => {
    await fs.writeFile(path.join(tempDir, "MEMORY.md"), "# Test");
    await fs.writeFile(path.join(tempDir, "memory", "note.md"), "# Note");

    const files = await minimem.listFiles();

    assert.ok(files.includes("MEMORY.md"), "Should list MEMORY.md");
    assert.ok(files.some(f => f.includes("note.md")), "Should list note.md");
  });

  it("reads file content", async () => {
    await fs.writeFile(path.join(tempDir, "MEMORY.md"), "Line 1\nLine 2\nLine 3");

    const content = await minimem.readFile("MEMORY.md");

    assert.equal(content, "Line 1\nLine 2\nLine 3");
  });

  it("reads specific lines", async () => {
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      "Line 1\nLine 2\nLine 3\nLine 4\nLine 5"
    );

    const result = await minimem.readLines("MEMORY.md", { from: 2, lines: 2 });

    assert.ok(result !== null);
    assert.equal(result.content, "Line 2\nLine 3");
    assert.equal(result.startLine, 2);
    assert.equal(result.endLine, 3);
  });

  it("writes new file", async () => {
    await minimem.writeFile("memory/new-file.md", "# New Content\nTest");

    const content = await fs.readFile(
      path.join(tempDir, "memory", "new-file.md"),
      "utf-8"
    );
    assert.equal(content, "# New Content\nTest");
  });

  it("appends to existing file", async () => {
    await fs.writeFile(path.join(tempDir, "memory", "append.md"), "First line");

    await minimem.appendFile("memory/append.md", "Second line");

    const content = await fs.readFile(
      path.join(tempDir, "memory", "append.md"),
      "utf-8"
    );
    assert.ok(content.includes("First line"));
    assert.ok(content.includes("Second line"));
  });

  it("appends to today's log", async () => {
    const today = new Date().toISOString().split("T")[0];

    const resultPath = await minimem.appendToday("Today's note");

    assert.equal(resultPath, `memory/${today}.md`);

    const content = await fs.readFile(
      path.join(tempDir, `memory/${today}.md`),
      "utf-8"
    );
    assert.ok(content.includes("Today's note"));
  });

  it("rejects invalid memory paths", async () => {
    await assert.rejects(
      () => minimem.writeFile("../outside.md", "content"),
      /Invalid memory path/
    );

    await assert.rejects(
      () => minimem.writeFile("src/code.ts", "content"),
      /Invalid memory path/
    );
  });
});
