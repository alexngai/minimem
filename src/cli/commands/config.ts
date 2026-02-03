/**
 * minimem config - View and manage configuration
 */

import {
  resolveMemoryDir,
  loadConfig,
  loadGlobalConfig,
  loadXdgConfig,
  saveConfig,
  saveXdgConfig,
  getConfigPath,
  getGlobalConfigPath,
  getXdgConfigPath,
  mergeConfig,
  getDefaultConfig,
  getSyncConfig,
  isInitialized,
  formatPath,
  type CliConfig,
  type GlobalConfig,
} from "../config.js";

export type ConfigOptions = {
  dir?: string;
  global?: boolean;
  xdgGlobal?: boolean;
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
  const xdgConfig = await loadXdgConfig();
  const localConfig = await loadConfig(memoryDir);
  const mergedConfig = mergeConfig(localConfig);
  const syncConfig = await getSyncConfig(memoryDir);
  const defaults = getDefaultConfig();

  if (options.json) {
    console.log(JSON.stringify({
      effective: mergedConfig,
      local: localConfig,
      global: globalConfig,
      xdgGlobal: xdgConfig,
      syncConfig,
      defaults,
    }, null, 2));
    return;
  }

  console.log("Minimem Configuration");
  console.log("=====================");
  console.log();

  console.log("Config Files:");
  console.log(`  XDG Global:    ${formatPath(getXdgConfigPath())}`);
  console.log(`  Legacy Global: ${formatPath(getGlobalConfigPath())}`);
  console.log(`  Local:         ${formatPath(getConfigPath(memoryDir))}`);
  console.log();

  console.log("Effective Configuration:");
  console.log("(merged from defaults → xdg global → legacy global → local)");
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

  printConfigSection("Sync (Local)", {
    "enabled": syncConfig.enabled,
    "path": syncConfig.path || "(not configured)",
    "include": syncConfig.include.join(", "),
    "exclude": syncConfig.exclude.length > 0 ? syncConfig.exclude.join(", ") : "(none)",
  });

  printConfigSection("Sync (Global)", {
    "centralRepo": syncConfig.centralRepo || "(not configured)",
    "conflictStrategy": syncConfig.conflictStrategy,
    "autoSync": syncConfig.autoSync,
    "autoCommit": syncConfig.autoCommit,
    "mergeResolver": syncConfig.mergeResolver || "(default)",
  });

  console.log();
  console.log("To modify configuration:");
  console.log("  minimem config --set embedding.provider=openai");
  console.log("  minimem config --set sync.enabled=true");
  console.log("  minimem config --set sync.path=myproject/");
  console.log();
  console.log("Global sync settings (use --xdg-global flag):");
  console.log("  minimem config --xdg-global --set centralRepo=~/memories-repo");
  console.log("  minimem config --xdg-global --set sync.conflictStrategy=merge");
}

function printConfigSection(title: string, values: Record<string, unknown>): void {
  console.log(`  ${title}:`);
  for (const [key, value] of Object.entries(values)) {
    const displayValue = value === undefined ? "(default)" : String(value);
    console.log(`    ${key}: ${displayValue}`);
  }
}

async function handleConfigEdit(options: ConfigOptions): Promise<void> {
  // Handle XDG global config edits
  if (options.xdgGlobal) {
    await handleXdgConfigEdit(options);
    return;
  }

  const memoryDir = resolveMemoryDir({ dir: options.dir, global: options.global });
  const configPath = getConfigPath(memoryDir);

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    process.exit(1);
  }

  // Load current config (just the local file, not merged)
  const currentConfig = await loadConfigFile(configPath);

  if (options.set) {
    const [keyPath, value] = options.set.split("=");
    if (!keyPath || value === undefined) {
      console.error("Error: --set requires format: key.path=value");
      console.error("Example: --set embedding.provider=openai");
      process.exit(1);
    }

    const newConfig = setConfigValue(currentConfig, keyPath, parseValue(value));
    await saveConfig(memoryDir, newConfig);
    console.log(`Set ${keyPath}=${value} in ${formatPath(configPath)}`);
  }

  if (options.unset) {
    const keyPath = options.unset;
    const newConfig = unsetConfigValue(currentConfig, keyPath);
    await saveConfig(memoryDir, newConfig);
    console.log(`Unset ${keyPath} in ${formatPath(configPath)}`);
  }
}

async function handleXdgConfigEdit(options: ConfigOptions): Promise<void> {
  const configPath = getXdgConfigPath();
  const currentConfig = await loadXdgConfig();

  if (options.set) {
    const [keyPath, value] = options.set.split("=");
    if (!keyPath || value === undefined) {
      console.error("Error: --set requires format: key.path=value");
      console.error("Example: --set centralRepo=~/memories-repo");
      process.exit(1);
    }

    const newConfig = setConfigValue(currentConfig as Record<string, unknown>, keyPath, parseValue(value)) as GlobalConfig;
    await saveXdgConfig(newConfig);
    console.log(`Set ${keyPath}=${value} in ${formatPath(configPath)}`);
  }

  if (options.unset) {
    const keyPath = options.unset;
    const newConfig = unsetConfigValue(currentConfig as Record<string, unknown>, keyPath) as GlobalConfig;
    await saveXdgConfig(newConfig);
    console.log(`Unset ${keyPath} in ${formatPath(configPath)}`);
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

function setConfigValue<T extends Record<string, unknown>>(config: T, keyPath: string, value: unknown): T {
  const parts = keyPath.split(".");
  const result = { ...config } as Record<string, unknown>;
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
  return result as T;
}

function unsetConfigValue<T extends Record<string, unknown>>(config: T, keyPath: string): T {
  const parts = keyPath.split(".");
  const result = { ...config } as Record<string, unknown>;
  let current: Record<string, unknown> = result;

  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (!(key in current) || typeof current[key] !== "object") {
      return result as T; // Path doesn't exist
    }
    current[key] = { ...(current[key] as Record<string, unknown>) };
    current = current[key] as Record<string, unknown>;
  }

  delete current[parts[parts.length - 1]];
  return result as T;
}
