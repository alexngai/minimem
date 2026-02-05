/**
 * Directory type detection for sync system
 *
 * Detects whether a memory directory is:
 * - project-bound: inside git repo (synced via project's git)
 * - standalone: has minimem sync config (synced via central repo)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getConfigPath } from "../config.js";

/**
 * Directory type for sync purposes
 *
 * - project-bound: Memory is inside a git repo and synced via project's git
 * - standalone: Memory has minimem sync config and syncs via central repo
 */
export type DirectoryType = "project-bound" | "standalone";

/**
 * Check if a directory is inside a git repository
 * Walks up the directory tree looking for .git
 */
export async function isInsideGitRepo(dir: string): Promise<boolean> {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (current !== root) {
    try {
      const gitPath = path.join(current, ".git");
      const stat = await fs.stat(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        // .git can be a file in worktrees
        return true;
      }
    } catch {
      // .git doesn't exist at this level, continue up
    }
    current = path.dirname(current);
  }

  return false;
}

/**
 * Get the root of the git repository containing a directory
 * Returns undefined if not inside a git repo
 */
export async function getGitRoot(dir: string): Promise<string | undefined> {
  let current = path.resolve(dir);
  const root = path.parse(current).root;

  while (current !== root) {
    try {
      const gitPath = path.join(current, ".git");
      const stat = await fs.stat(gitPath);
      if (stat.isDirectory() || stat.isFile()) {
        return current;
      }
    } catch {
      // Continue up
    }
    current = path.dirname(current);
  }

  return undefined;
}

/**
 * Check if a directory has sync configuration enabled
 */
export async function hasSyncConfig(dir: string): Promise<boolean> {
  const configPath = getConfigPath(dir);

  try {
    const content = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(content);
    // Check if sync is explicitly enabled or has a path configured
    return config.sync?.enabled === true || typeof config.sync?.path === "string";
  } catch {
    return false;
  }
}

/**
 * Detect the directory type based on git repo presence and sync config
 *
 * - If has sync config -> standalone (uses minimem central repo sync)
 * - If inside git repo -> project-bound (synced via project's git)
 * - Otherwise -> standalone (default, can set up sync later)
 */
export async function detectDirectoryType(dir: string): Promise<DirectoryType> {
  const hasSync = await hasSyncConfig(dir);

  // If has sync config, it's standalone (uses minimem sync)
  if (hasSync) {
    return "standalone";
  }

  // If inside git repo, it's project-bound (synced via git)
  const inGit = await isInsideGitRepo(dir);
  if (inGit) {
    return "project-bound";
  }

  // Default to standalone (can set up sync later)
  return "standalone";
}

/**
 * Get detailed directory info including type and git root
 */
export async function getDirectoryInfo(dir: string): Promise<{
  type: DirectoryType;
  gitRoot?: string;
  hasSyncConfig: boolean;
}> {
  const [hasSync, gitRoot] = await Promise.all([
    hasSyncConfig(dir),
    getGitRoot(dir),
  ]);

  let type: DirectoryType;
  if (hasSync) {
    type = "standalone";
  } else if (gitRoot !== undefined) {
    type = "project-bound";
  } else {
    type = "standalone";
  }

  return {
    type,
    gitRoot,
    hasSyncConfig: hasSync,
  };
}
