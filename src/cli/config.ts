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
import crypto from "node:crypto";

import type { MinimemConfig } from "../minimem.js";
import type { EmbeddingProviderOptions } from "../embeddings/embeddings.js";

const CONFIG_FILENAME = "config.json";
const CONFIG_DIR = ".minimem";
const GLOBAL_DIR = ".minimem";
// XDG-style global config directory for sync settings
const XDG_CONFIG_DIR = ".config/minimem";

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
  /** Sync configuration (for git-based syncing) */
  sync?: {
    /** Enable sync for this directory */
    enabled?: boolean;
    /** Path in central repo for this directory's memories */
    path?: string;
    /** Glob patterns for files to include in sync */
    include?: string[];
    /** Glob patterns for files to exclude from sync */
    exclude?: string[];
  };
};

/**
 * Global config stored at ~/.config/minimem/config.json
 * Contains settings that apply across all memory directories
 */
export type GlobalConfig = {
  /** Path to central repository for syncing */
  centralRepo?: string;
  /** Unique machine identifier for registry */
  machineId?: string;
  /** Global sync settings */
  sync?: {
    /** Default conflict resolution strategy */
    conflictStrategy?: "keep-both" | "merge" | "manual" | "last-write-wins";
    /** Enable automatic sync when daemon is running */
    autoSync?: boolean;
    /** Automatically commit changes to central repo */
    autoCommit?: boolean;
    /** External merge resolver command */
    mergeResolver?: string;
  };
  /** Embedding and other settings can be inherited */
  embedding?: CliConfig["embedding"];
  hybrid?: CliConfig["hybrid"];
  query?: CliConfig["query"];
  chunking?: CliConfig["chunking"];
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
 * Get the XDG-style global config directory (~/.config/minimem)
 */
export function getXdgConfigDir(): string {
  return path.join(os.homedir(), XDG_CONFIG_DIR);
}

/**
 * Get the XDG-style global config file path (~/.config/minimem/config.json)
 */
export function getXdgConfigPath(): string {
  return path.join(getXdgConfigDir(), CONFIG_FILENAME);
}

/**
 * Expand ~ to home directory in paths
 */
export function expandPath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  if (filePath === "~") {
    return os.homedir();
  }
  return filePath;
}

/**
 * Load XDG global config from ~/.config/minimem/config.json
 */
export async function loadXdgConfig(): Promise<GlobalConfig> {
  try {
    const content = await fs.readFile(getXdgConfigPath(), "utf-8");
    return JSON.parse(content) as GlobalConfig;
  } catch {
    return {};
  }
}

/**
 * Save XDG global config to ~/.config/minimem/config.json
 */
export async function saveXdgConfig(config: GlobalConfig): Promise<void> {
  const configDir = getXdgConfigDir();
  const configPath = getXdgConfigPath();

  await fs.mkdir(configDir, { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * Get or generate a unique machine ID
 * Format: {hostname}-{random4hex}
 * Stored in XDG global config
 */
export async function getMachineId(): Promise<string> {
  const globalConfig = await loadXdgConfig();

  if (globalConfig.machineId) {
    return globalConfig.machineId;
  }

  // Generate new machine ID
  const hostname = os.hostname().toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const suffix = crypto.randomBytes(2).toString("hex");
  const machineId = `${hostname}-${suffix}`;

  // Save to global config
  await saveXdgConfig({ ...globalConfig, machineId });

  return machineId;
}

/**
 * Get the central repo path from global config (expanded)
 */
export async function getCentralRepo(): Promise<string | undefined> {
  const globalConfig = await loadXdgConfig();
  if (globalConfig.centralRepo) {
    return expandPath(globalConfig.centralRepo);
  }
  return undefined;
}

/**
 * Set the central repo path in global config
 */
export async function setCentralRepo(repoPath: string): Promise<void> {
  const globalConfig = await loadXdgConfig();
  globalConfig.centralRepo = repoPath;
  await saveXdgConfig(globalConfig);
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

  if (source.sync) {
    result.sync = { ...target.sync, ...source.sync };
    // Arrays should be replaced, not merged
    if (source.sync.include) {
      result.sync.include = source.sync.include;
    }
    if (source.sync.exclude) {
      result.sync.exclude = source.sync.exclude;
    }
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
 * Get default sync configuration
 */
export function getDefaultSyncConfig(): NonNullable<CliConfig["sync"]> {
  return {
    enabled: false,
    include: ["MEMORY.md", "memory/**/*.md"],
    exclude: [],
  };
}

/**
 * Get default global sync settings
 */
export function getDefaultGlobalSyncConfig(): NonNullable<GlobalConfig["sync"]> {
  return {
    conflictStrategy: "keep-both",
    autoSync: false,
    autoCommit: false,
  };
}

/**
 * Load full config including XDG global settings
 * Resolution order:
 * 1. Built-in defaults
 * 2. XDG global config (~/.config/minimem/config.json)
 * 3. Legacy global config (~/.minimem/.minimem/config.json)
 * 4. Local config (.minimem/config.json in memory directory)
 */
export async function loadFullConfig(memoryDir: string): Promise<{
  local: CliConfig;
  global: GlobalConfig;
  merged: CliConfig;
}> {
  const globalDir = getGlobalDir();
  const isGlobalDir = path.resolve(memoryDir) === globalDir;

  // Load XDG global config
  const xdgConfig = await loadXdgConfig();

  // Load legacy global config (unless we're loading the global dir itself)
  const legacyGlobalConfig = isGlobalDir ? {} : await loadGlobalConfig();

  // Load local config
  const localConfig = await loadConfigFile(getConfigPath(memoryDir));

  // Merge: XDG → legacy global → local
  const merged = deepMergeConfig(
    deepMergeConfig(xdgConfig as CliConfig, legacyGlobalConfig),
    localConfig
  );

  return {
    local: localConfig,
    global: xdgConfig,
    merged,
  };
}

/**
 * Get sync config for a directory with defaults applied
 */
export async function getSyncConfig(memoryDir: string): Promise<{
  enabled: boolean;
  path?: string;
  include: string[];
  exclude: string[];
  centralRepo?: string;
  conflictStrategy: NonNullable<GlobalConfig["sync"]>["conflictStrategy"];
  autoSync: boolean;
  autoCommit: boolean;
  mergeResolver?: string;
}> {
  const { merged, global: xdgConfig } = await loadFullConfig(memoryDir);
  const defaults = getDefaultSyncConfig();
  const globalDefaults = getDefaultGlobalSyncConfig();

  return {
    enabled: merged.sync?.enabled ?? defaults.enabled ?? false,
    path: merged.sync?.path,
    include: merged.sync?.include ?? defaults.include,
    exclude: merged.sync?.exclude ?? defaults.exclude,
    centralRepo: xdgConfig.centralRepo ? expandPath(xdgConfig.centralRepo) : undefined,
    conflictStrategy: xdgConfig.sync?.conflictStrategy ?? globalDefaults.conflictStrategy,
    autoSync: xdgConfig.sync?.autoSync ?? globalDefaults.autoSync,
    autoCommit: xdgConfig.sync?.autoCommit ?? globalDefaults.autoCommit,
    mergeResolver: xdgConfig.sync?.mergeResolver,
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
