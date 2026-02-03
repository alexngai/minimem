/**
 * Sync state tracking with content hashing
 *
 * Tracks file hashes to detect changes and conflicts between
 * local directories and the central repository.
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
  /** Hash at last successful sync (the common base) */
  lastSyncedHash: string;
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
    version: 1,
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
  state.version = state.version || 1;

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
 * Compare local and remote files to determine sync status
 */
export type FileSyncStatus =
  | "unchanged" // Both same, matches last sync
  | "local-only" // Only local changed
  | "remote-only" // Only remote changed
  | "conflict" // Both changed differently
  | "new-local" // New file locally
  | "new-remote" // New file on remote
  | "deleted-local" // Deleted locally
  | "deleted-remote"; // Deleted on remote

export function getFileSyncStatus(
  localHash: string | null,
  remoteHash: string | null,
  lastSyncedHash: string | null
): FileSyncStatus {
  // Both exist and are the same
  if (localHash && remoteHash && localHash === remoteHash) {
    return "unchanged";
  }

  // New files (no last sync record)
  if (!lastSyncedHash) {
    if (localHash && !remoteHash) return "new-local";
    if (!localHash && remoteHash) return "new-remote";
    if (localHash && remoteHash && localHash !== remoteHash) return "conflict";
  }

  // Deletions
  if (lastSyncedHash && !localHash && remoteHash === lastSyncedHash) {
    return "deleted-local";
  }
  if (lastSyncedHash && !remoteHash && localHash === lastSyncedHash) {
    return "deleted-remote";
  }

  // Changes since last sync
  if (lastSyncedHash) {
    const localChanged = localHash !== lastSyncedHash;
    const remoteChanged = remoteHash !== lastSyncedHash;

    if (localChanged && !remoteChanged) return "local-only";
    if (!localChanged && remoteChanged) return "remote-only";
    if (localChanged && remoteChanged) {
      // Both changed - conflict if they're different
      if (localHash !== remoteHash) return "conflict";
      // Both changed to same value - unchanged
      return "unchanged";
    }
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
        lastSyncedHash: hash,
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
  exclude: string[],
  existingState?: SyncState
): Promise<{
  state: SyncState;
  changes: Array<{
    file: string;
    status: FileSyncStatus;
    localHash: string | null;
    remoteHash: string | null;
  }>;
}> {
  const state = existingState || createEmptySyncState(centralPath);
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

    const existingEntry = state.files[file];
    const lastSyncedHash = existingEntry?.lastSyncedHash ?? null;

    const status = getFileSyncStatus(
      localInfo.hash ?? null,
      remoteInfo.hash ?? null,
      lastSyncedHash
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
      localHash: localInfo.hash ?? existingEntry?.localHash ?? "",
      remoteHash: remoteInfo.hash ?? existingEntry?.remoteHash ?? "",
      lastSyncedHash: existingEntry?.lastSyncedHash ?? "",
      lastModified: localInfo.mtime ?? remoteInfo.mtime ?? new Date().toISOString(),
    };
  }

  return { state, changes };
}
