/**
 * minimem config - View and manage configuration
 */

import {
  resolveMemoryDir,
  loadConfig,
  loadGlobalConfig,
  saveConfig,
  getConfigPath,
  getGlobalConfigPath,
  mergeConfig,
  getDefaultConfig,
  isInitialized,
  formatPath,
  type CliConfig,
} from "../config.js";

export type ConfigOptions = {
  dir?: string;
  global?: boolean;
  json?: boolean;
  set?: string;
  unset?: string;
};

export async function config(options: ConfigOptions): Promise<void> {
  // Handle --set and --unset
  if (options.set || options.unset) {
    await handleConfigEdit(options);
    return;
  }

  // Show config
  await showConfig(options);
}

async function showConfig(options: ConfigOptions): Promise<void> {
  const memoryDir = resolveMemoryDir({ dir: options.dir, global: options.global });

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    process.exit(1);
  }

  // Load configs
  const globalConfig = await loadGlobalConfig();
  const localConfig = await loadConfig(memoryDir);
  const mergedConfig = mergeConfig(localConfig);
  const defaults = getDefaultConfig();

  if (options.json) {
    console.log(JSON.stringify({
      effective: mergedConfig,
      local: localConfig,
      global: globalConfig,
      defaults,
    }, null, 2));
    return;
  }

  console.log("Minimem Configuration");
  console.log("=====================");
  console.log();

  console.log("Config Files:");
  console.log(`  Global:  ${formatPath(getGlobalConfigPath())}`);
  console.log(`  Local:   ${formatPath(getConfigPath(memoryDir))}`);
  console.log();

  console.log("Effective Configuration:");
  console.log("(merged from defaults → global → local)");
  console.log();

  printConfigSection("Embedding", {
    "provider": mergedConfig.embedding?.provider,
    "model": mergedConfig.embedding?.model || "(provider default)",
    "fallback": mergedConfig.embedding?.fallback || "none",
  });

  printConfigSection("Hybrid Search", {
    "enabled": mergedConfig.hybrid?.enabled,
    "vectorWeight": mergedConfig.hybrid?.vectorWeight,
    "textWeight": mergedConfig.hybrid?.textWeight,
  });

  printConfigSection("Query Defaults", {
    "maxResults": mergedConfig.query?.maxResults,
    "minScore": mergedConfig.query?.minScore,
  });

  printConfigSection("Chunking", {
    "tokens": mergedConfig.chunking?.tokens,
    "overlap": mergedConfig.chunking?.overlap,
  });

  console.log();
  console.log("To modify configuration:");
  console.log("  minimem config --set embedding.provider=openai");
  console.log("  minimem config --set query.maxResults=20");
  console.log("  minimem config --global --set embedding.model=text-embedding-3-large");
}

function printConfigSection(title: string, values: Record<string, unknown>): void {
  console.log(`  ${title}:`);
  for (const [key, value] of Object.entries(values)) {
    const displayValue = value === undefined ? "(default)" : String(value);
    console.log(`    ${key}: ${displayValue}`);
  }
}

async function handleConfigEdit(options: ConfigOptions): Promise<void> {
  const memoryDir = resolveMemoryDir({ dir: options.dir, global: options.global });
  const configPath = getConfigPath(memoryDir);

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    process.exit(1);
  }

  // Load current config (just the local file, not merged)
  const currentConfig = await loadConfigFile(configPath);

  if (options.set) {
    const [path, value] = options.set.split("=");
    if (!path || value === undefined) {
      console.error("Error: --set requires format: key.path=value");
      console.error("Example: --set embedding.provider=openai");
      process.exit(1);
    }

    const newConfig = setConfigValue(currentConfig, path, parseValue(value));
    await saveConfig(memoryDir, newConfig);
    console.log(`Set ${path}=${value} in ${formatPath(configPath)}`);
  }

  if (options.unset) {
    const path = options.unset;
    const newConfig = unsetConfigValue(currentConfig, path);
    await saveConfig(memoryDir, newConfig);
    console.log(`Unset ${path} in ${formatPath(configPath)}`);
  }
}

async function loadConfigFile(configPath: string): Promise<CliConfig> {
  const fs = await import("node:fs/promises");
  try {
    const content = await fs.readFile(configPath, "utf-8");
    return JSON.parse(content) as CliConfig;
  } catch {
    return {};
  }
}

function parseValue(value: string): unknown {
  // Try to parse as JSON (for booleans, numbers, etc.)
  try {
    return JSON.parse(value);
  } catch {
    // Return as string
    return value;
  }
}

function setConfigValue(config: CliConfig, path: string, value: unknown): CliConfig {
  const parts = path.split(".");
  const result = { ...config };
  let current: Record<string, unknown> = result;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== "object") {
      current[key] = {};
    } else {
      current[key] = { ...(current[key] as Record<string, unknown>) };
    }
    current = current[key] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]] = value;
  return result;
}

function unsetConfigValue(config: CliConfig, path: string): CliConfig {
  const parts = path.split(".");
  const result = { ...config };
  let current: Record<string, unknown> = result;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== "object") {
      return result; // Path doesn't exist
    }
    current[key] = { ...(current[key] as Record<string, unknown>) };
    current = current[key] as Record<string, unknown>;
  }

  delete current[parts[parts.length - 1]];
  return result;
}
