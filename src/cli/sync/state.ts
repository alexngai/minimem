/**
 * Sync state tracking with content hashing
 *
 * Tracks file hashes to detect changes between local directories
 * and the central repository. Uses 2-way comparison (local vs remote).
 *
 * Conflict resolution: Last-write-wins
 * - Push: local overwrites remote
 * - Pull: remote overwrites local
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { minimatch } from "minimatch";

const STATE_FILENAME = "sync-state.json";
const STATE_DIR = ".minimem";

export type FileHashInfo = {
  /** SHA-256 hash of local file content */
  localHash: string;
  /** SHA-256 hash of remote file content */
  remoteHash: string;
  /** Last modified timestamp (ISO) */
  lastModified: string;
};

export type SyncState = {
  /** Version for future migrations */
  version: number;
  /** Last sync timestamp (ISO) */
  lastSync: string | null;
  /** Central repo path this directory syncs to */
  centralPath: string;
  /** File hashes keyed by relative path */
  files: Record<string, FileHashInfo>;
};

/**
 * Get the sync state file path for a directory
 */
export function getSyncStatePath(dir: string): string {
  return path.join(dir, STATE_DIR, STATE_FILENAME);
}

/**
 * Create an empty sync state
 */
export function createEmptySyncState(centralPath: string): SyncState {
  return {
    version: 2, // Bumped version for simplified state
    lastSync: null,
    centralPath,
    files: {},
  };
}

/**
 * Load sync state from a directory
 * Returns empty state if file doesn't exist
 */
export async function loadSyncState(
  dir: string,
  centralPath: string
): Promise<SyncState> {
  const statePath = getSyncStatePath(dir);

  try {
    const content = await fs.readFile(statePath, "utf-8");
    const state = JSON.parse(content) as SyncState;

    // Validate basic structure
    if (!state.files || typeof state.files !== "object") {
      return createEmptySyncState(centralPath);
    }

    // Update centralPath if it changed
    state.centralPath = centralPath;

    // Migrate v1 state (remove lastSyncedHash if present)
    if (state.version === 1) {
      for (const file of Object.keys(state.files)) {
        const entry = state.files[file] as FileHashInfo & { lastSyncedHash?: string };
        delete entry.lastSyncedHash;
      }
      state.version = 2;
    }

    return state;
  } catch {
    return createEmptySyncState(centralPath);
  }
}

/**
 * Save sync state atomically
 */
export async function saveSyncState(
  dir: string,
  state: SyncState
): Promise<void> {
  const statePath = getSyncStatePath(dir);
  const stateDir = path.dirname(statePath);
  const tempPath = `${statePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;

  // Ensure directory exists
  await fs.mkdir(stateDir, { recursive: true });

  // Ensure version is set
  state.version = state.version || 2;

  // Write to temp file
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), "utf-8");

  // Atomic rename
  await fs.rename(tempPath, statePath);
}

/**
 * Compute SHA-256 hash of a file's content
 */
export async function computeFileHash(filePath: string): Promise<string> {
  const content = await fs.readFile(filePath);
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * Compute hash of string content
 */
export function computeContentHash(content: string | Buffer): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

/**
 * List files matching include/exclude patterns
 */
export async function listSyncableFiles(
  dir: string,
  include: string[],
  exclude: string[]
): Promise<string[]> {
  const files: string[] = [];

  async function walkDir(currentDir: string, relativePath: string = "") {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

      // Skip .minimem directory
      if (entry.name === ".minimem") continue;

      if (entry.isDirectory()) {
        await walkDir(entryPath, relPath);
      } else if (entry.isFile()) {
        // Check include patterns
        const matchesInclude = include.some((pattern) =>
          minimatch(relPath, pattern)
        );

        // Check exclude patterns
        const matchesExclude = exclude.some((pattern) =>
          minimatch(relPath, pattern)
        );

        if (matchesInclude && !matchesExclude) {
          files.push(relPath);
        }
      }
    }
  }

  try {
    await walkDir(dir);
  } catch (error) {
    // Directory might not exist yet
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  return files.sort();
}

/**
 * Get file hash info, computing hash if file exists
 */
export async function getFileHashInfo(
  filePath: string
): Promise<{ exists: boolean; hash?: string; mtime?: string }> {
  try {
    const stat = await fs.stat(filePath);
    const hash = await computeFileHash(filePath);
    return {
      exists: true,
      hash,
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return { exists: false };
  }
}

/**
 * Sync status for a file (2-way comparison)
 *
 * With last-write-wins, there are no conflicts:
 * - Push operations: local changes overwrite remote
 * - Pull operations: remote changes overwrite local
 */
export type FileSyncStatus =
  | "unchanged"      // Both same
  | "local-modified" // Local differs from remote (push will overwrite remote)
  | "remote-modified"// Remote differs from local (pull will overwrite local)
  | "local-only"     // File exists only locally
  | "remote-only";   // File exists only on remote

/**
 * Compare local and remote files to determine sync status
 * Simple 2-way comparison (no 3-way merge needed with last-write-wins)
 */
export function getFileSyncStatus(
  localHash: string | null,
  remoteHash: string | null
): FileSyncStatus {
  // Both exist and are the same
  if (localHash && remoteHash && localHash === remoteHash) {
    return "unchanged";
  }

  // File exists in both but differs
  if (localHash && remoteHash && localHash !== remoteHash) {
    // With last-write-wins, caller decides direction
    // Return "local-modified" to indicate a difference
    return "local-modified";
  }

  // File only exists locally
  if (localHash && !remoteHash) {
    return "local-only";
  }

  // File only exists on remote
  if (!localHash && remoteHash) {
    return "remote-only";
  }

  return "unchanged";
}

/**
 * Update sync state after a successful sync
 */
export function updateSyncStateAfterSync(
  state: SyncState,
  filePath: string,
  hash: string
): SyncState {
  return {
    ...state,
    lastSync: new Date().toISOString(),
    files: {
      ...state.files,
      [filePath]: {
        localHash: hash,
        remoteHash: hash,
        lastModified: new Date().toISOString(),
      },
    },
  };
}

/**
 * Remove a file from sync state
 */
export function removeFileFromSyncState(
  state: SyncState,
  filePath: string
): SyncState {
  const { [filePath]: _, ...remainingFiles } = state.files;
  return {
    ...state,
    files: remainingFiles,
  };
}

/**
 * Build a complete sync state by scanning files
 */
export async function buildSyncState(
  localDir: string,
  remoteDir: string,
  centralPath: string,
  include: string[],
  exclude: string[]
): Promise<{
  state: SyncState;
  changes: Array<{
    file: string;
    status: FileSyncStatus;
    localHash: string | null;
    remoteHash: string | null;
  }>;
}> {
  const state = createEmptySyncState(centralPath);
  const changes: Array<{
    file: string;
    status: FileSyncStatus;
    localHash: string | null;
    remoteHash: string | null;
  }> = [];

  // Get all files from both sides
  const [localFiles, remoteFiles] = await Promise.all([
    listSyncableFiles(localDir, include, exclude),
    listSyncableFiles(remoteDir, include, exclude),
  ]);

  const allFiles = new Set([...localFiles, ...remoteFiles]);

  for (const file of allFiles) {
    const localPath = path.join(localDir, file);
    const remotePath = path.join(remoteDir, file);

    const [localInfo, remoteInfo] = await Promise.all([
      getFileHashInfo(localPath),
      getFileHashInfo(remotePath),
    ]);

    const status = getFileSyncStatus(
      localInfo.hash ?? null,
      remoteInfo.hash ?? null
    );

    if (status !== "unchanged") {
      changes.push({
        file,
        status,
        localHash: localInfo.hash ?? null,
        remoteHash: remoteInfo.hash ?? null,
      });
    }

    // Update state with current hashes
    state.files[file] = {
      localHash: localInfo.hash ?? "",
      remoteHash: remoteInfo.hash ?? "",
      lastModified: localInfo.mtime ?? remoteInfo.mtime ?? new Date().toISOString(),
    };
  }

  return { state, changes };
}
