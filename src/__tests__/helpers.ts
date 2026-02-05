/**
 * Shared test utilities for minimem tests
 *
 * These helpers provide deterministic, API-free testing of embedding
 * and search functionality.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";

/**
 * Create a deterministic embedding based on keyword presence.
 *
 * Returns a normalized vector where dimensions correspond to keyword
 * frequencies. This allows predictable test results without API calls.
 *
 * @param text - The text to embed
 * @param dims - Number of dimensions (default: 128)
 * @returns Normalized embedding vector
 */
export function createDeterministicEmbedding(text: string, dims = 128): number[] {
  const lower = text.toLowerCase();
  const keywords = [
    "project", "meeting", "todo", "bug", "feature", "api", "database", "user",
    "test", "deploy", "config", "error", "fix", "update", "review", "design",
    "alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta", "theta",
    "important", "urgent", "note", "remember", "decision", "action", "plan", "goal",
  ];

  const vec = new Array(dims).fill(0);

  // Set values based on keyword presence
  keywords.forEach((keyword, i) => {
    if (i < dims) {
      const count = (lower.match(new RegExp(keyword, "g")) || []).length;
      vec[i] = count * 0.5;
    }
  });

  // Add some variation based on text length and characters
  for (let i = 32; i < dims; i++) {
    vec[i] = (lower.charCodeAt(i % lower.length) || 0) / 1000;
  }

  // Normalize
  const magnitude = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0)) || 1;
  return vec.map(v => v / magnitude);
}

/**
 * Create a mock fetch function that returns deterministic embeddings.
 *
 * Handles OpenAI and Gemini embedding API endpoints.
 */
export function createMockFetch() {
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

    // Handle Gemini embeddings endpoint
    if (urlStr.includes("embedContent") || urlStr.includes("batchEmbedContents")) {
      const text = body.content?.parts?.[0]?.text || body.requests?.[0]?.content?.parts?.[0]?.text || "";
      const embedding = createDeterministicEmbedding(text);

      if (urlStr.includes("batchEmbedContents")) {
        const requests = body.requests || [];
        return {
          ok: true,
          status: 200,
          json: async () => ({
            embeddings: requests.map((req: { content?: { parts?: { text?: string }[] } }) => ({
              values: createDeterministicEmbedding(req.content?.parts?.[0]?.text || ""),
            })),
          }),
          text: async () => JSON.stringify({ embeddings: [] }),
        };
      }

      return {
        ok: true,
        status: 200,
        json: async () => ({ embedding: { values: embedding } }),
        text: async () => JSON.stringify({ embedding: { values: embedding } }),
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

/**
 * Capture console output for testing CLI commands.
 *
 * Returns an object with logs and errors arrays, plus a restore function.
 */
export function captureConsole() {
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

/**
 * Create a temporary directory for test isolation.
 *
 * @param prefix - Directory name prefix (default: "minimem-test-")
 * @returns Object with dir path and cleanup function
 */
export async function createTempDir(prefix = "minimem-test-"): Promise<{
  dir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Create a temporary directory with basic memory structure.
 *
 * Creates the directory with MEMORY.md and memory/ subdirectory.
 *
 * @param prefix - Directory name prefix
 * @returns Object with dir path, cleanup function, and paths to common files
 */
export async function createTempMemoryDir(prefix = "minimem-test-"): Promise<{
  dir: string;
  memoryFile: string;
  memorySubdir: string;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const memoryFile = path.join(dir, "MEMORY.md");
  const memorySubdir = path.join(dir, "memory");

  await fs.mkdir(memorySubdir, { recursive: true });
  await fs.writeFile(memoryFile, "# Memory\n\n");

  return {
    dir,
    memoryFile,
    memorySubdir,
    cleanup: async () => {
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Wait for a specified number of milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
