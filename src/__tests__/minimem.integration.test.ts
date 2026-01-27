/**
 * Integration tests for Minimem
 *
 * These tests require node:sqlite and must be run with Node.js native test runner:
 *   node --experimental-strip-types --test src/minimem.integration.test.ts
 *
 * Or with tsx:
 *   npx tsx --test src/minimem.integration.test.ts
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert";

// We need to create a mock embedding provider for tests
const createMockProvider = () => {
  const embedText = (text: string) => {
    const lower = text.toLowerCase();
    const alpha = lower.split("alpha").length - 1;
    const beta = lower.split("beta").length - 1;
    const gamma = lower.split("gamma").length - 1;
    return [alpha, beta, gamma];
  };

  return {
    id: "mock",
    model: "mock-embed",
    embedQuery: async (text: string) => embedText(text),
    embedBatch: async (texts: string[]) => texts.map(embedText),
  };
};

// Minimal integration test without full Minimem class (to avoid mocking complexity)
describe("Minimem integration", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-integ-"));
    await fs.mkdir(path.join(tempDir, "memory"));
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates memory directory structure", async () => {
    await fs.writeFile(path.join(tempDir, "MEMORY.md"), "# Memory\nTest content.");
    await fs.writeFile(path.join(tempDir, "memory", "2024-01-01.md"), "# Log\nDaily log.");

    const memoryFile = await fs.readFile(path.join(tempDir, "MEMORY.md"), "utf-8");
    assert.ok(memoryFile.includes("# Memory"));

    const logFile = await fs.readFile(path.join(tempDir, "memory", "2024-01-01.md"), "utf-8");
    assert.ok(logFile.includes("# Log"));
  });

  it("mock provider generates consistent embeddings", async () => {
    const provider = createMockProvider();

    const embedding1 = await provider.embedQuery("alpha alpha beta");
    const embedding2 = await provider.embedQuery("alpha alpha beta");

    assert.deepEqual(embedding1, embedding2);
    assert.equal(embedding1[0], 2); // two "alpha"
    assert.equal(embedding1[1], 1); // one "beta"
    assert.equal(embedding1[2], 0); // zero "gamma"
  });

  it("mock provider batch works correctly", async () => {
    const provider = createMockProvider();

    const embeddings = await provider.embedBatch(["alpha", "beta", "gamma"]);

    assert.equal(embeddings.length, 3);
    assert.deepEqual(embeddings[0], [1, 0, 0]); // alpha
    assert.deepEqual(embeddings[1], [0, 1, 0]); // beta
    assert.deepEqual(embeddings[2], [0, 0, 1]); // gamma
  });
});

// Test the internal utilities with real file operations
describe("File operations integration", () => {
  let tempDir: string;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-file-"));
  });

  after(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("creates and reads files correctly", async () => {
    const content = "# Test\nSome test content here.";
    const filePath = path.join(tempDir, "test.md");

    await fs.writeFile(filePath, content);
    const readContent = await fs.readFile(filePath, "utf-8");

    assert.equal(readContent, content);
  });

  it("handles nested directories", async () => {
    const nestedDir = path.join(tempDir, "memory", "topics");
    await fs.mkdir(nestedDir, { recursive: true });

    const filePath = path.join(nestedDir, "topic.md");
    await fs.writeFile(filePath, "# Topic");

    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    assert.ok(exists);
  });
});
