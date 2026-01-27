/**
 * CLI configuration loading and directory resolution
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { MinimemConfig } from "../minimem.js";
import type { EmbeddingProviderOptions } from "../embeddings/embeddings.js";

const CONFIG_FILENAME = "config.json";
const CONFIG_DIR = ".minimem";

export type CliConfig = {
  embedding?: Partial<EmbeddingProviderOptions>;
  hybrid?: {
    enabled?: boolean;
    vectorWeight?: number;
    textWeight?: number;
  };
  query?: {
    maxResults?: number;
    minScore?: number;
  };
  watch?: {
    enabled?: boolean;
    debounceMs?: number;
  };
};

export type ResolvedConfig = {
  memoryDir: string;
  config: CliConfig;
};

/**
 * Resolve the memory directory based on options
 *
 * Priority:
 * 1. --dir flag
 * 2. MEMORY_DIR environment variable
 * 3. --global flag → ~/.minimem
 * 4. Current working directory
 */
export function resolveMemoryDir(options: {
  dir?: string;
  global?: boolean;
}): string {
  if (options.dir) {
    return path.resolve(options.dir);
  }

  const envDir = process.env.MEMORY_DIR;
  if (envDir) {
    return path.resolve(envDir);
  }

  if (options.global) {
    return path.join(os.homedir(), ".minimem");
  }

  return process.cwd();
}

/**
 * Get the config file path for a memory directory
 */
export function getConfigPath(memoryDir: string): string {
  return path.join(memoryDir, CONFIG_DIR, CONFIG_FILENAME);
}

/**
 * Load config from a memory directory
 */
export async function loadConfig(memoryDir: string): Promise<CliConfig> {
  const configPath = getConfigPath(memoryDir);

  try {
    const content = await fs.readFile(configPath, "utf-8");
    return JSON.parse(content) as CliConfig;
  } catch {
    // Return defaults if config doesn't exist
    return {};
  }
}

/**
 * Save config to a memory directory
 */
export async function saveConfig(
  memoryDir: string,
  config: CliConfig,
): Promise<void> {
  const configDir = path.join(memoryDir, CONFIG_DIR);
  const configPath = getConfigPath(memoryDir);

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Get default config
 */
export function getDefaultConfig(): CliConfig {
  return {
    embedding: {
      provider: "auto",
    },
    hybrid: {
      enabled: true,
      vectorWeight: 0.7,
      textWeight: 0.3,
    },
    query: {
      maxResults: 10,
      minScore: 0.3,
    },
  };
}

/**
 * Merge configs with defaults
 */
export function mergeConfig(config: CliConfig): CliConfig {
  const defaults = getDefaultConfig();
  return {
    embedding: { ...defaults.embedding, ...config.embedding },
    hybrid: { ...defaults.hybrid, ...config.hybrid },
    query: { ...defaults.query, ...config.query },
  };
}

/**
 * Build MinimemConfig from CLI config and options
 */
export function buildMinimemConfig(
  memoryDir: string,
  cliConfig: CliConfig,
  options?: {
    provider?: string;
    watch?: boolean;
  },
): MinimemConfig {
  const merged = mergeConfig(cliConfig);

  // Resolve embedding provider
  const embeddingProvider = (options?.provider ||
    merged.embedding?.provider ||
    "auto") as EmbeddingProviderOptions["provider"];

  const embedding: EmbeddingProviderOptions = {
    provider: embeddingProvider,
    model: merged.embedding?.model,
    fallback: merged.embedding?.fallback,
    openai: merged.embedding?.openai,
    gemini: merged.embedding?.gemini,
    local: merged.embedding?.local,
  };

  return {
    memoryDir,
    embedding,
    hybrid: merged.hybrid,
    query: merged.query,
    watch: {
      enabled: options?.watch ?? false, // Disable watching by default in CLI
    },
  };
}

/**
 * Check if a directory is initialized as a minimem memory directory
 */
export async function isInitialized(memoryDir: string): Promise<boolean> {
  const configPath = getConfigPath(memoryDir);
  try {
    await fs.access(configPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a path for display (use ~ for home directory)
 */
export function formatPath(filePath: string): string {
  const home = os.homedir();
  if (filePath.startsWith(home)) {
    return "~" + filePath.slice(home.length);
  }
  return filePath;
}
