/**
 * Tests for CLI commands
 *
 * These tests exercise the CLI command functions directly.
 * Uses mock fetch for deterministic embeddings.
 *
 * Run with: npm run test:cli
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, before, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert";

import { init } from "../commands/init.js";
import { search } from "../commands/search.js";
import { sync } from "../commands/sync.js";
import { status } from "../commands/status.js";
import { append } from "../commands/append.js";
import { upsert } from "../commands/upsert.js";
import { resolveDirectories, ensureGlobalInitialized, getDirName } from "../commands/mcp.js";
import { isInitialized } from "../config.js";

// Deterministic embedding function
function createDeterministicEmbedding(text: string): number[] {
  const lower = text.toLowerCase();
  const keywords = [
    "project", "meeting", "todo", "bug", "feature", "api", "database", "user",
    "test", "deploy", "config", "error", "fix", "update", "review", "design",
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
    "important", "urgent", "note", "remember", "decision", "action", "plan", "goal",
  ];

  const vec = new Array(128).fill(0);

  keywords.forEach((keyword, i) => {
    const count = (lower.match(new RegExp(keyword, "g")) || []).length;
    vec[i] = count * 0.5;
  });

  for (let i = 32; i < 128; i++) {
    vec[i] = (lower.charCodeAt(i % lower.length) || 0) / 1000;
  }

  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map(v => v / magnitude);
}

// Mock fetch for embeddings
function createMockFetch() {
  return mock.fn(async (url: string | URL, init?: RequestInit) => {
    const urlStr = url.toString();
    const body = init?.body ? JSON.parse(init.body as string) : {};

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

    return {
      ok: false,
      status: 404,
      json: async () => ({ error: "Not found" }),
      text: async () => "Not found",
    };
  });
}

// Capture console output
function captureConsole() {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    logs.push(args.map(a => String(a)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(a => String(a)).join(" "));
  };

  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    },
  };
}

describe("CLI Commands", () => {
  let tempDir: string;
  let originalFetch: typeof fetch;
  let mockFetch: ReturnType<typeof createMockFetch>;
  let originalExit: typeof process.exit;
  let exitCode: number | undefined;

  before(() => {
    // Mock fetch globally
    originalFetch = globalThis.fetch;
    mockFetch = createMockFetch();
    globalThis.fetch = mockFetch as unknown as typeof fetch;

    // Set API key for tests
    process.env.OPENAI_API_KEY = "test-key";

    // Mock process.exit to prevent test from exiting
    originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit;
  });

  after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    process.exit = originalExit;
  });

  beforeEach(async () => {
    // Create fresh temp directory for each test
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-cli-test-"));
    exitCode = undefined;
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("init command", () => {
    it("should initialize a new memory directory", async () => {
      const capture = captureConsole();

      try {
        await init(tempDir, { global: false, force: false });
      } finally {
        capture.restore();
      }

      // Check files were created
      const memoryMd = await fs.readFile(path.join(tempDir, "MEMORY.md"), "utf-8");
      assert.ok(memoryMd.includes("# Memory"), "MEMORY.md should have header");

      const configPath = path.join(tempDir, ".minimem", "config.json");
      const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
      assert.strictEqual(config.embedding.provider, "auto");

      const memoryDir = await fs.stat(path.join(tempDir, "memory"));
      assert.ok(memoryDir.isDirectory(), "memory/ directory should exist");

      // Check output
      assert.ok(capture.logs.some(l => l.includes("Initializing")));
      assert.ok(capture.logs.some(l => l.includes("Done!")));
    });

    it("should not reinitialize without --force", async () => {
      // Initialize first
      await init(tempDir, { global: false, force: false });

      const capture = captureConsole();
      try {
        await init(tempDir, { global: false, force: false });
      } finally {
        capture.restore();
      }

      // Should indicate already initialized (logs to stdout, not stderr)
      assert.ok(capture.logs.some(l => l.includes("Already initialized")));
    });

    it("should reinitialize with --force", async () => {
      // Initialize first
      await init(tempDir, { global: false, force: false });

      // Modify MEMORY.md
      await fs.writeFile(path.join(tempDir, "MEMORY.md"), "Custom content");

      const capture = captureConsole();
      try {
        await init(tempDir, { global: false, force: true });
      } finally {
        capture.restore();
      }

      // Check MEMORY.md was NOT overwritten (force only resets config)
      const memoryMd = await fs.readFile(path.join(tempDir, "MEMORY.md"), "utf-8");
      assert.strictEqual(memoryMd, "Custom content");

      assert.ok(capture.logs.some(l => l.includes("Done!")));
    });
  });

  describe("upsert command", () => {
    beforeEach(async () => {
      // Initialize memory directory
      await init(tempDir, { global: false, force: false });
    });

    it("should create a new file", async () => {
      const capture = captureConsole();

      try {
        await upsert("test-note.md", "# Test Note\n\nThis is a test.", { dir: tempDir });
      } finally {
        capture.restore();
      }

      const content = await fs.readFile(path.join(tempDir, "test-note.md"), "utf-8");
      assert.strictEqual(content, "# Test Note\n\nThis is a test.");
      assert.ok(capture.logs.some(l => l.includes("Created")));
    });

    it("should update an existing file", async () => {
      // Create file first
      await fs.writeFile(path.join(tempDir, "existing.md"), "Old content");

      const capture = captureConsole();

      try {
        await upsert("existing.md", "New content", { dir: tempDir });
      } finally {
        capture.restore();
      }

      const content = await fs.readFile(path.join(tempDir, "existing.md"), "utf-8");
      assert.strictEqual(content, "New content");
      assert.ok(capture.logs.some(l => l.includes("Updated")));
    });

    it("should create file in memory/ subdirectory", async () => {
      const capture = captureConsole();

      try {
        await upsert("memory/notes.md", "# Notes", { dir: tempDir });
      } finally {
        capture.restore();
      }

      const content = await fs.readFile(path.join(tempDir, "memory", "notes.md"), "utf-8");
      assert.strictEqual(content, "# Notes");
    });

    it("should reject paths outside memory directory", async () => {
      const capture = captureConsole();

      try {
        await upsert("/tmp/outside.md", "Bad content", { dir: tempDir });
        assert.fail("Should have exited");
      } catch (e) {
        // Expected
      } finally {
        capture.restore();
      }

      assert.ok(capture.errors.some(l => l.includes("must be within")));
    });
  });

  describe("append command", () => {
    beforeEach(async () => {
      await init(tempDir, { global: false, force: false });
    });

    it("should append to today's daily log", async () => {
      const capture = captureConsole();

      try {
        await append("Test entry 1", { dir: tempDir });
        await append("Test entry 2", { dir: tempDir });
      } finally {
        capture.restore();
      }

      // Check today's log file
      const today = new Date().toISOString().split("T")[0];
      const logPath = path.join(tempDir, "memory", `${today}.md`);
      const content = await fs.readFile(logPath, "utf-8");

      assert.ok(content.includes("Test entry 1"));
      assert.ok(content.includes("Test entry 2"));
    });

    it("should append to specific file with --file", async () => {
      const capture = captureConsole();

      try {
        // Must use valid memory path (memory/*.md)
        await append("Custom entry", { dir: tempDir, file: "memory/custom-log.md" });
      } finally {
        capture.restore();
      }

      const content = await fs.readFile(path.join(tempDir, "memory", "custom-log.md"), "utf-8");
      assert.ok(content.includes("Custom entry"));
    });
  });

  describe("sync command", () => {
    beforeEach(async () => {
      await init(tempDir, { global: false, force: false });

      // Add some content to index
      await fs.writeFile(
        path.join(tempDir, "MEMORY.md"),
        "# Memory\n\nImportant project decisions here."
      );
      await fs.writeFile(
        path.join(tempDir, "memory", "notes.md"),
        "# Notes\n\nMeeting notes about the API design."
      );
    });

    it("should sync memory files", async () => {
      const capture = captureConsole();

      try {
        await sync({ dir: tempDir, force: false });
      } finally {
        capture.restore();
      }

      assert.ok(capture.logs.some(l => l.includes("Syncing")));
      assert.ok(capture.logs.some(l => l.includes("Files:") || l.includes("Chunks:")));
    });

    it("should force full re-index with --force", async () => {
      // First sync
      await sync({ dir: tempDir, force: false });

      const capture = captureConsole();

      try {
        await sync({ dir: tempDir, force: true });
      } finally {
        capture.restore();
      }

      // Force sync should complete and show results
      assert.ok(capture.logs.some(l => l.includes("Sync complete")));
      assert.ok(capture.logs.some(l => l.includes("Files:")));
    });
  });

  describe("status command", () => {
    beforeEach(async () => {
      await init(tempDir, { global: false, force: false });
      await fs.writeFile(
        path.join(tempDir, "MEMORY.md"),
        "# Memory\n\nTest content."
      );
    });

    it("should show index status", async () => {
      const capture = captureConsole();

      try {
        await status({ dir: tempDir });
      } finally {
        capture.restore();
      }

      assert.ok(capture.logs.some(l => l.includes("Provider") || l.includes("provider")));
      assert.ok(capture.logs.some(l => l.includes("Files") || l.includes("files")));
    });

    it("should output JSON with --json flag", async () => {
      const capture = captureConsole();

      try {
        await status({ dir: tempDir, json: true });
      } finally {
        capture.restore();
      }

      // Should have valid JSON output
      const jsonOutput = capture.logs.find(l => l.startsWith("{"));
      assert.ok(jsonOutput, "Should have JSON output");

      const parsed = JSON.parse(jsonOutput);
      assert.ok("provider" in parsed || "files" in parsed || "chunks" in parsed);
    });
  });

  describe("search command", () => {
    beforeEach(async () => {
      await init(tempDir, { global: false, force: false });

      // Create searchable content
      await fs.writeFile(
        path.join(tempDir, "MEMORY.md"),
        `# Memory

## Project Decisions
We decided to use PostgreSQL for the database.
The API will use REST endpoints.

## Meeting Notes
Important meeting about project planning.
`
      );

      await fs.writeFile(
        path.join(tempDir, "memory", "bugs.md"),
        `# Bug Tracker

## Bug #1: Login Error
Users report login errors when password contains special characters.
This is an urgent bug fix needed.
`
      );

      // Sync to index the content
      await sync({ dir: tempDir, force: false });
    });

    it("should search memory files", async () => {
      const capture = captureConsole();

      try {
        await search("database decision", { dir: [tempDir] });
      } finally {
        capture.restore();
      }

      // Should find results
      assert.ok(
        capture.logs.some(l => l.includes("result") || l.includes("%")),
        "Should show search results"
      );
    });

    it("should output JSON with --json flag", async () => {
      const capture = captureConsole();

      try {
        await search("project", { dir: [tempDir], json: true });
      } finally {
        capture.restore();
      }

      const jsonOutput = capture.logs.find(l => l.startsWith("["));
      assert.ok(jsonOutput, "Should have JSON array output");

      const results = JSON.parse(jsonOutput);
      assert.ok(Array.isArray(results));
    });

    it("should respect --max option", async () => {
      const capture = captureConsole();

      try {
        await search("project", { dir: [tempDir], max: "1" });
      } finally {
        capture.restore();
      }

      // Count result entries (lines with percentage scores)
      const resultLines = capture.logs.filter(l => l.match(/\[\d+\.\d+%\]/));
      assert.ok(resultLines.length <= 1, "Should have at most 1 result");
    });

    it("should search multiple directories", async () => {
      // Create second memory directory
      const tempDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-cli-test2-"));

      try {
        await init(tempDir2, { global: false, force: false });
        await fs.writeFile(
          path.join(tempDir2, "MEMORY.md"),
          "# Second Memory\n\nDifferent project notes about testing."
        );
        await sync({ dir: tempDir2, force: false });

        const capture = captureConsole();

        try {
          await search("project", { dir: [tempDir, tempDir2] });
        } finally {
          capture.restore();
        }

        // Should mention searching multiple directories
        assert.ok(
          capture.logs.some(l => l.includes("directories") || l.includes("result")),
          "Should search across directories"
        );
      } finally {
        await fs.rm(tempDir2, { recursive: true, force: true });
      }
    });

    it("should warn about uninitialized directories", async () => {
      const capture = captureConsole();
      const nonExistent = path.join(tempDir, "nonexistent");

      try {
        await search("test", { dir: [tempDir, nonExistent] });
      } finally {
        capture.restore();
      }

      assert.ok(
        capture.errors.some(l => l.includes("not initialized") || l.includes("skipping")),
        "Should warn about uninitialized directory"
      );
    });
  });

  describe("mcp command helpers", () => {
    describe("resolveDirectories", () => {
      it("should use current directory by default", () => {
        const dirs = resolveDirectories({});
        assert.strictEqual(dirs.length, 1);
        assert.strictEqual(dirs[0], process.cwd());
      });

      it("should use specified directories", () => {
        const dirs = resolveDirectories({ dir: ["/path/one", "/path/two"] });
        assert.strictEqual(dirs.length, 2);
        assert.ok(dirs[0].endsWith("one"));
        assert.ok(dirs[1].endsWith("two"));
      });

      it("should add global directory with --global flag", () => {
        const dirs = resolveDirectories({ global: true });
        assert.strictEqual(dirs.length, 1);
        assert.ok(dirs[0].endsWith(".minimem"), "Should include global directory");
      });

      it("should combine --dir and --global", () => {
        const dirs = resolveDirectories({ dir: ["/path/project"], global: true });
        assert.strictEqual(dirs.length, 2);
        assert.ok(dirs[0].endsWith("project"));
        assert.ok(dirs[1].endsWith(".minimem"));
      });

      it("should not duplicate global directory", () => {
        const globalPath = path.join(os.homedir(), ".minimem");
        const dirs = resolveDirectories({ dir: [globalPath], global: true });
        assert.strictEqual(dirs.length, 1);
        assert.strictEqual(dirs[0], globalPath);
      });
    });

    describe("getDirName", () => {
      it("should return 'global' for ~/.minimem", () => {
        const globalDir = path.join(os.homedir(), ".minimem");
        assert.strictEqual(getDirName(globalDir), "global");
      });

      it("should return directory name for regular paths", () => {
        assert.strictEqual(getDirName("/path/to/my-project"), "my-project");
      });

      it("should include parent for hidden directories", () => {
        const name = getDirName("/path/to/project/.hidden");
        assert.ok(name.includes("project"));
        assert.ok(name.includes(".hidden"));
      });
    });

    describe("ensureGlobalInitialized", () => {
      it("should create global directory structure", async () => {
        const fakeGlobalDir = path.join(tempDir, ".fake-minimem");

        const capture = captureConsole();
        try {
          await ensureGlobalInitialized(fakeGlobalDir);
        } finally {
          capture.restore();
        }

        // Check directory was created
        assert.ok(await isInitialized(fakeGlobalDir), "Should be initialized");

        // Check MEMORY.md exists with global template
        const memoryMd = await fs.readFile(path.join(fakeGlobalDir, "MEMORY.md"), "utf-8");
        assert.ok(memoryMd.includes("Global Memory"), "Should have global template");

        // Check config exists
        const configPath = path.join(fakeGlobalDir, ".minimem", "config.json");
        const config = JSON.parse(await fs.readFile(configPath, "utf-8"));
        assert.strictEqual(config.embedding.provider, "auto");

        // Check .gitignore exists
        const gitignore = await fs.readFile(
          path.join(fakeGlobalDir, ".minimem", ".gitignore"),
          "utf-8"
        );
        assert.ok(gitignore.includes("index.db"));

        // Check output messages
        assert.ok(capture.errors.some(l => l.includes("Auto-initializing")));
        assert.ok(capture.errors.some(l => l.includes("Created")));
      });

      it("should not overwrite existing MEMORY.md", async () => {
        const fakeGlobalDir = path.join(tempDir, ".fake-minimem2");

        // Pre-create with custom content
        await fs.mkdir(fakeGlobalDir, { recursive: true });
        await fs.writeFile(path.join(fakeGlobalDir, "MEMORY.md"), "My custom content");

        const capture = captureConsole();
        try {
          await ensureGlobalInitialized(fakeGlobalDir);
        } finally {
          capture.restore();
        }

        // Check MEMORY.md was preserved
        const memoryMd = await fs.readFile(path.join(fakeGlobalDir, "MEMORY.md"), "utf-8");
        assert.strictEqual(memoryMd, "My custom content", "Should preserve existing MEMORY.md");
      });
    });
  });
});
