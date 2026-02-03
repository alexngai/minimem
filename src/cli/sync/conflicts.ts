/**
 * Conflict detection and resolution
 *
 * Detects when files have changed on both local and remote since the last sync,
 * and provides mechanisms to resolve conflicts.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { getSyncConfig } from "../config.js";
import {
  loadSyncState,
  saveSyncState,
  listSyncableFiles,
  getFileHashInfo,
  getFileSyncStatus,
  type FileSyncStatus,
  type SyncState,
} from "./state.js";
import { getCentralRepoPath } from "./central.js";

const SHADOWS_DIR = "shadows";
const CONFLICTS_DIR = "conflicts";

export type FileConflict = {
  /** Relative file path */
  file: string;
  /** Sync status */
  status: FileSyncStatus;
  /** Local file hash (null if deleted/missing) */
  localHash: string | null;
  /** Remote file hash (null if deleted/missing) */
  remoteHash: string | null;
  /** Last synced hash (null if new file) */
  baseHash: string | null;
};

export type ConflictDetectionResult = {
  /** Files that need action */
  changes: FileConflict[];
  /** Files with no changes */
  unchanged: string[];
  /** Summary counts */
  summary: {
    unchanged: number;
    localOnly: number;
    remoteOnly: number;
    conflicts: number;
    newLocal: number;
    newRemote: number;
    deletedLocal: number;
    deletedRemote: number;
  };
};

/**
 * Get the shadows directory path
 */
export function getShadowsDir(memoryDir: string): string {
  return path.join(memoryDir, ".minimem", SHADOWS_DIR);
}

/**
 * Get the conflicts directory path
 */
export function getConflictsDir(memoryDir: string): string {
  return path.join(memoryDir, ".minimem", CONFLICTS_DIR);
}

/**
 * Get shadow file path for a given file
 */
export function getShadowPath(memoryDir: string, filePath: string): string {
  // Flatten path for shadow storage
  const flatName = filePath.replace(/\//g, "_");
  return path.join(getShadowsDir(memoryDir), `${flatName}.base`);
}

/**
 * Create a shadow copy of a file's content
 */
export async function createShadowCopy(
  memoryDir: string,
  filePath: string,
  content: string | Buffer
): Promise<void> {
  const shadowPath = getShadowPath(memoryDir, filePath);
  await fs.mkdir(path.dirname(shadowPath), { recursive: true });
  await fs.writeFile(shadowPath, content);
}

/**
 * Read a shadow copy if it exists
 */
export async function readShadowCopy(
  memoryDir: string,
  filePath: string
): Promise<string | null> {
  const shadowPath = getShadowPath(memoryDir, filePath);
  try {
    return await fs.readFile(shadowPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Delete a shadow copy
 */
export async function deleteShadowCopy(
  memoryDir: string,
  filePath: string
): Promise<void> {
  const shadowPath = getShadowPath(memoryDir, filePath);
  try {
    await fs.unlink(shadowPath);
  } catch {
    // File might not exist
  }
}

/**
 * Clean up all shadow copies
 */
export async function cleanShadows(memoryDir: string): Promise<void> {
  const shadowsDir = getShadowsDir(memoryDir);
  try {
    await fs.rm(shadowsDir, { recursive: true, force: true });
  } catch {
    // Directory might not exist
  }
}

/**
 * Quarantine a conflicted file
 * Saves local, remote, and base versions to conflicts directory
 */
export async function quarantineConflict(
  memoryDir: string,
  filePath: string,
  localContent: string | Buffer | null,
  remoteContent: string | Buffer | null,
  baseContent: string | Buffer | null
): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const conflictDir = path.join(getConflictsDir(memoryDir), timestamp);
  const flatName = filePath.replace(/\//g, "_");

  await fs.mkdir(conflictDir, { recursive: true });

  if (localContent !== null) {
    await fs.writeFile(path.join(conflictDir, `${flatName}.local`), localContent);
  }
  if (remoteContent !== null) {
    await fs.writeFile(path.join(conflictDir, `${flatName}.remote`), remoteContent);
  }
  if (baseContent !== null) {
    await fs.writeFile(path.join(conflictDir, `${flatName}.base`), baseContent);
  }

  return conflictDir;
}

/**
 * List all quarantined conflicts
 */
export async function listQuarantinedConflicts(
  memoryDir: string
): Promise<Array<{ timestamp: string; files: string[] }>> {
  const conflictsDir = getConflictsDir(memoryDir);
  const conflicts: Array<{ timestamp: string; files: string[] }> = [];

  try {
    const entries = await fs.readdir(conflictsDir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const dirPath = path.join(conflictsDir, entry.name);
        const files = await fs.readdir(dirPath);

        // Extract unique file names (remove .local, .remote, .base suffixes)
        const uniqueFiles = new Set<string>();
        for (const file of files) {
          const baseName = file.replace(/\.(local|remote|base)$/, "");
          uniqueFiles.add(baseName.replace(/_/g, "/"));
        }

        conflicts.push({
          timestamp: entry.name,
          files: Array.from(uniqueFiles),
        });
      }
    }
  } catch {
    // Directory might not exist
  }

  return conflicts.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

/**
 * Detect conflicts between local and remote
 */
export async function detectConflicts(
  memoryDir: string,
  centralPath?: string
): Promise<ConflictDetectionResult> {
  // Get central repo path
  const centralRepo = await getCentralRepoPath();
  if (!centralRepo) {
    throw new Error("No central repository configured");
  }

  // Get sync config
  const syncConfig = await getSyncConfig(memoryDir);
  if (!syncConfig.path) {
    throw new Error("Directory is not configured for sync");
  }

  const remotePath = path.join(centralRepo, syncConfig.path);
  const effectiveCentralPath = centralPath ?? syncConfig.path;

  // Load sync state
  const state = await loadSyncState(memoryDir, effectiveCentralPath);

  // Get file lists
  const [localFiles, remoteFiles] = await Promise.all([
    listSyncableFiles(memoryDir, syncConfig.include, syncConfig.exclude),
    listSyncableFiles(remotePath, syncConfig.include, syncConfig.exclude),
  ]);

  const allFiles = new Set([...localFiles, ...remoteFiles]);

  const changes: FileConflict[] = [];
  const unchanged: string[] = [];
  const summary = {
    unchanged: 0,
    localOnly: 0,
    remoteOnly: 0,
    conflicts: 0,
    newLocal: 0,
    newRemote: 0,
    deletedLocal: 0,
    deletedRemote: 0,
  };

  for (const file of allFiles) {
    const localPath = path.join(memoryDir, file);
    const remoteFilePath = path.join(remotePath, file);

    const [localInfo, remoteInfo] = await Promise.all([
      getFileHashInfo(localPath),
      getFileHashInfo(remoteFilePath),
    ]);

    const existingEntry = state.files[file];
    const baseHash = existingEntry?.lastSyncedHash ?? null;

    const status = getFileSyncStatus(
      localInfo.hash ?? null,
      remoteInfo.hash ?? null,
      baseHash
    );

    if (status === "unchanged") {
      unchanged.push(file);
      summary.unchanged++;
    } else {
      changes.push({
        file,
        status,
        localHash: localInfo.hash ?? null,
        remoteHash: remoteInfo.hash ?? null,
        baseHash,
      });

      // Update summary
      switch (status) {
        case "local-only":
          summary.localOnly++;
          break;
        case "remote-only":
          summary.remoteOnly++;
          break;
        case "conflict":
          summary.conflicts++;
          break;
        case "new-local":
          summary.newLocal++;
          break;
        case "new-remote":
          summary.newRemote++;
          break;
        case "deleted-local":
          summary.deletedLocal++;
          break;
        case "deleted-remote":
          summary.deletedRemote++;
          break;
      }
    }
  }

  return { changes, unchanged, summary };
}

/**
 * Create shadow copies for all conflicts
 * This preserves the base version for 3-way merge
 */
export async function createShadowsForConflicts(
  memoryDir: string,
  conflicts: FileConflict[],
  state: SyncState
): Promise<void> {
  const centralRepo = await getCentralRepoPath();
  if (!centralRepo) return;

  const syncConfig = await getSyncConfig(memoryDir);
  if (!syncConfig.path) return;

  for (const conflict of conflicts) {
    if (conflict.status === "conflict" && conflict.baseHash) {
      // We need the base content - try to get it from the state's recorded hash
      // Since we don't store content, we'd need to have saved it before
      // For now, create an empty shadow to mark that a conflict occurred
      const shadowPath = getShadowPath(memoryDir, conflict.file);
      await fs.mkdir(path.dirname(shadowPath), { recursive: true });

      // Write a marker file indicating we need the base content
      // In practice, the shadow should have been created during the last sync
      try {
        await fs.access(shadowPath);
      } catch {
        // Shadow doesn't exist - write a placeholder
        await fs.writeFile(
          shadowPath,
          `# Shadow for ${conflict.file}\n# Base hash: ${conflict.baseHash}\n# Created during conflict detection\n`
        );
      }
    }
  }
}
