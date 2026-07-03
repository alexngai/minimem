/**
 * Interactive embedding-provider setup for `minimem init`.
 *
 * Keeps the base install tiny (no bundled models) while making the first-run
 * experience explicit instead of silently degrading to keyword-only search.
 *
 * Behavior:
 * - An explicit `--provider` flag is always honored, no prompting.
 * - Otherwise, if an embedding API key is present in the environment, we use
 *   it automatically (best quality, zero download).
 * - Otherwise, in an interactive terminal we offer three paths: use a hosted
 *   provider (paste a key), download a local model, or keyword-only for now.
 * - In non-interactive contexts we default to keyword-only ("auto", which
 *   behaves as BM25 today and auto-upgrades if a key appears later) and print
 *   how to enable semantic search.
 */

import fs from "node:fs/promises";

import type { CliConfig } from "./config.js";
import {
  getGlobalDir,
  getGlobalConfigPath,
  loadGlobalConfig,
  saveConfig,
  formatPath,
} from "./config.js";
import { isInteractive, promptSelect, promptSecret } from "./prompts.js";

type Embedding = NonNullable<CliConfig["embedding"]>;
type HostedProvider = "openai" | "gemini";

export type InitEmbeddingResult = {
  /** Embedding block to write into the local config.json */
  embedding: Embedding;
  /** Messages to print after the config is written */
  messages: string[];
};

const LOCAL_MODEL_SIZE = "~320 MB";

function detectEnvKey(): HostedProvider | null {
  if (process.env.OPENAI_API_KEY?.trim()) return "openai";
  if (process.env.GOOGLE_API_KEY?.trim() || process.env.GEMINI_API_KEY?.trim()) {
    return "gemini";
  }
  return null;
}

function keywordOnlyNotice(): string[] {
  return [
    "No embedding API key detected — using keyword-only (BM25) search for now.",
    "  Semantic search stays off until you enable a provider:",
    "    • export OPENAI_API_KEY=...   (or GEMINI_API_KEY / GOOGLE_API_KEY), then: minimem sync",
    "    • or download a local model:  minimem config --set embedding.provider=local && minimem sync",
  ];
}

/**
 * Persist a hosted-provider API key to the global config (outside any project
 * repo) with owner-only permissions, so it's never written into a checked-in
 * local config.json. Env vars still take precedence at runtime.
 */
async function storeGlobalKey(
  provider: HostedProvider,
  apiKey: string,
): Promise<string> {
  const globalConfig = await loadGlobalConfig();
  globalConfig.embedding = {
    ...globalConfig.embedding,
    [provider]: { ...globalConfig.embedding?.[provider], apiKey },
  };
  await saveConfig(getGlobalDir(), globalConfig);

  const configPath = getGlobalConfigPath();
  try {
    await fs.chmod(configPath, 0o600);
  } catch {
    // best-effort; not all filesystems support chmod
  }
  return configPath;
}

async function localModelAvailable(): Promise<boolean> {
  try {
    await import("node-llama-cpp");
    return true;
  } catch {
    return false;
  }
}

/**
 * Handle the interactive "use a hosted provider" branch.
 * Returns null if the user backed out (empty key), so the caller can fall
 * back to keyword-only.
 */
async function setupHostedProvider(): Promise<InitEmbeddingResult | null> {
  const providerIdx = await promptSelect(
    "Which provider?",
    [
      { label: "OpenAI", hint: "text-embedding-3-small" },
      { label: "Gemini", hint: "text-embedding-004" },
    ],
    0,
  );
  const provider: HostedProvider = providerIdx === 1 ? "gemini" : "openai";

  const envKey = detectEnvKey();
  if (envKey === provider) {
    return {
      embedding: { provider },
      messages: [`Using ${provider} embeddings from your environment.`],
    };
  }

  const key = await promptSecret(`Paste your ${provider} API key (input hidden): `);
  if (!key) {
    return null;
  }

  const storedAt = await storeGlobalKey(provider, key);
  return {
    embedding: { provider },
    messages: [
      `Saved ${provider} API key to ${formatPath(storedAt)} (permissions 600).`,
      "  Tip: an env var of the same name overrides this at runtime.",
    ],
  };
}

/**
 * Resolve the embedding configuration to write on init, prompting the user
 * when appropriate.
 */
export async function resolveInitEmbedding(opts: {
  provider?: string;
  yes?: boolean;
}): Promise<InitEmbeddingResult> {
  // 1. Explicit --provider always wins, no prompting.
  if (opts.provider) {
    const provider = opts.provider as Embedding["provider"];
    const messages: string[] = [`Embedding provider: ${provider} (from --provider).`];
    if ((provider === "openai" || provider === "gemini") && detectEnvKey() !== provider) {
      messages.push(
        `  Note: no ${provider} key found in the environment — set one before running searches.`,
      );
    }
    if (provider === "local") {
      messages.push(
        `  A local model (${LOCAL_MODEL_SIZE}) will download on first sync.`,
      );
    }
    return { embedding: { provider }, messages };
  }

  // 2. Environment key present → use it automatically.
  const envKey = detectEnvKey();
  if (envKey) {
    const envVar = envKey === "openai" ? "OPENAI_API_KEY" : "GEMINI_API_KEY/GOOGLE_API_KEY";
    return {
      embedding: { provider: "auto" },
      messages: [`Detected ${envVar} — semantic search enabled via ${envKey}.`],
    };
  }

  // 3. No key, non-interactive → keyword-only default (auto-upgrades later).
  if (opts.yes || !isInteractive()) {
    return { embedding: { provider: "auto" }, messages: keywordOnlyNotice() };
  }

  // 4. No key, interactive → let the user choose.
  const choice = await promptSelect(
    "\nHow should minimem embed your memories for semantic search?",
    [
      { label: "Use a hosted provider (OpenAI/Gemini)", hint: "best quality, needs an API key" },
      { label: "Download a local model", hint: `${LOCAL_MODEL_SIZE}, runs offline, no key` },
      { label: "Keyword-only for now", hint: "fastest, upgrade anytime" },
    ],
    0,
  );

  if (choice === 0) {
    const hosted = await setupHostedProvider();
    if (hosted) return hosted;
    // Backed out — fall through to keyword-only.
    return { embedding: { provider: "auto" }, messages: keywordOnlyNotice() };
  }

  if (choice === 1) {
    const available = await localModelAvailable();
    const messages = [
      `Local embeddings selected. A model (${LOCAL_MODEL_SIZE}) will download on first sync.`,
    ];
    if (!available) {
      messages.push(
        "  Note: optional dependency 'node-llama-cpp' isn't installed yet;",
        "  install it with: npm install -g node-llama-cpp",
      );
    }
    return { embedding: { provider: "local" }, messages };
  }

  return { embedding: { provider: "auto" }, messages: keywordOnlyNotice() };
}
