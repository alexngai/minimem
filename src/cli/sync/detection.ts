/**
 * Directory type detection for sync system
 *
 * Detects whether a memory directory is:
 * - project-bound: inside git repo, no sync config
 * - standalone: has sync config, not inside git repo
 * - hybrid: inside git repo AND has sync config
 * - unmanaged: no git repo, no sync config
 */

import fs from "node:fs/promises";
import path from "node:path";
import { getConfigPath } from "../config.js";

export type DirectoryType = "project-bound" | "standalone" | "hybrid" | "unmanaged";

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
 * Decision matrix:
 * | Sync Config | In Git Repo | Result        |
 * |-------------|-------------|---------------|
 * | Yes         | Yes         | hybrid        |
 * | Yes         | No          | standalone    |
 * | No          | Yes         | project-bound |
 * | No          | No          | unmanaged     |
 */
export async function detectDirectoryType(dir: string): Promise<DirectoryType> {
  const [hasSync, inGit] = await Promise.all([
    hasSyncConfig(dir),
    isInsideGitRepo(dir),
  ]);

  if (hasSync && inGit) {
    return "hybrid";
  } else if (hasSync && !inGit) {
    return "standalone";
  } else if (!hasSync && inGit) {
    return "project-bound";
  } else {
    return "unmanaged";
  }
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

  const inGit = gitRoot !== undefined;

  let type: DirectoryType;
  if (hasSync && inGit) {
    type = "hybrid";
  } else if (hasSync && !inGit) {
    type = "standalone";
  } else if (!hasSync && inGit) {
    type = "project-bound";
  } else {
    type = "unmanaged";
  }

  return {
    type,
    gitRoot,
    hasSyncConfig: hasSync,
  };
}
