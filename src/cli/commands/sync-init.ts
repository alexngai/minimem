/**
 * minimem sync init - Initialize sync for a memory directory
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  resolveMemoryDir,
  loadConfig,
  saveConfig,
  isInitialized,
  formatPath,
  getMachineId,
  expandPath,
  getDefaultSyncConfig,
} from "../config.js";
import {
  getCentralRepoPath,
  initCentralRepo,
  validateCentralRepo,
} from "../sync/central.js";
import {
  readRegistry,
  writeRegistry,
  checkCollision,
  addMapping,
} from "../sync/registry.js";
import { detectDirectoryType } from "../sync/detection.js";

export type SyncInitOptions = {
  /** Memory directory to initialize sync for */
  local?: string;
  /** Path in central repo */
  path?: string;
  /** Use global ~/.minimem directory */
  global?: boolean;
};

export type SyncInitCentralOptions = {
  /** Force creation even if directory exists */
  force?: boolean;
};

/**
 * Initialize a central repository
 */
export async function syncInitCentral(
  repoPath: string,
  options: SyncInitCentralOptions = {}
): Promise<void> {
  console.log(`Initializing central repository at ${formatPath(repoPath)}...`);

  const result = await initCentralRepo(repoPath);

  if (!result.success) {
    console.error(`Error: ${result.message}`);
    process.exit(1);
  }

  if (result.created) {
    console.log("  Created new git repository");
    console.log("  Created .gitignore");
    console.log("  Created .minimem-registry.json");
    console.log("  Created README.md");
  } else {
    console.log("  Configured existing directory");
  }

  console.log();
  console.log("Central repository is ready!");
  console.log(`Set as centralRepo in ~/.config/minimem/config.json`);
  console.log();
  console.log("Next steps:");
  console.log("  1. Initialize sync for a memory directory:");
  console.log("     minimem sync init --path myproject/");
  console.log();
  console.log("  2. Or from a different directory:");
  console.log("     minimem sync init --local ~/my-memories --path mymemories/");
}

/**
 * Initialize sync for a memory directory
 */
export async function syncInit(options: SyncInitOptions): Promise<void> {
  // Resolve the memory directory
  const memoryDir = resolveMemoryDir({
    dir: options.local,
    global: options.global,
  });

  // Check if initialized
  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    console.error("Run 'minimem init' first.");
    process.exit(1);
  }

  // Check if --path is provided
  if (!options.path) {
    console.error("Error: --path is required.");
    console.error("Example: minimem sync init --path myproject/");
    process.exit(1);
  }

  const centralPath = options.path;

  // Get central repo
  const centralRepo = await getCentralRepoPath();
  if (!centralRepo) {
    console.error("Error: No central repository configured.");
    console.error("First initialize a central repository:");
    console.error("  minimem sync init-central ~/memories-repo");
    process.exit(1);
  }

  // Validate central repo
  const validation = await validateCentralRepo(centralRepo);
  if (!validation.valid) {
    console.error(`Error: Central repository is invalid:`);
    for (const error of validation.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  if (validation.warnings.length > 0) {
    console.log("Warnings about central repository:");
    for (const warning of validation.warnings) {
      console.log(`  - ${warning}`);
    }
    console.log();
  }

  // Get machine ID
  const machineId = await getMachineId();

  // Check for collisions
  const registry = await readRegistry(centralRepo);
  const collisionResult = checkCollision(registry, centralPath, memoryDir, machineId);

  if (collisionResult === "collision") {
    const existingMapping = registry.mappings.find(
      (m) => m.path === centralPath || m.path === `${centralPath}/`
    );
    console.error(`Error: Path '${centralPath}' is already mapped by another machine.`);
    if (existingMapping) {
      console.error(`  Machine: ${existingMapping.machineId}`);
      console.error(`  Local path: ${existingMapping.localPath}`);
      console.error(`  Last sync: ${existingMapping.lastSync}`);
    }
    console.error();
    console.error("Choose a different path or remove the existing mapping.");
    process.exit(1);
  }

  // Detect directory type
  const dirType = await detectDirectoryType(memoryDir);

  console.log(`Initializing sync for ${formatPath(memoryDir)}...`);
  console.log(`  Directory type: ${dirType}`);
  console.log(`  Central path: ${centralPath}`);
  console.log(`  Machine ID: ${machineId}`);
  console.log();

  // Update local config
  const localConfig = await loadConfig(memoryDir);
  const syncDefaults = getDefaultSyncConfig();

  localConfig.sync = {
    enabled: true,
    path: centralPath,
    include: localConfig.sync?.include ?? syncDefaults.include,
    exclude: localConfig.sync?.exclude ?? syncDefaults.exclude,
  };

  await saveConfig(memoryDir, localConfig);
  console.log("  Updated .minimem/config.json with sync settings");

  // Update registry
  const updatedRegistry = addMapping(registry, {
    path: centralPath,
    localPath: memoryDir,
    machineId,
    lastSync: new Date().toISOString(),
  });

  await writeRegistry(centralRepo, updatedRegistry);
  console.log("  Registered mapping in central repository");

  // Create central path directory if it doesn't exist
  const centralDir = path.join(centralRepo, centralPath);
  try {
    await fs.mkdir(centralDir, { recursive: true });
  } catch {
    // Directory might already exist
  }

  console.log();
  console.log("Sync initialized successfully!");
  console.log();
  console.log("Next steps:");
  console.log("  Push local files to central:");
  console.log("    minimem push");
  console.log();
  console.log("  Or pull from central:");
  console.log("    minimem pull");
}

/**
 * List all sync mappings
 */
export async function syncList(): Promise<void> {
  const centralRepo = await getCentralRepoPath();

  if (!centralRepo) {
    console.log("No central repository configured.");
    console.log("Run: minimem sync init-central <path>");
    return;
  }

  const machineId = await getMachineId();
  const registry = await readRegistry(centralRepo);

  console.log(`Central Repository: ${formatPath(centralRepo)}`);
  console.log(`Machine ID: ${machineId}`);
  console.log();

  if (registry.mappings.length === 0) {
    console.log("No sync mappings registered.");
    console.log("Run: minimem sync init --path <name>/");
    return;
  }

  console.log("Registered Mappings:");
  console.log("-".repeat(80));

  for (const mapping of registry.mappings) {
    const isCurrentMachine = mapping.machineId === machineId;
    const marker = isCurrentMachine ? " *" : "  ";
    const lastSync = new Date(mapping.lastSync).toLocaleString();

    console.log(`${marker}Path: ${mapping.path}`);
    console.log(`    Local: ${mapping.localPath}`);
    console.log(`    Machine: ${mapping.machineId}`);
    console.log(`    Last Sync: ${lastSync}`);
    console.log();
  }

  console.log("* = this machine");
}

/**
 * Remove sync mapping for a directory
 */
export async function syncRemove(options: { local?: string; global?: boolean }): Promise<void> {
  const memoryDir = resolveMemoryDir({
    dir: options.local,
    global: options.global,
  });

  const centralRepo = await getCentralRepoPath();
  if (!centralRepo) {
    console.error("Error: No central repository configured.");
    process.exit(1);
  }

  const localConfig = await loadConfig(memoryDir);
  if (!localConfig.sync?.path) {
    console.error(`Error: ${formatPath(memoryDir)} is not configured for sync.`);
    process.exit(1);
  }

  const centralPath = localConfig.sync.path;
  const machineId = await getMachineId();

  // Update local config
  delete localConfig.sync;
  await saveConfig(memoryDir, localConfig);
  console.log(`Removed sync config from ${formatPath(memoryDir)}`);

  // Update registry
  const registry = await readRegistry(centralRepo);
  const updatedRegistry = {
    ...registry,
    mappings: registry.mappings.filter(
      (m) => !(m.path === centralPath && m.machineId === machineId)
    ),
  };
  await writeRegistry(centralRepo, updatedRegistry);
  console.log(`Removed mapping from central registry`);

  console.log();
  console.log("Note: Files in the central repository were NOT deleted.");
  console.log(`They remain at: ${formatPath(path.join(centralRepo, centralPath))}`);
}
