/**
 * minimem mcp - Run as MCP server (stdio)
 *
 * Supports multiple memory directories for cross-directory search.
 */

import * as path from "node:path";
import * as os from "node:os";
import { Minimem } from "../../minimem.js";
import { createMcpServer, runMcpServer } from "../../server/mcp.js";
import type { MemoryInstance } from "../../server/tools.js";
import {
  loadConfig,
  buildMinimemConfig,
  isInitialized,
  formatPath,
} from "../config.js";

export type McpOptions = {
  dir?: string[];
  global?: boolean;
  provider?: string;
};

export async function mcp(options: McpOptions): Promise<void> {
  // Collect all directories
  const directories = resolveDirectories(options);

  if (directories.length === 0) {
    console.error("Error: No memory directories specified.");
    console.error("Use --dir <path> or --global to specify directories.");
    process.exit(1);
  }

  // Validate and create instances for each directory
  const instances: MemoryInstance[] = [];
  const minimemInstances: Minimem[] = [];

  for (const memoryDir of directories) {
    if (!(await isInitialized(memoryDir))) {
      // Write to stderr so it doesn't interfere with MCP JSON-RPC
      console.error(`Warning: ${formatPath(memoryDir)} is not initialized, skipping.`);
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

/**
 * Resolve all directories from options
 */
function resolveDirectories(options: McpOptions): string[] {
  const dirs: string[] = [];

  // Add explicit directories
  if (options.dir && options.dir.length > 0) {
    for (const dir of options.dir) {
      dirs.push(path.resolve(dir));
    }
  }

  // Add global directory if --global flag is set
  if (options.global) {
    const globalDir = path.join(os.homedir(), ".minimem");
    if (!dirs.includes(globalDir)) {
      dirs.push(globalDir);
    }
  }

  // If no directories specified, use current directory
  if (dirs.length === 0) {
    dirs.push(process.cwd());
  }

  return dirs;
}

/**
 * Get a friendly name for a directory
 */
function getDirName(memoryDir: string): string {
  const home = os.homedir();

  // Check if it's the global directory
  if (memoryDir === path.join(home, ".minimem")) {
    return "global";
  }

  // Use the directory name
  const name = path.basename(memoryDir);

  // If it's a hidden directory, use parent + name
  if (name.startsWith(".")) {
    const parent = path.basename(path.dirname(memoryDir));
    return `${parent}/${name}`;
  }

  return name;
}
