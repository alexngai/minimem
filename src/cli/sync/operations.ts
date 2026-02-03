/**
 * Sync operations - push and pull
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { getSyncConfig, expandPath } from "../config.js";
import { getCentralRepoPath } from "./central.js";
import {
  loadSyncState,
  saveSyncState,
  listSyncableFiles,
  computeFileHash,
  getFileSyncStatus,
  type SyncState,
} from "./state.js";
import { detectConflicts, quarantineConflict, type FileConflict } from "./conflicts.js";
import { readRegistry, writeRegistry, updateLastSync } from "./registry.js";
import { getMachineId } from "../config.js";
import { appendSyncLog, type SyncLogEntry } from "../commands/conflicts.js";

export type SyncResult = {
  success: boolean;
  pushed: string[];
  pulled: string[];
  conflicts: string[];
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
 * Apply keep-both merge strategy
 */
function keepBothMerge(
  localContent: string,
  remoteContent: string,
  localTimestamp: string,
  remoteTimestamp: string
): string {
  return `<<<<<<< LOCAL (${localTimestamp})
${localContent}
=======
${remoteContent}
>>>>>>> REMOTE (${remoteTimestamp})
`;
}

/**
 * Push local changes to central repository
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
    conflicts: [],
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

  // Detect conflicts
  const detection = await detectConflicts(memoryDir);

  // Load state
  const state = await loadSyncState(memoryDir, syncConfig.path);

  // Process changes
  for (const change of detection.changes) {
    const localPath = path.join(memoryDir, change.file);
    const remoteFilePath = path.join(remotePath, change.file);

    try {
      switch (change.status) {
        case "local-only":
        case "new-local":
          // Push local to remote
          if (!options.dryRun) {
            await copyFileAtomic(localPath, remoteFilePath);
            const hash = await computeFileHash(localPath);
            state.files[change.file] = {
              localHash: hash,
              remoteHash: hash,
              lastSyncedHash: hash,
              lastModified: new Date().toISOString(),
            };
          }
          result.pushed.push(change.file);
          break;

        case "deleted-remote":
          // Local file was deleted remotely, skip (don't push deletion)
          result.skipped.push(change.file);
          break;

        case "conflict":
          if (options.force) {
            // Force push - overwrite remote
            if (!options.dryRun) {
              await copyFileAtomic(localPath, remoteFilePath);
              const hash = await computeFileHash(localPath);
              state.files[change.file] = {
                localHash: hash,
                remoteHash: hash,
                lastSyncedHash: hash,
                lastModified: new Date().toISOString(),
              };
            }
            result.pushed.push(change.file);
          } else {
            // Handle conflict with keep-both strategy
            if (!options.dryRun && syncConfig.conflictStrategy === "keep-both") {
              const localContent = await fs.readFile(localPath, "utf-8");
              const remoteContent = await fs.readFile(remoteFilePath, "utf-8");
              const merged = keepBothMerge(
                localContent,
                remoteContent,
                new Date().toISOString(),
                new Date().toISOString()
              );
              await fs.writeFile(localPath, merged);
              await fs.writeFile(remoteFilePath, merged);
              const hash = computeFileHash(localPath);
              result.pushed.push(change.file);
            } else {
              result.conflicts.push(change.file);
              result.success = false;
            }
          }
          break;

        default:
          // remote-only, new-remote, deleted-local - skip on push
          result.skipped.push(change.file);
          break;
      }
    } catch (error) {
      result.errors.push(`${change.file}: ${error}`);
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
      result: result.success ? (result.conflicts.length > 0 ? "partial" : "success") : "failure",
      pushed: result.pushed.length,
      conflicts: result.conflicts.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    await appendSyncLog(memoryDir, logEntry);
  }

  return result;
}

/**
 * Pull changes from central repository
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
    conflicts: [],
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

  // Detect conflicts
  const detection = await detectConflicts(memoryDir);

  // Load state
  const state = await loadSyncState(memoryDir, syncConfig.path);

  // Process changes
  for (const change of detection.changes) {
    const localPath = path.join(memoryDir, change.file);
    const remoteFilePath = path.join(remotePath, change.file);

    try {
      switch (change.status) {
        case "remote-only":
        case "new-remote":
          // Pull remote to local
          if (!options.dryRun) {
            await copyFileAtomic(remoteFilePath, localPath);
            const hash = await computeFileHash(localPath);
            state.files[change.file] = {
              localHash: hash,
              remoteHash: hash,
              lastSyncedHash: hash,
              lastModified: new Date().toISOString(),
            };
          }
          result.pulled.push(change.file);
          break;

        case "deleted-local":
          // Remote file was deleted locally, skip (don't pull deletion)
          result.skipped.push(change.file);
          break;

        case "conflict":
          if (options.force) {
            // Force pull - overwrite local
            if (!options.dryRun) {
              await copyFileAtomic(remoteFilePath, localPath);
              const hash = await computeFileHash(localPath);
              state.files[change.file] = {
                localHash: hash,
                remoteHash: hash,
                lastSyncedHash: hash,
                lastModified: new Date().toISOString(),
              };
            }
            result.pulled.push(change.file);
          } else {
            // Handle conflict with keep-both strategy
            if (!options.dryRun && syncConfig.conflictStrategy === "keep-both") {
              const localContent = await fs.readFile(localPath, "utf-8");
              const remoteContent = await fs.readFile(remoteFilePath, "utf-8");
              const merged = keepBothMerge(
                localContent,
                remoteContent,
                new Date().toISOString(),
                new Date().toISOString()
              );
              await fs.writeFile(localPath, merged);
              await fs.writeFile(remoteFilePath, merged);
              result.pulled.push(change.file);
            } else {
              result.conflicts.push(change.file);
              result.success = false;
            }
          }
          break;

        default:
          // local-only, new-local, deleted-remote - skip on pull
          result.skipped.push(change.file);
          break;
      }
    } catch (error) {
      result.errors.push(`${change.file}: ${error}`);
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
      result: result.success ? (result.conflicts.length > 0 ? "partial" : "success") : "failure",
      pulled: result.pulled.length,
      conflicts: result.conflicts.length,
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
    conflicts: [...new Set([...pushResult.conflicts, ...pullResult.conflicts])],
    errors: [...pushResult.errors, ...pullResult.errors],
    skipped: [...new Set([...pushResult.skipped, ...pullResult.skipped])],
  };
}
