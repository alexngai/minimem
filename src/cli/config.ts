/**
 * CLI configuration loading and directory resolution
 *
 * Config resolution order (later overrides earlier):
 * 1. Built-in defaults
 * 2. Global config (~/.minimem/config.json)
 * 3. Local config (.minimem/config.json in memory directory)
 * 4. CLI flags and environment variables
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import type { MinimemConfig } from "../minimem.js";
import type { EmbeddingProviderOptions } from "../embeddings/embeddings.js";

const CONFIG_FILENAME = "config.json";
const CONFIG_DIR = ".minimem";
const GLOBAL_DIR = ".minimem";

export type CliConfig = {
  embedding?: {
    /** Embedding provider: "auto", "openai", "gemini", "local", "none" */
    provider?: EmbeddingProviderOptions["provider"];
    /** Model name (provider-specific) */
    model?: string;
    /** Fallback provider if primary fails */
    fallback?: EmbeddingProviderOptions["fallback"];
    /** OpenAI-specific settings */
    openai?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };
    /** Gemini-specific settings */
    gemini?: {
      apiKey?: string;
      baseUrl?: string;
      model?: string;
    };
    /** Local embedding settings */
    local?: {
      modelPath?: string;
      modelCacheDir?: string;
    };
  };
  hybrid?: {
    /** Enable hybrid search (vector + BM25) */
    enabled?: boolean;
    /** Weight for vector search results (0-1) */
    vectorWeight?: number;
    /** Weight for text/BM25 search results (0-1) */
    textWeight?: number;
  };
  query?: {
    /** Default max results */
    maxResults?: number;
    /** Default min score threshold (0-1) */
    minScore?: number;
  };
  watch?: {
    /** Enable file watching */
    enabled?: boolean;
    /** Debounce delay in ms */
    debounceMs?: number;
  };
  chunking?: {
    /** Target tokens per chunk */
    tokens?: number;
    /** Overlap tokens between chunks */
    overlap?: number;
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
 * Get the global config directory path (~/.minimem)
 */
export function getGlobalDir(): string {
  return path.join(os.homedir(), GLOBAL_DIR);
}

/**
 * Get the global config file path (~/.minimem/.minimem/config.json)
 * Note: Global directory follows same structure as other memory directories
 */
export function getGlobalConfigPath(): string {
  return path.join(getGlobalDir(), CONFIG_DIR, CONFIG_FILENAME);
}

/**
 * Get the config file path for a memory directory
 */
export function getConfigPath(memoryDir: string): string {
  return path.join(memoryDir, CONFIG_DIR, CONFIG_FILENAME);
}

/**
 * Load config from a specific file path
 */
async function loadConfigFile(configPath: string): Promise<CliConfig> {
  try {
    const content = await fs.readFile(configPath, "utf-8");
    return JSON.parse(content) as CliConfig;
  } catch {
    return {};
  }
}

/**
 * Load global config from ~/.minimem/config.json
 */
export async function loadGlobalConfig(): Promise<CliConfig> {
  return loadConfigFile(getGlobalConfigPath());
}

/**
 * Load config from a memory directory, layered on top of global config
 *
 * Resolution order:
 * 1. Built-in defaults
 * 2. Global config (~/.minimem/config.json)
 * 3. Local config (.minimem/config.json in memory directory)
 */
export async function loadConfig(memoryDir: string): Promise<CliConfig> {
  const globalDir = getGlobalDir();
  const isGlobalDir = path.resolve(memoryDir) === globalDir;

  // Load global config (unless we're loading the global dir itself)
  const globalConfig = isGlobalDir ? {} : await loadGlobalConfig();

  // Load local config
  const localConfig = await loadConfigFile(getConfigPath(memoryDir));

  // Deep merge: local overrides global
  return deepMergeConfig(globalConfig, localConfig);
}

/**
 * Deep merge two configs (source overrides target)
 */
function deepMergeConfig(target: CliConfig, source: CliConfig): CliConfig {
  const result: CliConfig = { ...target };

  if (source.embedding) {
    result.embedding = {
      ...target.embedding,
      ...source.embedding,
      openai: source.embedding.openai
        ? { ...target.embedding?.openai, ...source.embedding.openai }
        : target.embedding?.openai,
      gemini: source.embedding.gemini
        ? { ...target.embedding?.gemini, ...source.embedding.gemini }
        : target.embedding?.gemini,
      local: source.embedding.local
        ? { ...target.embedding?.local, ...source.embedding.local }
        : target.embedding?.local,
    };
  }

  if (source.hybrid) {
    result.hybrid = { ...target.hybrid, ...source.hybrid };
  }

  if (source.query) {
    result.query = { ...target.query, ...source.query };
  }

  if (source.watch) {
    result.watch = { ...target.watch, ...source.watch };
  }

  if (source.chunking) {
    result.chunking = { ...target.chunking, ...source.chunking };
  }

  return result;
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
 * Get default config with all settings
 */
export function getDefaultConfig(): CliConfig {
  return {
    embedding: {
      provider: "auto",
      // model is provider-specific, so no default here
      // fallback: "none" is implicit
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
    chunking: {
      tokens: 256,
      overlap: 32,
    },
  };
}

/**
 * Get a minimal config for new directories (doesn't include all defaults)
 * This is what gets written to config.json on init
 */
export function getInitConfig(): CliConfig {
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
  return deepMergeConfig(defaults, config);
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

  // Resolve embedding provider (CLI flag > config > default)
  const embeddingProvider = (options?.provider ||
    merged.embedding?.provider ||
    "auto") as EmbeddingProviderOptions["provider"];

  // Build embedding options, using provider-specific model if set
  const providerModel =
    embeddingProvider === "openai"
      ? merged.embedding?.openai?.model
      : embeddingProvider === "gemini"
        ? merged.embedding?.gemini?.model
        : undefined;

  const embedding: EmbeddingProviderOptions = {
    provider: embeddingProvider,
    model: merged.embedding?.model || providerModel,
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
    chunking: merged.chunking,
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
