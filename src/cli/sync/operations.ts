/**
 * Sync operations - push and pull
 *
 * Uses last-write-wins conflict resolution:
 * - Push: local overwrites remote
 * - Pull: remote overwrites local
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { getSyncConfig } from "../config.js";
import { getCentralRepoPath } from "./central.js";
import {
  loadSyncState,
  saveSyncState,
  listSyncableFiles,
  computeFileHash,
  getFileSyncStatus,
  getFileHashInfo,
} from "./state.js";
import { readRegistry, writeRegistry, updateLastSync } from "./registry.js";
import { getMachineId } from "../config.js";
import { appendSyncLog, type SyncLogEntry } from "../commands/conflicts.js";

export type SyncResult = {
  success: boolean;
  pushed: string[];
  pulled: string[];
  errors: string[];
  skipped: string[];
};

/**
 * Ensure a directory exists
 */
async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Copy a file atomically via temp file
 */
async function copyFileAtomic(src: string, dest: string): Promise<void> {
  const destDir = path.dirname(dest);
  await ensureDir(destDir);

  const tempDest = `${dest}.${crypto.randomBytes(4).toString("hex")}.tmp`;

  try {
    await fs.copyFile(src, tempDest);
    await fs.rename(tempDest, dest);
  } catch (error) {
    // Clean up temp file on error
    try {
      await fs.unlink(tempDest);
    } catch {
      // Ignore cleanup errors
    }
    throw error;
  }
}

/**
 * Push local changes to central repository
 *
 * Last-write-wins: local files always overwrite remote files
 */
export async function push(
  memoryDir: string,
  options: {
    force?: boolean;
    dryRun?: boolean;
  } = {}
): Promise<SyncResult> {
  const result: SyncResult = {
    success: true,
    pushed: [],
    pulled: [],
    errors: [],
    skipped: [],
  };

  // Get config
  const syncConfig = await getSyncConfig(memoryDir);
  if (!syncConfig.enabled || !syncConfig.path) {
    result.success = false;
    result.errors.push("Sync not configured for this directory");
    return result;
  }

  const centralRepo = await getCentralRepoPath();
  if (!centralRepo) {
    result.success = false;
    result.errors.push("No central repository configured");
    return result;
  }

  const remotePath = path.join(centralRepo, syncConfig.path);

  // Load state
  const state = await loadSyncState(memoryDir, syncConfig.path);

  // Get all local files
  const localFiles = await listSyncableFiles(
    memoryDir,
    syncConfig.include,
    syncConfig.exclude
  );

  // Get all remote files for comparison
  const remoteFiles = await listSyncableFiles(
    remotePath,
    syncConfig.include,
    syncConfig.exclude
  );

  const allFiles = new Set([...localFiles, ...remoteFiles]);

  // Process each file
  for (const file of allFiles) {
    const localPath = path.join(memoryDir, file);
    const remoteFilePath = path.join(remotePath, file);

    try {
      const [localInfo, remoteInfo] = await Promise.all([
        getFileHashInfo(localPath),
        getFileHashInfo(remoteFilePath),
      ]);

      const status = getFileSyncStatus(
        localInfo.hash ?? null,
        remoteInfo.hash ?? null
      );

      switch (status) {
        case "unchanged":
          // Already in sync
          break;

        case "local-only":
        case "local-modified":
          // Push local to remote (last-write-wins)
          if (!options.dryRun) {
            await copyFileAtomic(localPath, remoteFilePath);
            const hash = localInfo.hash!;
            state.files[file] = {
              localHash: hash,
              remoteHash: hash,
              lastModified: new Date().toISOString(),
            };
          }
          result.pushed.push(file);
          break;

        case "remote-only":
          // File only exists on remote - skip on push (don't delete)
          result.skipped.push(file);
          break;

        default:
          result.skipped.push(file);
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${file}: ${message}`);
      result.success = false;
    }
  }

  // Save state and update registry
  if (!options.dryRun && result.pushed.length > 0) {
    state.lastSync = new Date().toISOString();
    await saveSyncState(memoryDir, state);

    // Update registry lastSync
    const machineId = await getMachineId();
    const registry = await readRegistry(centralRepo);
    const updatedRegistry = updateLastSync(registry, syncConfig.path, machineId);
    await writeRegistry(centralRepo, updatedRegistry);
  }

  // Log the sync operation
  if (!options.dryRun) {
    const logEntry: SyncLogEntry = {
      timestamp: new Date().toISOString(),
      operation: "push",
      result: result.success ? "success" : "failure",
      pushed: result.pushed.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    await appendSyncLog(memoryDir, logEntry);
  }

  return result;
}

/**
 * Pull changes from central repository
 *
 * Last-write-wins: remote files always overwrite local files
 */
export async function pull(
  memoryDir: string,
  options: {
    force?: boolean;
    dryRun?: boolean;
  } = {}
): Promise<SyncResult> {
  const result: SyncResult = {
    success: true,
    pushed: [],
    pulled: [],
    errors: [],
    skipped: [],
  };

  // Get config
  const syncConfig = await getSyncConfig(memoryDir);
  if (!syncConfig.enabled || !syncConfig.path) {
    result.success = false;
    result.errors.push("Sync not configured for this directory");
    return result;
  }

  const centralRepo = await getCentralRepoPath();
  if (!centralRepo) {
    result.success = false;
    result.errors.push("No central repository configured");
    return result;
  }

  const remotePath = path.join(centralRepo, syncConfig.path);

  // Load state
  const state = await loadSyncState(memoryDir, syncConfig.path);

  // Get all files from both sides
  const localFiles = await listSyncableFiles(
    memoryDir,
    syncConfig.include,
    syncConfig.exclude
  );

  const remoteFiles = await listSyncableFiles(
    remotePath,
    syncConfig.include,
    syncConfig.exclude
  );

  const allFiles = new Set([...localFiles, ...remoteFiles]);

  // Process each file
  for (const file of allFiles) {
    const localPath = path.join(memoryDir, file);
    const remoteFilePath = path.join(remotePath, file);

    try {
      const [localInfo, remoteInfo] = await Promise.all([
        getFileHashInfo(localPath),
        getFileHashInfo(remoteFilePath),
      ]);

      const status = getFileSyncStatus(
        localInfo.hash ?? null,
        remoteInfo.hash ?? null
      );

      switch (status) {
        case "unchanged":
          // Already in sync
          break;

        case "remote-only":
          // Pull new remote file to local
          if (!options.dryRun) {
            await copyFileAtomic(remoteFilePath, localPath);
            const hash = remoteInfo.hash!;
            state.files[file] = {
              localHash: hash,
              remoteHash: hash,
              lastModified: new Date().toISOString(),
            };
          }
          result.pulled.push(file);
          break;

        case "local-modified":
          // Both have changes - with last-write-wins, pull overwrites local
          if (options.force || !localInfo.exists) {
            if (!options.dryRun) {
              await copyFileAtomic(remoteFilePath, localPath);
              const hash = remoteInfo.hash!;
              state.files[file] = {
                localHash: hash,
                remoteHash: hash,
                lastModified: new Date().toISOString(),
              };
            }
            result.pulled.push(file);
          } else {
            // Without --force, skip files that have local changes
            result.skipped.push(file);
          }
          break;

        case "local-only":
          // File only exists locally - skip on pull (don't delete)
          result.skipped.push(file);
          break;

        default:
          result.skipped.push(file);
          break;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push(`${file}: ${message}`);
      result.success = false;
    }
  }

  // Save state and update registry
  if (!options.dryRun && result.pulled.length > 0) {
    state.lastSync = new Date().toISOString();
    await saveSyncState(memoryDir, state);

    // Update registry lastSync
    const machineId = await getMachineId();
    const registry = await readRegistry(centralRepo);
    const updatedRegistry = updateLastSync(registry, syncConfig.path, machineId);
    await writeRegistry(centralRepo, updatedRegistry);
  }

  // Log the sync operation
  if (!options.dryRun) {
    const logEntry: SyncLogEntry = {
      timestamp: new Date().toISOString(),
      operation: "pull",
      result: result.success ? "success" : "failure",
      pulled: result.pulled.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    await appendSyncLog(memoryDir, logEntry);
  }

  return result;
}

/**
 * Bidirectional sync - push local changes, pull remote changes
 */
export async function bidirectionalSync(
  memoryDir: string,
  options: {
    force?: boolean;
    dryRun?: boolean;
  } = {}
): Promise<SyncResult> {
  // First push, then pull
  const pushResult = await push(memoryDir, options);
  const pullResult = await pull(memoryDir, options);

  return {
    success: pushResult.success && pullResult.success,
    pushed: pushResult.pushed,
    pulled: pullResult.pulled,
    errors: [...pushResult.errors, ...pullResult.errors],
    skipped: [...new Set([...pushResult.skipped, ...pullResult.skipped])],
  };
}
