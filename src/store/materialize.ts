/**
 * Store materialization strategies.
 *
 * Two strategies for making a linked store accessible:
 *
 * A. Remote materialization: clone/fetch a git remote into a cache directory
 *    Used when the store isn't available locally.
 *
 * B. Symlink materialization: create temporary symlinks to a local store
 *    Used when the store is already present on disk.
 *    Symlinks go into a temp directory with unique subdirectory names
 *    to avoid path collisions between stores.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { StoreDefinition } from "./manifest.js";

const execFileAsync = promisify(execFile);

const CACHE_BASE = path.join(os.homedir(), ".cache", "minimem", "stores");

export type MaterializeResult = {
  /** The directory path to use for creating a Minimem instance */
  path: string;
  /** How the store was materialized */
  strategy: "local" | "symlink" | "remote";
  /** Cleanup function to call when done (removes symlinks, etc.) */
  cleanup: () => Promise<void>;
};

/**
 * Materialize a store so it can be accessed by a Minimem instance.
 *
 * Resolution order:
 * 1. If the store path exists locally → use directly (no materialization needed)
 * 2. If the store has a remote → clone/fetch into cache
 * 3. Otherwise → return null (store unavailable)
 */
export async function materializeStore(
  storeName: string,
  storeDef: StoreDefinition,
  opts?: {
    /** Force refresh from remote even if cache exists */
    refresh?: boolean;
  },
): Promise<MaterializeResult | null> {
  // Strategy B: local store exists — use symlink to temp dir
  if (fsSync.existsSync(storeDef.path)) {
    return materializeLocal(storeName, storeDef.path);
  }

  // Strategy A: remote store — clone/fetch into cache
  if (storeDef.remote) {
    return materializeRemote(storeName, storeDef, opts?.refresh ?? false);
  }

  // Store is unavailable
  return null;
}

/**
 * Strategy B: symlink materialization for local stores.
 *
 * Creates a temporary directory with a uniquely-named subdirectory
 * containing a symlink to the source store. This avoids collisions
 * when multiple stores are materialized simultaneously.
 */
async function materializeLocal(
  storeName: string,
  storePath: string,
): Promise<MaterializeResult> {
  // Create temp dir: /tmp/minimem-stores-<random>/<storeName>/
  const tmpBase = await fs.mkdtemp(
    path.join(os.tmpdir(), "minimem-stores-"),
  );
  const symlinkDir = path.join(tmpBase, storeName);

  // Create symlink: tmpBase/<storeName> → storePath
  await fs.symlink(storePath, symlinkDir, "dir");

  return {
    // The Minimem instance should use the original path for its DB,
    // but the symlink path can be used for discovery/resolution.
    // We return the original path since Minimem works directly with it.
    path: storePath,
    strategy: "symlink",
    cleanup: async () => {
      try {
        await fs.unlink(symlinkDir);
        await fs.rmdir(tmpBase);
      } catch {
        // Best-effort cleanup
      }
    },
  };
}

/**
 * Strategy A: remote materialization via git clone/fetch.
 *
 * Clones the remote into ~/.cache/minimem/stores/<storeName>/
 * On subsequent calls, does a git fetch + reset to update.
 */
async function materializeRemote(
  storeName: string,
  storeDef: StoreDefinition,
  refresh: boolean,
): Promise<MaterializeResult | null> {
  const cacheDir = path.join(CACHE_BASE, storeName);

  try {
    if (fsSync.existsSync(path.join(cacheDir, ".git"))) {
      // Cache exists — optionally refresh
      if (refresh) {
        await gitFetch(cacheDir);
      }
    } else {
      // Clone fresh
      await gitClone(storeDef.remote!, cacheDir);
    }

    return {
      path: cacheDir,
      strategy: "remote",
      cleanup: async () => {
        // Remote cache is persistent — no cleanup needed per session.
        // Users can manually clear ~/.cache/minimem/stores/ if desired.
      },
    };
  } catch {
    // Git operation failed — store unavailable
    return null;
  }
}

async function gitClone(remote: string, targetDir: string): Promise<void> {
  await fs.mkdir(path.dirname(targetDir), { recursive: true });
  await execFileAsync("git", ["clone", "--depth", "1", remote, targetDir], {
    timeout: 60_000,
  });
}

async function gitFetch(cacheDir: string): Promise<void> {
  await execFileAsync("git", ["fetch", "--depth", "1", "origin"], {
    cwd: cacheDir,
    timeout: 60_000,
  });
  await execFileAsync("git", ["reset", "--hard", "origin/HEAD"], {
    cwd: cacheDir,
    timeout: 30_000,
  });
}

/**
 * Get the cache directory for remote stores.
 */
export function getRemoteCacheDir(): string {
  return CACHE_BASE;
}

/**
 * List cached remote stores.
 */
export async function listCachedStores(): Promise<string[]> {
  try {
    const entries = await fs.readdir(CACHE_BASE);
    return entries;
  } catch {
    return [];
  }
}

/**
 * Clear the cache for a specific remote store.
 */
export async function clearStoreCache(storeName: string): Promise<void> {
  const cacheDir = path.join(CACHE_BASE, storeName);
  await fs.rm(cacheDir, { recursive: true, force: true });
}
