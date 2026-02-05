/**
 * Sync change detection
 *
 * Detects differences between local and remote files.
 * With last-write-wins, there are no conflicts - just differences.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { getSyncConfig } from "../config.js";
import {
  listSyncableFiles,
  getFileHashInfo,
  getFileSyncStatus,
  type FileSyncStatus,
} from "./state.js";
import { getCentralRepoPath } from "./central.js";

const CONFLICTS_DIR = "conflicts";

export type FileChange = {
  /** Relative file path */
  file: string;
  /** Sync status */
  status: FileSyncStatus;
  /** Local file hash (null if missing) */
  localHash: string | null;
  /** Remote file hash (null if missing) */
  remoteHash: string | null;
};

// Keep FileConflict as an alias for backwards compatibility
export type FileConflict = FileChange;

export type ChangeDetectionResult = {
  /** Files that need action */
  changes: FileChange[];
  /** Files with no changes */
  unchanged: string[];
  /** Summary counts */
  summary: {
    unchanged: number;
    localOnly: number;
    remoteOnly: number;
    localModified: number;
  };
};

// Keep ConflictDetectionResult as an alias for backwards compatibility
export type ConflictDetectionResult = ChangeDetectionResult;

/**
 * Get the conflicts directory path (for quarantined files)
 */
export function getConflictsDir(memoryDir: string): string {
  return path.join(memoryDir, ".minimem", CONFLICTS_DIR);
}

/**
 * Quarantine file versions for manual review
 * Saves local and remote versions to conflicts directory
 */
export async function quarantineConflict(
  memoryDir: string,
  filePath: string,
  localContent: string | Buffer | null,
  remoteContent: string | Buffer | null
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

  return conflictDir;
}

/**
 * List all quarantined file versions
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

        // Extract unique file names (remove .local, .remote suffixes)
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
 * Detect changes between local and remote
 */
export async function detectChanges(
  memoryDir: string
): Promise<ChangeDetectionResult> {
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

  // Get file lists
  const [localFiles, remoteFiles] = await Promise.all([
    listSyncableFiles(memoryDir, syncConfig.include, syncConfig.exclude),
    listSyncableFiles(remotePath, syncConfig.include, syncConfig.exclude),
  ]);

  const allFiles = new Set([...localFiles, ...remoteFiles]);

  const changes: FileChange[] = [];
  const unchanged: string[] = [];
  const summary = {
    unchanged: 0,
    localOnly: 0,
    remoteOnly: 0,
    localModified: 0,
  };

  for (const file of allFiles) {
    const localPath = path.join(memoryDir, file);
    const remoteFilePath = path.join(remotePath, file);

    const [localInfo, remoteInfo] = await Promise.all([
      getFileHashInfo(localPath),
      getFileHashInfo(remoteFilePath),
    ]);

    const status = getFileSyncStatus(
      localInfo.hash ?? null,
      remoteInfo.hash ?? null
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
      });

      // Update summary
      switch (status) {
        case "local-only":
          summary.localOnly++;
          break;
        case "remote-only":
          summary.remoteOnly++;
          break;
        case "local-modified":
          summary.localModified++;
          break;
      }
    }
  }

  return { changes, unchanged, summary };
}

// Keep detectConflicts as an alias for backwards compatibility
export const detectConflicts = detectChanges;
