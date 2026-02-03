/**
 * Sync module - Git-based syncing for memory directories
 */

export {
  type DirectoryType,
  detectDirectoryType,
  isInsideGitRepo,
  getGitRoot,
  hasSyncConfig,
  getDirectoryInfo,
} from "./detection.js";

export {
  type Registry,
  type RegistryMapping,
  type CollisionCheckResult,
  createEmptyRegistry,
  readRegistry,
  writeRegistry,
  getRegistryPath,
  checkCollision,
  addMapping,
  removeMapping,
  findMapping,
  getMachineMappings,
  updateLastSync,
  normalizePath,
  compressPath,
  normalizeRepoPath,
} from "./registry.js";

export {
  type InitCentralResult,
  initCentralRepo,
  validateCentralRepo,
  getCentralRepoPath,
} from "./central.js";

export {
  type SyncState,
  type FileHashInfo,
  type FileSyncStatus,
  createEmptySyncState,
  loadSyncState,
  saveSyncState,
  computeFileHash,
  computeContentHash,
  listSyncableFiles,
  getFileHashInfo,
  getFileSyncStatus,
  updateSyncStateAfterSync,
  removeFileFromSyncState,
  buildSyncState,
  getSyncStatePath,
} from "./state.js";

export {
  type FileConflict,
  type ConflictDetectionResult,
  detectConflicts,
  createShadowCopy,
  readShadowCopy,
  deleteShadowCopy,
  cleanShadows,
  quarantineConflict,
  listQuarantinedConflicts,
  getShadowsDir,
  getConflictsDir,
  createShadowsForConflicts,
} from "./conflicts.js";

export {
  type SyncResult,
  push,
  pull,
  bidirectionalSync,
} from "./operations.js";

export {
  type WatcherEvent,
  type FileChange,
  type WatcherOptions,
  type WatcherInstance,
  createFileWatcher,
  createMultiDirWatcher,
} from "./watcher.js";

export {
  type DaemonOptions,
  type DaemonStatus,
  getDaemonDir,
  getPidFilePath,
  getDaemonLogPath,
  isDaemonRunning,
  getDaemonStatus,
  stopDaemon,
  startDaemon,
  startDaemonBackground,
} from "./daemon.js";

export {
  type ValidationIssue,
  type ValidationResult,
  validateRegistry,
  formatValidationResult,
} from "./validation.js";
