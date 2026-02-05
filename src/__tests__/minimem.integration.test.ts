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
import { after, before, describe, it } from "node:test";
import assert from "node:assert";

import { Minimem } from "../minimem.js";
import { createMockFetch } from "./helpers.js";

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

describe("Minimem BM25-Only Mode", () => {
  let tempDir: string;
  let minimem: Minimem;

  before(async () => {
    // Create temp directory
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-bm25-"));
    await fs.mkdir(path.join(tempDir, "memory"));

    // Create test memory files with distinct keywords
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      `# Memory

## Database Decisions
We chose PostgreSQL for the main database.
SQLite is used for local development.
Redis handles caching requirements.

## API Architecture
REST endpoints for external clients.
GraphQL for internal microservices.
WebSocket connections for real-time features.
`
    );

    await fs.writeFile(
      path.join(tempDir, "memory", "meetings.md"),
      `# Meeting Notes

## Sprint Planning
Discussed authentication requirements.
JWT tokens will be used for API authentication.
OAuth integration for third-party login.

## Design Review
Reviewed the dashboard wireframes.
Mobile-first approach approved.
Accessibility requirements confirmed.
`
    );

    await fs.writeFile(
      path.join(tempDir, "memory", "bugs.md"),
      `# Bug Tracker

## Critical Issues
Memory leak in connection pooling.
Fixed by properly closing database handles.

## Performance
Slow queries on user search.
Added index on email column.
Response time improved by 80%.
`
    );

    // Ensure no API keys are set for this test
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;

    // Create Minimem instance with explicit "none" provider (BM25-only)
    minimem = await Minimem.create({
      memoryDir: tempDir,
      embedding: {
        provider: "none",
      },
      watch: { enabled: false },
      hybrid: { enabled: true },
      query: { minScore: 0.0 },
    });
  });

  after(async () => {
    minimem?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates instance in BM25-only mode", async () => {
    const status = await minimem.status();

    assert.equal(status.provider, "none");
    assert.equal(status.model, "bm25-only");
    assert.equal(status.bm25Only, true);
    assert.equal(status.ftsAvailable, true);
  });

  it("indexes files without embeddings", async () => {
    await minimem.sync();

    const status = await minimem.status();

    assert.ok(status.fileCount >= 3, `Expected at least 3 files, got ${status.fileCount}`);
    assert.ok(status.chunkCount > 0, `Expected chunks, got ${status.chunkCount}`);
  });

  it("finds results for 'PostgreSQL database'", async () => {
    const results = await minimem.search("PostgreSQL database");

    assert.ok(results.length > 0, "Expected search results for 'PostgreSQL database'");

    // Should find the database decisions section
    const hasPostgres = results.some(r =>
      r.snippet.toLowerCase().includes("postgresql")
    );
    assert.ok(hasPostgres, "Expected to find PostgreSQL in results");
  });

  it("finds results for 'authentication JWT'", async () => {
    const results = await minimem.search("authentication JWT tokens");

    assert.ok(results.length > 0, "Expected search results for 'authentication JWT'");

    // Should find the meeting notes about authentication
    const hasAuth = results.some(r =>
      r.snippet.toLowerCase().includes("jwt") ||
      r.snippet.toLowerCase().includes("authentication")
    );
    assert.ok(hasAuth, "Expected to find JWT/authentication in results");
  });

  it("finds results for 'connection pooling'", async () => {
    const results = await minimem.search("connection pooling");

    assert.ok(results.length > 0, "Expected search results for 'connection pooling'");

    // Should find the bug tracker content
    const hasBug = results.some(r =>
      r.snippet.toLowerCase().includes("connection") ||
      r.snippet.toLowerCase().includes("pooling")
    );
    assert.ok(hasBug, "Expected to find connection/pooling in results");
  });

  it("returns no results for non-existent terms", async () => {
    const results = await minimem.search("xyzzy quantum blockchain cryptocurrency");

    // Should have no or very low scoring results
    const highScoreResults = results.filter(r => r.score > 0.3);
    assert.equal(highScoreResults.length, 0, "Expected no high-scoring results for nonsense query");
  });

  it("respects maxResults parameter", async () => {
    const results = await minimem.search("database API", { maxResults: 2 });

    assert.ok(results.length <= 2, `Expected at most 2 results, got ${results.length}`);
  });

  it("syncs new files correctly", async () => {
    // Add a new file
    await fs.writeFile(
      path.join(tempDir, "memory", "deployment.md"),
      `# Deployment Guide

## Production Setup
Kubernetes cluster configuration.
Docker images pushed to ECR registry.
Terraform manages infrastructure.
`
    );

    await minimem.sync({ force: true });

    // Search for new content
    const results = await minimem.search("Kubernetes Docker deployment");

    assert.ok(results.length > 0, "Expected to find newly synced content");
    const hasDeployment = results.some(r =>
      r.snippet.toLowerCase().includes("kubernetes") ||
      r.snippet.toLowerCase().includes("docker")
    );
    assert.ok(hasDeployment, "Expected to find Kubernetes/Docker content");
  });

  it("removes deleted files from index", async () => {
    // Delete the deployment file
    await fs.rm(path.join(tempDir, "memory", "deployment.md"));

    await minimem.sync({ force: true });

    // Search for deleted content
    const results = await minimem.search("Kubernetes Docker Terraform");

    // Should not find the deleted content
    const hasKubernetes = results.some(r =>
      r.snippet.toLowerCase().includes("kubernetes")
    );
    assert.ok(!hasKubernetes, "Deleted file content should not appear in results");
  });
});

describe("Minimem Auto-Fallback to BM25", () => {
  let tempDir: string;
  let minimem: Minimem;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-autobm25-"));
    await fs.mkdir(path.join(tempDir, "memory"));

    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      `# Test Memory
Important notes about the project.
Database uses PostgreSQL.
`
    );

    // Ensure no API keys
    delete process.env.OPENAI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.GEMINI_API_KEY;

    // Use "auto" provider - should fall back to BM25-only
    minimem = await Minimem.create({
      memoryDir: tempDir,
      embedding: {
        provider: "auto",
      },
      watch: { enabled: false },
      hybrid: { enabled: true },
    });
  });

  after(async () => {
    minimem?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("auto-falls back to BM25-only when no API keys available", async () => {
    const status = await minimem.status();

    assert.equal(status.provider, "none");
    assert.equal(status.bm25Only, true);
    assert.ok(status.fallbackReason?.includes("BM25"), "Should have fallback reason");
  });

  it("search still works in auto-fallback mode", async () => {
    await minimem.sync();

    const results = await minimem.search("PostgreSQL database");

    assert.ok(results.length > 0, "Expected search results");
    const hasDb = results.some(r =>
      r.snippet.toLowerCase().includes("postgresql") ||
      r.snippet.toLowerCase().includes("database")
    );
    assert.ok(hasDb, "Expected to find PostgreSQL/database in results");
  });
});

describe("Minimem Staleness Detection", () => {
  let tempDir: string;
  let minimem: Minimem;
  let originalFetch: typeof global.fetch;

  before(async () => {
    originalFetch = global.fetch;
    global.fetch = createMockFetch() as unknown as typeof global.fetch;

    // Set fake API key (required by provider validation)
    process.env.OPENAI_API_KEY = "test-api-key-for-staleness-tests";

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-stale-test-"));

    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      "# Original Content\n\nThis is the original memory content."
    );

    // Create with watch disabled - this is the scenario we're testing
    minimem = await Minimem.create({
      memoryDir: tempDir,
      embedding: { provider: "openai" },
      watch: { enabled: false },
      hybrid: { enabled: true },
      query: { minScore: 0.0 }, // Lower threshold for testing
    });

    // Initial sync
    await minimem.sync();
  });

  after(async () => {
    global.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    minimem?.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("detects modified files without watcher", async () => {
    // First search - should find original content
    const results1 = await minimem.search("original content");
    assert.ok(results1.length > 0, "Should find original content");

    // Modify the file externally (simulating user edit)
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      "# Updated Content\n\nThis is completely new modified content about bananas."
    );

    // Search again - should detect staleness and re-sync
    const results2 = await minimem.search("bananas");
    assert.ok(results2.length > 0, "Should find new content after mtime-based staleness detection");
    const hasBananas = results2.some(r => r.snippet.toLowerCase().includes("banana"));
    assert.ok(hasBananas, "Should have indexed the new content");
  });

  it("detects new files without watcher", async () => {
    // Add a new file
    await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, "memory", "new-topic.md"),
      "# New Topic\n\nThis document discusses elephants and their habitats."
    );

    // Search - should detect the new file and sync
    const results = await minimem.search("elephants habitats");
    assert.ok(results.length > 0, "Should find content from new file");
    const hasElephants = results.some(r => r.snippet.toLowerCase().includes("elephant"));
    assert.ok(hasElephants, "Should have indexed the new file");
  });

  it("detects deleted files without watcher", async () => {
    // Delete the file we just created
    await fs.rm(path.join(tempDir, "memory", "new-topic.md"));

    // Search - should detect the deletion and re-sync
    const results = await minimem.search("elephants");

    // After re-sync, the deleted content should no longer be found
    // (or have lower relevance since it's not in the index anymore)
    const hasElephants = results.some(r => r.snippet.toLowerCase().includes("elephant"));
    assert.ok(!hasElephants, "Should not find content from deleted file after staleness detection");
  });
});
