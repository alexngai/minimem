/**
 * minimem mcp - Run as MCP server (stdio)
 *
 * Supports multiple memory directories for cross-directory search.
 * Auto-initializes global ~/.minimem directory as a fallback.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Minimem } from "../../minimem.js";
import { createMcpServer, runMcpServer } from "../../server/mcp.js";
import type { MemoryInstance } from "../../server/tools.js";
import { loadManifest, resolveStoreName, getLinkedStoreNames, resolveStore } from "../../store/manifest.js";
import { materializeStore } from "../../store/materialize.js";
import {
  resolveMemoryDirs,
  getGlobalMemoryDir,
  getDirName,
  loadConfig,
  buildMinimemConfig,
  isInitialized,
  formatPath,
  getInitConfig,
  exitWithError,
  warn,
  note,
} from "../config.js";

export type McpOptions = {
  dir?: string[];
  global?: boolean;
  provider?: string;
};

export async function mcp(options: McpOptions): Promise<void> {
  // Collect all directories (now uses shared implementation)
  const directories = resolveMemoryDirs(options);
  const globalDir = getGlobalMemoryDir();

  if (directories.length === 0) {
    exitWithError(
      "No memory directories specified.",
      "Use --dir <path> or --global to specify directories."
    );
  }

  // Auto-initialize global directory if it will be used
  const includesGlobal = directories.includes(globalDir);
  if (includesGlobal && !(await isInitialized(globalDir))) {
    await ensureGlobalInitialized(globalDir);
  }

  // Resolve linked stores from manifest
  const expandedDirs = await resolveLinkedDirsForMcp(directories);

  // Validate and create instances for each directory
  const instances: MemoryInstance[] = [];
  const minimemInstances: Minimem[] = [];

  for (const memoryDir of expandedDirs) {
    const isGlobal = memoryDir === globalDir;

    if (!(await isInitialized(memoryDir))) {
      // Write to stderr so it doesn't interfere with MCP JSON-RPC
      warn(`${formatPath(memoryDir)} is not initialized, skipping.`);

      // If current directory isn't initialized and global isn't already included,
      // add global as a fallback
      if (!isGlobal && !includesGlobal) {
        console.error(`  Using global (~/.minimem) as fallback.`);
        if (!(await isInitialized(globalDir))) {
          await ensureGlobalInitialized(globalDir);
        }
        directories.push(globalDir);
      }
      continue;
    }

    try {
      const cliConfig = await loadConfig(memoryDir);
      const config = buildMinimemConfig(memoryDir, cliConfig, {
        provider: options.provider,
        watch: true, // Enable watching for MCP server
      });

      const minimem = await Minimem.create(config);
      minimemInstances.push(minimem);

      // Check if running in BM25-only mode
      const status = await minimem.status();
      if (status.bm25Only && instances.length === 0) {
        // Only warn once
        note("Running in BM25-only mode (no embedding API configured).");
        note("Search results will be based on keyword matching only.");
      }

      // Create a friendly name for the directory
      const name = getDirName(memoryDir);

      instances.push({
        minimem,
        memoryDir,
        name,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warn(`Failed to load ${formatPath(memoryDir)}: ${message}`);
    }
  }

  if (instances.length === 0) {
    exitWithError("No valid memory directories found.");
  }

  // Log which directories are being served (to stderr)
  if (instances.length === 1) {
    console.error(`Serving: ${instances[0].name} (${formatPath(instances[0].memoryDir)})`);
  } else {
    console.error(`Serving ${instances.length} directories:`);
    for (const inst of instances) {
      console.error(`  - ${inst.name} (${formatPath(inst.memoryDir)})`);
    }
  }

  const server = createMcpServer(instances);

  // Handle shutdown gracefully
  const shutdown = () => {
    for (const minimem of minimemInstances) {
      minimem.close();
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Run the MCP server (this blocks)
  await runMcpServer(server);
}

// resolveDirectories and getDirName are now imported from ../config.js (via shared.ts)

/**
 * Auto-initialize the global memory directory silently
 */
export async function ensureGlobalInitialized(globalDir: string): Promise<void> {
  console.error(`Auto-initializing global memory directory (~/.minimem)...`);

  // Create directories (contained layout: everything in globalDir)
  await fs.mkdir(globalDir, { recursive: true });
  await fs.mkdir(path.join(globalDir, "memory"), { recursive: true });

  // Create MEMORY.md
  const memoryFilePath = path.join(globalDir, "MEMORY.md");
  try {
    await fs.access(memoryFilePath);
  } catch {
    const template = `# Global Memory

This is your global memory file. Add notes, decisions, and context here.

Notes stored here are available across all projects.

## Notes

`;
    await fs.writeFile(memoryFilePath, template, "utf-8");
  }

  // Create config.json directly in globalDir (contained layout)
  const config = getInitConfig();
  const configPath = path.join(globalDir, "config.json");
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

  // Create .gitignore
  const gitignorePath = path.join(globalDir, ".gitignore");
  await fs.writeFile(gitignorePath, "index.db\nindex.db-*\n", "utf-8");

  console.error(`  Created ~/.minimem with default configuration.`);
}

/**
 * Resolve linked stores from the manifest for all directories.
 * Materializes linked stores (including remote-backed ones) and
 * adds their paths to the directory set.
 */
async function resolveLinkedDirsForMcp(dirs: string[]): Promise<string[]> {
  try {
    const manifest = await loadManifest();
    if (Object.keys(manifest.stores).length === 0) return dirs;

    const allDirs = new Set(dirs);

    for (const dir of dirs) {
      const storeName = resolveStoreName(manifest, dir);
      if (!storeName) continue;

      const linkedNames = await getLinkedStoreNames(manifest, storeName);
      for (const linkedName of linkedNames) {
        const linkedDef = resolveStore(manifest, linkedName);
        if (!linkedDef) continue;

        try {
          const result = await materializeStore(linkedName, linkedDef);
          if (result) {
            allDirs.add(result.path);
            // MCP server runs long-lived — no cleanup needed per-request.
            // Remote cache persists. Symlink cleanup happens on process exit.
          }
        } catch {
          // Materialization failed — skip this linked store
        }
      }
    }

    return [...allDirs];
  } catch {
    return dirs;
  }
}
