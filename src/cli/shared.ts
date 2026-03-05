/**
 * Shared CLI utilities
 *
 * Centralized functions for directory resolution, error handling,
 * and other cross-cutting concerns used by all CLI commands.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Options that affect directory resolution
 */
export type DirOptions = {
  dir?: string | string[];
  global?: boolean;
};

/**
 * Discover the memory directory from a base directory.
 *
 * Checks for contained layouts where MEMORY.md lives inside
 * .swarm/minimem/ or .minimem/ rather than at the project root.
 *
 * Priority:
 * 1. base has MEMORY.md → base (classic layout)
 * 2. base/.swarm/minimem/ has config.json → contained under .swarm
 * 3. base/.minimem/ has config.json → contained under .minimem
 * 4. base (fallback)
 */
export function discoverMemoryDir(base: string): string {
  // Classic layout: MEMORY.md at project root
  if (fs.existsSync(path.join(base, "MEMORY.md"))) return base;

  // Contained under .swarm/minimem/
  const swarmDir = path.join(base, ".swarm", "minimem");
  if (fs.existsSync(path.join(swarmDir, "config.json"))) return swarmDir;

  // Contained under .minimem/
  const minimemDir = path.join(base, ".minimem");
  if (fs.existsSync(path.join(minimemDir, "config.json"))) return minimemDir;

  return base;
}

/**
 * Resolve a single memory directory from options.
 *
 * Priority:
 * 1. --dir flag (first element if array)
 * 2. MEMORY_DIR environment variable
 * 3. --global flag → ~/.minimem
 * 4. Auto-discover from current working directory
 *
 * Use this for commands that operate on a single directory.
 */
export function resolveMemoryDir(options: DirOptions): string {
  // Handle --dir flag (use first if array)
  const dir = Array.isArray(options.dir) ? options.dir[0] : options.dir;
  if (dir) {
    return path.resolve(dir);
  }

  // Check MEMORY_DIR environment variable
  const envDir = process.env.MEMORY_DIR;
  if (envDir) {
    return path.resolve(envDir);
  }

  // Handle --global flag
  if (options.global) {
    return path.join(os.homedir(), ".minimem");
  }

  // Auto-discover from cwd (handles contained layouts)
  return discoverMemoryDir(process.cwd());
}

/**
 * Resolve multiple memory directories from options.
 *
 * Use this for commands that can search across multiple directories
 * (e.g., search, mcp).
 *
 * Returns deduplicated list of absolute paths.
 */
export function resolveMemoryDirs(options: DirOptions): string[] {
  const dirs: string[] = [];

  // Add explicit directories from --dir flag
  if (options.dir) {
    const dirList = Array.isArray(options.dir) ? options.dir : [options.dir];
    dirs.push(...dirList.map((d) => path.resolve(d)));
  }

  // If no explicit dirs, check MEMORY_DIR environment variable
  if (dirs.length === 0 && process.env.MEMORY_DIR) {
    dirs.push(path.resolve(process.env.MEMORY_DIR));
  }

  // Add global directory if --global flag is set
  if (options.global) {
    const globalDir = path.join(os.homedir(), ".minimem");
    if (!dirs.includes(globalDir)) {
      dirs.push(globalDir);
    }
  }

  // Default: auto-discover from cwd (handles contained layouts)
  if (dirs.length === 0) {
    dirs.push(discoverMemoryDir(process.cwd()));
  }

  // Deduplicate
  return [...new Set(dirs)];
}

/**
 * Get the global memory directory path (~/.minimem)
 */
export function getGlobalMemoryDir(): string {
  return path.join(os.homedir(), ".minimem");
}

/**
 * Exit with an error message and optional suggestion.
 *
 * All CLI errors should use this for consistent formatting.
 */
export function exitWithError(message: string, suggestion?: string): never {
  console.error(`Error: ${message}`);
  if (suggestion) {
    console.error(`  Suggestion: ${suggestion}`);
  }
  process.exit(1);
}

/**
 * Print a warning message (non-fatal).
 */
export function warn(message: string): void {
  console.error(`Warning: ${message}`);
}

/**
 * Print a note/informational message.
 */
export function note(message: string): void {
  console.error(`Note: ${message}`);
}

/**
 * Log an error with context (for debugging).
 * Only logs if a debug function is provided.
 */
export function logError(
  context: string,
  error: unknown,
  debug?: (msg: string) => void
): void {
  const message = error instanceof Error ? error.message : String(error);
  if (debug) {
    debug(`[${context}] Error: ${message}`);
  }
}

/**
 * Get a friendly display name for a directory.
 */
export function getDirName(memoryDir: string): string {
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
