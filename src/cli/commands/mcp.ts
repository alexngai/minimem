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
import {
  resolveMemoryDirs,
  getGlobalMemoryDir,
  getDirName,
  loadConfig,
  buildMinimemConfig,
  isInitialized,
  formatPath,
  getInitConfig,
  saveConfig,
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
    console.error("Error: No memory directories specified.");
    console.error("Use --dir <path> or --global to specify directories.");
    process.exit(1);
  }

  // Auto-initialize global directory if it will be used
  const includesGlobal = directories.includes(globalDir);
  if (includesGlobal && !(await isInitialized(globalDir))) {
    await ensureGlobalInitialized(globalDir);
  }

  // Validate and create instances for each directory
  const instances: MemoryInstance[] = [];
  const minimemInstances: Minimem[] = [];

  for (const memoryDir of directories) {
    const isGlobal = memoryDir === globalDir;

    if (!(await isInitialized(memoryDir))) {
      // Write to stderr so it doesn't interfere with MCP JSON-RPC
      console.error(`Warning: ${formatPath(memoryDir)} is not initialized, skipping.`);

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
        console.error(`Note: Running in BM25-only mode (no embedding API configured).`);
        console.error(`      Search results will be based on keyword matching only.`);
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
      console.error(`Warning: Failed to load ${formatPath(memoryDir)}: ${message}`);
    }
  }

  if (instances.length === 0) {
    console.error("Error: No valid memory directories found.");
    process.exit(1);
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

  // Create directories
  await fs.mkdir(globalDir, { recursive: true });
  await fs.mkdir(path.join(globalDir, "memory"), { recursive: true });
  await fs.mkdir(path.join(globalDir, ".minimem"), { recursive: true });

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

  // Create config
  const config = getInitConfig();
  await saveConfig(globalDir, config);

  // Create .gitignore
  const gitignorePath = path.join(globalDir, ".minimem", ".gitignore");
  await fs.writeFile(gitignorePath, "index.db\nindex.db-*\n", "utf-8");

  console.error(`  Created ~/.minimem with default configuration.`);
}
