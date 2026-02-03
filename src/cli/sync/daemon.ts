/**
 * Sync daemon - watches directories and syncs automatically
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { createFileWatcher, type WatcherInstance, type FileChange } from "./watcher.js";
import { push, pull } from "./operations.js";
import { readRegistry, type Registry } from "./registry.js";
import { getCentralRepoPath } from "./central.js";
import { loadXdgConfig, getSyncConfig } from "../config.js";
import { validateRegistry, type ValidationResult } from "./validation.js";

const DAEMON_LOG_FILE = "daemon.log";
const PID_FILE = "daemon.pid";
const MAX_LOG_SIZE = 1024 * 1024; // 1MB

export type DaemonOptions = {
  /** Run in background (detach from terminal) */
  background?: boolean;
  /** Sync interval in milliseconds (for central repo polling) */
  pollInterval?: number;
  /** Validation interval in milliseconds (default: 5 minutes) */
  validationInterval?: number;
  /** Log level */
  logLevel?: "debug" | "info" | "warn" | "error";
};

export type DaemonStatus = {
  running: boolean;
  pid?: number;
  startTime?: string;
  watchedDirs?: string[];
};

/**
 * Get the daemon directory path
 */
export function getDaemonDir(): string {
  return path.join(os.homedir(), ".minimem");
}

/**
 * Get PID file path
 */
export function getPidFilePath(): string {
  return path.join(getDaemonDir(), PID_FILE);
}

/**
 * Get daemon log path
 */
export function getDaemonLogPath(): string {
  return path.join(getDaemonDir(), DAEMON_LOG_FILE);
}

/**
 * Check if daemon is running
 */
export async function isDaemonRunning(): Promise<boolean> {
  const pidFile = getPidFilePath();

  try {
    const content = await fs.readFile(pidFile, "utf-8");
    const pid = parseInt(content.trim(), 10);

    if (isNaN(pid)) {
      return false;
    }

    // Check if process is running
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // Process not running, clean up stale PID file
      await fs.unlink(pidFile).catch(() => {});
      return false;
    }
  } catch {
    return false;
  }
}

/**
 * Get daemon status
 */
export async function getDaemonStatus(): Promise<DaemonStatus> {
  const running = await isDaemonRunning();

  if (!running) {
    return { running: false };
  }

  const pidFile = getPidFilePath();
  const content = await fs.readFile(pidFile, "utf-8");
  const pid = parseInt(content.trim(), 10);

  return {
    running: true,
    pid,
  };
}

/**
 * Write to daemon log
 */
async function writeLog(
  message: string,
  level: "debug" | "info" | "warn" | "error" = "info"
): Promise<void> {
  const logPath = getDaemonLogPath();
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${level.toUpperCase()}] ${message}\n`;

  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });

    // Rotate log if too large
    try {
      const stats = await fs.stat(logPath);
      if (stats.size > MAX_LOG_SIZE) {
        await fs.rename(logPath, `${logPath}.old`);
      }
    } catch {
      // File doesn't exist
    }

    await fs.appendFile(logPath, line);
  } catch (error) {
    console.error(`Failed to write log: ${error}`);
  }
}

/**
 * Stop the daemon
 */
export async function stopDaemon(): Promise<boolean> {
  const status = await getDaemonStatus();

  if (!status.running || !status.pid) {
    return false;
  }

  try {
    process.kill(status.pid, "SIGTERM");

    // Wait for process to exit
    let attempts = 0;
    while (attempts < 10) {
      await new Promise((r) => setTimeout(r, 500));
      if (!(await isDaemonRunning())) {
        return true;
      }
      attempts++;
    }

    // Force kill if still running
    try {
      process.kill(status.pid, "SIGKILL");
    } catch {
      // Process may have already exited
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * Start the daemon
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<void> {
  const pollInterval = options.pollInterval ?? 30000; // 30 seconds

  // Check if already running
  if (await isDaemonRunning()) {
    throw new Error("Daemon is already running");
  }

  // Write PID file
  const daemonDir = getDaemonDir();
  await fs.mkdir(daemonDir, { recursive: true });
  await fs.writeFile(getPidFilePath(), String(process.pid));

  await writeLog("Daemon starting");

  // Get central repo path
  const centralRepo = await getCentralRepoPath();
  if (!centralRepo) {
    await writeLog("No central repository configured", "warn");
  }

  // Get all directories with sync enabled from registry
  const watchedDirs: Map<string, WatcherInstance> = new Map();
  let running = true;

  // Load directories from registry
  async function loadWatchedDirs(): Promise<void> {
    if (!centralRepo) return;

    try {
      const registry = await readRegistry(centralRepo);

      // Get local directories that should be watched
      const xdgConfig = await loadXdgConfig();
      const machineId = xdgConfig.machineId;

      for (const mapping of registry.mappings) {
        if (mapping.machineId !== machineId) continue;

        const localPath = mapping.localPath;

        // Skip if already watching
        if (watchedDirs.has(localPath)) continue;

        // Check if sync is enabled for this directory
        try {
          const syncConfig = await getSyncConfig(localPath);
          if (!syncConfig.enabled) continue;

          // Start watcher
          const watcher = createFileWatcher(localPath, {
            debounceMs: 2000,
          });

          watcher.on("changes", async (changes: FileChange[]) => {
            await handleLocalChanges(localPath, changes);
          });

          watchedDirs.set(localPath, watcher);
          await writeLog(`Watching directory: ${localPath}`);
        } catch (error) {
          await writeLog(`Failed to watch ${localPath}: ${error}`, "error");
        }
      }
    } catch (error) {
      await writeLog(`Failed to load registry: ${error}`, "error");
    }
  }

  // Handle local file changes
  async function handleLocalChanges(
    memoryDir: string,
    changes: FileChange[]
  ): Promise<void> {
    await writeLog(`Local changes in ${memoryDir}: ${changes.map((c) => c.file).join(", ")}`);

    try {
      const syncConfig = await getSyncConfig(memoryDir);

      if (syncConfig.autoSync) {
        await writeLog(`Auto-pushing changes from ${memoryDir}`);
        const result = await push(memoryDir, { dryRun: false });

        if (result.success) {
          await writeLog(`Pushed ${result.pushed.length} files from ${memoryDir}`);
        } else {
          await writeLog(
            `Push failed for ${memoryDir}: ${result.errors.join(", ")}`,
            "error"
          );
        }
      }
    } catch (error) {
      await writeLog(`Failed to handle changes in ${memoryDir}: ${error}`, "error");
    }
  }

  // Poll central repo for changes
  async function pollCentralRepo(): Promise<void> {
    if (!centralRepo) return;

    try {
      // Check for changes in central repo that need to be pulled
      for (const [localPath] of watchedDirs) {
        try {
          const syncConfig = await getSyncConfig(localPath);

          if (syncConfig.autoSync) {
            const result = await pull(localPath, { dryRun: true });

            if (result.pulled.length > 0) {
              await writeLog(`Remote changes detected for ${localPath}, pulling...`);
              await pull(localPath, { dryRun: false });
            }
          }
        } catch (error) {
          await writeLog(`Failed to check/pull for ${localPath}: ${error}`, "error");
        }
      }
    } catch (error) {
      await writeLog(`Failed to poll central repo: ${error}`, "error");
    }
  }

  // Cleanup function
  async function cleanup(): Promise<void> {
    running = false;
    await writeLog("Daemon stopping");

    // Close all watchers
    for (const [dir, watcher] of watchedDirs) {
      try {
        await watcher.close();
        await writeLog(`Stopped watching: ${dir}`);
      } catch (error) {
        await writeLog(`Error closing watcher for ${dir}: ${error}`, "error");
      }
    }
    watchedDirs.clear();

    // Remove PID file
    try {
      await fs.unlink(getPidFilePath());
    } catch {
      // Ignore
    }

    await writeLog("Daemon stopped");
  }

  // Handle signals
  process.on("SIGTERM", async () => {
    await cleanup();
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await cleanup();
    process.exit(0);
  });

  // Validate registry on startup
  async function runValidation(): Promise<void> {
    try {
      const result = await validateRegistry();

      if (result.issues.length > 0) {
        for (const issue of result.issues) {
          const level = issue.severity === "error" ? "error" : "warn";
          await writeLog(`Validation: ${issue.message}`, level);
        }
      }
    } catch (error) {
      await writeLog(`Validation failed: ${error}`, "error");
    }
  }

  // Initial load and validation
  await runValidation();
  await loadWatchedDirs();

  // Validation interval tracking
  const validationInterval = options.validationInterval ?? 5 * 60 * 1000; // 5 minutes
  let lastValidation = Date.now();

  // Main loop
  while (running) {
    await new Promise((r) => setTimeout(r, pollInterval));

    if (!running) break;

    // Reload directories in case new ones were added
    await loadWatchedDirs();

    // Poll central repo for changes
    await pollCentralRepo();

    // Periodic validation
    if (Date.now() - lastValidation > validationInterval) {
      await runValidation();
      lastValidation = Date.now();
    }
  }
}

/**
 * Run daemon in background (fork process)
 */
export async function startDaemonBackground(): Promise<number> {
  const { spawn } = await import("node:child_process");

  // Get the path to the CLI
  const cliPath = process.argv[1];

  const child = spawn(process.execPath, [cliPath, "daemon", "--foreground"], {
    detached: true,
    stdio: "ignore",
  });

  child.unref();

  if (child.pid) {
    // Wait a moment and verify it started
    await new Promise((r) => setTimeout(r, 1000));

    if (await isDaemonRunning()) {
      return child.pid;
    }
  }

  throw new Error("Failed to start daemon in background");
}
