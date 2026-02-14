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

describe("Minimem Type Filtering", () => {
  let tempDir: string;
  let minimem: Minimem;
  let originalFetch: typeof global.fetch;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-type-filter-"));
    await fs.mkdir(path.join(tempDir, "memory"));

    // Create memory files with different observation types
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      `# Memory

## API Design Decision
<!-- type: decision -->
We decided to use REST for external APIs and GraphQL for internal services.
Authentication will use JWT tokens.

## General Notes
Some general project notes without a type tag.
The project uses TypeScript and Node.js.
`
    );

    await fs.writeFile(
      path.join(tempDir, "memory", "bugs.md"),
      `# Bug Tracker

## Login Bug
<!-- type: bugfix -->
Fixed critical login failure caused by expired JWT token not being refreshed.
Root cause was missing refresh token rotation logic.

## Dashboard Crash
<!-- type: bugfix -->
Fixed dashboard crash when user had no recent activity.
Added null check for empty activity arrays.
`
    );

    await fs.writeFile(
      path.join(tempDir, "memory", "features.md"),
      `# Features

## Search Feature
<!-- type: feature -->
Implemented full-text search with BM25 ranking.
Users can now search across all memory files.

## Export Feature
<!-- type: feature -->
Added CSV and JSON export for memory entries.
`
    );

    originalFetch = global.fetch;
    global.fetch = createMockFetch() as unknown as typeof global.fetch;
    process.env.OPENAI_API_KEY = "test-key-type-filter";

    minimem = await Minimem.create({
      memoryDir: tempDir,
      embedding: { provider: "openai" },
      watch: { enabled: false },
      hybrid: { enabled: true },
      query: { minScore: 0.0 },
    });

    await minimem.sync();
  });

  after(async () => {
    minimem?.close();
    global.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns all results when no type filter is specified", async () => {
    const results = await minimem.search("API login search export");

    assert.ok(results.length > 0, "Expected search results without type filter");
  });

  it("filters results by type: decision", async () => {
    const results = await minimem.search("API design REST GraphQL JWT", { type: "decision" });

    assert.ok(results.length > 0, "Expected decision results");

    // Every result should come from the decision chunk
    for (const r of results) {
      assert.ok(
        r.snippet.toLowerCase().includes("rest") ||
        r.snippet.toLowerCase().includes("graphql") ||
        r.snippet.toLowerCase().includes("decision") ||
        r.snippet.toLowerCase().includes("jwt"),
        `Decision result should contain relevant content, got: ${r.snippet.slice(0, 80)}`
      );
    }
  });

  it("filters results by type: bugfix", async () => {
    const results = await minimem.search("login crash bug fix", { type: "bugfix" });

    assert.ok(results.length > 0, "Expected bugfix results");

    // Should only find bug-related content
    const hasDecision = results.some(r =>
      r.snippet.toLowerCase().includes("rest for external apis")
    );
    assert.ok(!hasDecision, "Bugfix filter should not return decision content");
  });

  it("filters results by type: feature", async () => {
    const results = await minimem.search("search export feature", { type: "feature" });

    assert.ok(results.length > 0, "Expected feature results");

    // Should only find feature-related content
    const hasBugfix = results.some(r =>
      r.snippet.toLowerCase().includes("login failure") ||
      r.snippet.toLowerCase().includes("dashboard crash")
    );
    assert.ok(!hasBugfix, "Feature filter should not return bugfix content");
  });

  it("returns empty results for non-matching type filter", async () => {
    const results = await minimem.search("API design REST", { type: "discovery" });

    // Should have no results since nothing is tagged as "discovery"
    assert.equal(results.length, 0, "Expected no results for unused type");
  });

  it("type filter works with maxResults", async () => {
    const results = await minimem.search("bug fix crash login", {
      type: "bugfix",
      maxResults: 1,
    });

    assert.ok(results.length <= 1, `Expected at most 1 result, got ${results.length}`);
  });
});

describe("Minimem Privacy Tags", () => {
  let tempDir: string;
  let minimem: Minimem;
  let originalFetch: typeof global.fetch;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-privacy-"));
    await fs.mkdir(path.join(tempDir, "memory"));

    // Create memory files with private content
    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      `# Memory

## API Configuration
API endpoint: api.example.com/v2
Rate limit: 1000 requests per minute

<private>
API_KEY=sk-secret-key-12345
DB_PASSWORD=hunter2
AWS_SECRET=AKIAIOSFODNN7EXAMPLE
</private>

## Public Notes
The API uses versioned endpoints.
Documentation is at docs.example.com.
`
    );

    await fs.writeFile(
      path.join(tempDir, "memory", "credentials.md"),
      `# Service Credentials

## Production Database
Host: db.prod.example.com
Port: 5432

<private>
username: admin
password: super-secret-password-123
connection_string: postgres://admin:super-secret-password-123@db.prod.example.com:5432/main
</private>

## Staging Database
Host: db.staging.example.com
Port: 5432
`
    );

    originalFetch = global.fetch;
    global.fetch = createMockFetch() as unknown as typeof global.fetch;
    process.env.OPENAI_API_KEY = "test-key-privacy";

    minimem = await Minimem.create({
      memoryDir: tempDir,
      embedding: { provider: "openai" },
      watch: { enabled: false },
      hybrid: { enabled: true },
      query: { minScore: 0.0 },
    });

    await minimem.sync();
  });

  after(async () => {
    minimem?.close();
    global.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("does not include private content in search snippets", async () => {
    const results = await minimem.search("API key password secret credentials");

    // Check that no snippet contains the actual secret values
    for (const r of results) {
      assert.ok(
        !r.snippet.includes("sk-secret-key-12345"),
        "Snippet should not contain API key"
      );
      assert.ok(
        !r.snippet.includes("hunter2"),
        "Snippet should not contain DB password"
      );
      assert.ok(
        !r.snippet.includes("super-secret-password-123"),
        "Snippet should not contain production password"
      );
      assert.ok(
        !r.snippet.includes("AKIAIOSFODNN7EXAMPLE"),
        "Snippet should not contain AWS secret"
      );
    }
  });

  it("still indexes non-private content from files with private blocks", async () => {
    const results = await minimem.search("API endpoint rate limit documentation");

    assert.ok(results.length > 0, "Expected to find non-private content");

    const hasPublic = results.some(r =>
      r.snippet.toLowerCase().includes("api endpoint") ||
      r.snippet.toLowerCase().includes("rate limit") ||
      r.snippet.toLowerCase().includes("documentation") ||
      r.snippet.toLowerCase().includes("api.example.com")
    );
    assert.ok(hasPublic, "Should find public content from files with private blocks");
  });

  it("indexes content around private blocks correctly", async () => {
    const results = await minimem.search("staging database host port");

    assert.ok(results.length > 0, "Expected to find staging database content");

    const hasStaging = results.some(r =>
      r.snippet.toLowerCase().includes("staging")
    );
    assert.ok(hasStaging, "Should find staging database content after private block");
  });
});

describe("Minimem Schema Migration", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-migration-"));
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("migrates from schema v2 to v3, preserving embedding cache", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { ensureMemoryIndexSchema, SCHEMA_VERSION } = await import("../db/schema.js");

    const dbPath = path.join(tempDir, "migration-test.db");
    const db = new DatabaseSync(dbPath);

    // Set up a v2 database manually
    db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '2')`).run();

    db.exec(`CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);

    // Insert some data to verify migration drops tables
    db.prepare(`INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)`)
      .run("MEMORY.md", "memory", "abc123", 1000, 100);
    db.prepare(`INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("chunk1", "MEMORY.md", "memory", 1, 5, "hash1", "test", "text", "[]", 1000);

    // Create embedding cache with data that should be preserved
    db.exec(`CREATE TABLE IF NOT EXISTS embedding_cache (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    )`);
    db.prepare(`INSERT INTO embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run("openai", "text-embedding-3-small", "key1", "cachehash1", "[0.1, 0.2]", 2, 2000);

    // Run migration by calling ensureMemoryIndexSchema
    const result = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: true,
    });

    // Verify migration occurred
    assert.ok(result.migrated, "Migration should have been performed");

    // Verify schema version is now current
    const versionRow = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string };
    assert.equal(versionRow.value, String(SCHEMA_VERSION), "Schema version should be updated");

    // Verify old data was dropped (tables recreated empty)
    const fileCount = db.prepare(`SELECT COUNT(*) as count FROM files`).get() as { count: number };
    assert.equal(fileCount.count, 0, "Files table should be empty after migration");

    const chunkCount = db.prepare(`SELECT COUNT(*) as count FROM chunks`).get() as { count: number };
    assert.equal(chunkCount.count, 0, "Chunks table should be empty after migration");

    // Verify embedding cache was preserved
    const cacheCount = db.prepare(`SELECT COUNT(*) as count FROM embedding_cache`).get() as { count: number };
    assert.equal(cacheCount.count, 1, "Embedding cache should be preserved after migration");

    const cacheRow = db.prepare(`SELECT hash, embedding FROM embedding_cache WHERE hash = ?`).get("cachehash1") as { hash: string; embedding: string } | undefined;
    assert.ok(cacheRow, "Cached embedding should still exist");
    assert.equal(cacheRow.embedding, "[0.1, 0.2]", "Cached embedding data should be intact");

    // Verify the type column exists on chunks table
    const columns = db.prepare(`PRAGMA table_info(chunks)`).all() as Array<{ name: string }>;
    const hasTypeColumn = columns.some(c => c.name === "type");
    assert.ok(hasTypeColumn, "Chunks table should have 'type' column after migration");

    // Verify type index exists
    const indexes = db.prepare(`PRAGMA index_list(chunks)`).all() as Array<{ name: string }>;
    const hasTypeIndex = indexes.some(idx => idx.name === "idx_chunks_type");
    assert.ok(hasTypeIndex, "Should have idx_chunks_type index after migration");

    db.close();
  });

  it("fresh database (no prior version) does not trigger migration flag", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { ensureMemoryIndexSchema } = await import("../db/schema.js");

    const dbPath = path.join(tempDir, "fresh-test.db");
    const db = new DatabaseSync(dbPath);

    const result = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: true,
    });

    // Fresh database should not report migration
    assert.ok(!result.migrated, "Fresh database should not report migration");

    // But schema should be fully set up
    const columns = db.prepare(`PRAGMA table_info(chunks)`).all() as Array<{ name: string }>;
    const hasTypeColumn = columns.some(c => c.name === "type");
    assert.ok(hasTypeColumn, "Fresh database should have 'type' column");

    db.close();
  });

  it("same version does not re-migrate", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const { ensureMemoryIndexSchema, SCHEMA_VERSION } = await import("../db/schema.js");

    const dbPath = path.join(tempDir, "same-version-test.db");
    const db = new DatabaseSync(dbPath);

    // First call sets up schema
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: true,
    });

    // Insert some data
    db.prepare(`INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)`)
      .run("test.md", "memory", "hash", 1000, 50);

    // Second call should not drop data
    const result = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: true,
    });

    assert.ok(!result.migrated, "Same version should not trigger migration");

    // Data should still exist
    const fileCount = db.prepare(`SELECT COUNT(*) as count FROM files`).get() as { count: number };
    assert.equal(fileCount.count, 1, "Files should be preserved when no migration needed");

    db.close();
  });
});
