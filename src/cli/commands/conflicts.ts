/**
 * minimem sync:conflicts - Conflict management commands
 */

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  resolveMemoryDir,
  isInitialized,
  formatPath,
  getSyncConfig,
} from "../config.js";
import {
  listQuarantinedConflicts,
  getConflictsDir,
  getShadowsDir,
} from "../sync/conflicts.js";
import { getSyncStatePath, loadSyncState } from "../sync/state.js";

export type ConflictsOptions = {
  dir?: string;
  global?: boolean;
  json?: boolean;
};

/**
 * List all quarantined conflicts
 */
export async function conflictsCommand(options: ConflictsOptions): Promise<void> {
  const memoryDir = resolveMemoryDir({
    dir: options.dir,
    global: options.global,
  });

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    process.exit(1);
  }

  try {
    const conflicts = await listQuarantinedConflicts(memoryDir);

    if (options.json) {
      console.log(JSON.stringify(conflicts, null, 2));
      return;
    }

    if (conflicts.length === 0) {
      console.log("No quarantined conflicts.");
      return;
    }

    console.log(`Quarantined conflicts in ${formatPath(memoryDir)}`);
    console.log("-".repeat(50));

    for (const conflict of conflicts) {
      console.log(`\n${conflict.timestamp}:`);
      for (const file of conflict.files) {
        console.log(`  - ${file}`);
      }
    }

    console.log(`\nTotal: ${conflicts.length} conflict set(s)`);
    console.log("\nUse 'minimem sync:resolve <timestamp>' to resolve a conflict.");
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

export type ResolveOptions = {
  dir?: string;
  global?: boolean;
  tool?: string;
};

/**
 * Resolve a quarantined conflict
 */
export async function resolveCommand(
  timestamp: string,
  options: ResolveOptions
): Promise<void> {
  const memoryDir = resolveMemoryDir({
    dir: options.dir,
    global: options.global,
  });

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    process.exit(1);
  }

  const conflictDir = path.join(getConflictsDir(memoryDir), timestamp);

  try {
    await fs.access(conflictDir);
  } catch {
    console.error(`Error: Conflict '${timestamp}' not found.`);
    console.error("Use 'minimem sync:conflicts' to list available conflicts.");
    process.exit(1);
  }

  try {
    const files = await fs.readdir(conflictDir);

    // Group files by base name
    const fileGroups = new Map<string, { local?: string; remote?: string; base?: string }>();
    for (const file of files) {
      const match = file.match(/^(.+)\.(local|remote|base)$/);
      if (match) {
        const [, baseName, type] = match;
        if (!fileGroups.has(baseName)) {
          fileGroups.set(baseName, {});
        }
        const group = fileGroups.get(baseName)!;
        group[type as "local" | "remote" | "base"] = path.join(conflictDir, file);
      }
    }

    if (fileGroups.size === 0) {
      console.error("No conflict files found in this directory.");
      process.exit(1);
    }

    // Determine merge tool
    const mergeTool = options.tool || process.env.MERGE_TOOL || await detectMergeTool();

    if (!mergeTool) {
      console.log("No merge tool detected. Available conflict files:");
      for (const [baseName, group] of fileGroups) {
        console.log(`\n${baseName.replace(/_/g, "/")}:`);
        if (group.local) console.log(`  Local:  ${group.local}`);
        if (group.remote) console.log(`  Remote: ${group.remote}`);
        if (group.base) console.log(`  Base:   ${group.base}`);
      }
      console.log("\nManually edit the files or set MERGE_TOOL environment variable.");
      return;
    }

    console.log(`Using merge tool: ${mergeTool}`);

    for (const [baseName, group] of fileGroups) {
      const fileName = baseName.replace(/_/g, "/");
      console.log(`\nResolving: ${fileName}`);

      if (group.local && group.remote) {
        // Launch merge tool
        const args = group.base
          ? [group.local, group.base, group.remote]
          : [group.local, group.remote];

        const child = spawn(mergeTool, args, { stdio: "inherit" });

        await new Promise<void>((resolve, reject) => {
          child.on("close", (code) => {
            if (code === 0) {
              resolve();
            } else {
              reject(new Error(`Merge tool exited with code ${code}`));
            }
          });
          child.on("error", reject);
        });
      }
    }

    console.log("\nMerge complete. Remove conflict directory when satisfied:");
    console.log(`  rm -rf "${conflictDir}"`);
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

/**
 * Detect available merge tool
 */
async function detectMergeTool(): Promise<string | null> {
  const tools = ["code", "meld", "kdiff3", "vimdiff", "opendiff"];

  for (const tool of tools) {
    try {
      const { execSync } = await import("node:child_process");
      execSync(`which ${tool}`, { stdio: "ignore" });
      return tool;
    } catch {
      continue;
    }
  }

  return null;
}

export type CleanupOptions = {
  dir?: string;
  global?: boolean;
  days?: number;
  dryRun?: boolean;
};

/**
 * Clean up old quarantined conflicts
 */
export async function cleanupCommand(options: CleanupOptions): Promise<void> {
  const memoryDir = resolveMemoryDir({
    dir: options.dir,
    global: options.global,
  });

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    process.exit(1);
  }

  const maxAgeDays = options.days ?? 30;
  const cutoffDate = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000);

  try {
    const conflictsDir = getConflictsDir(memoryDir);
    let entries: string[] = [];

    try {
      entries = await fs.readdir(conflictsDir);
    } catch {
      console.log("No conflicts directory found.");
      return;
    }

    let cleaned = 0;
    let kept = 0;

    for (const entry of entries) {
      // Timestamps are in ISO format with : and . replaced with -
      // e.g., 2026-02-03T07-20-56-704Z
      const timestamp = entry.replace(/-(\d{2})-(\d{2})-(\d{3})Z$/, ":$1:$2.$3Z");
      const entryDate = new Date(timestamp);

      if (isNaN(entryDate.getTime())) {
        console.log(`  Skipping invalid timestamp: ${entry}`);
        continue;
      }

      const entryPath = path.join(conflictsDir, entry);

      if (entryDate < cutoffDate) {
        if (options.dryRun) {
          console.log(`  Would remove: ${entry}`);
        } else {
          await fs.rm(entryPath, { recursive: true, force: true });
          console.log(`  Removed: ${entry}`);
        }
        cleaned++;
      } else {
        kept++;
      }
    }

    if (options.dryRun) {
      console.log(`\nWould remove ${cleaned} conflict(s), keep ${kept}`);
    } else {
      console.log(`\nRemoved ${cleaned} conflict(s), kept ${kept}`);
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}

/**
 * Sync logging
 */
const SYNC_LOG_FILE = "sync.log";
const MAX_LOG_ENTRIES = 1000;

export type SyncLogEntry = {
  timestamp: string;
  operation: "push" | "pull" | "sync";
  result: "success" | "partial" | "failure";
  pushed?: number;
  pulled?: number;
  conflicts?: number;
  errors?: string[];
};

/**
 * Get sync log path
 */
export function getSyncLogPath(memoryDir: string): string {
  return path.join(memoryDir, ".minimem", SYNC_LOG_FILE);
}

/**
 * Append to sync log
 */
export async function appendSyncLog(
  memoryDir: string,
  entry: SyncLogEntry
): Promise<void> {
  const logPath = getSyncLogPath(memoryDir);

  try {
    await fs.mkdir(path.dirname(logPath), { recursive: true });

    // Read existing log
    let entries: SyncLogEntry[] = [];
    try {
      const content = await fs.readFile(logPath, "utf-8");
      entries = content
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      // No existing log
    }

    // Add new entry and trim if needed
    entries.push(entry);
    if (entries.length > MAX_LOG_ENTRIES) {
      entries = entries.slice(-MAX_LOG_ENTRIES);
    }

    // Write back
    const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.writeFile(logPath, content);
  } catch (error) {
    // Log failures are non-fatal
    console.error(`Warning: Failed to write sync log: ${error}`);
  }
}

/**
 * Read sync log
 */
export async function readSyncLog(memoryDir: string): Promise<SyncLogEntry[]> {
  const logPath = getSyncLogPath(memoryDir);

  try {
    const content = await fs.readFile(logPath, "utf-8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export type LogOptions = {
  dir?: string;
  global?: boolean;
  limit?: number;
  json?: boolean;
};

/**
 * Show sync log
 */
export async function logCommand(options: LogOptions): Promise<void> {
  const memoryDir = resolveMemoryDir({
    dir: options.dir,
    global: options.global,
  });

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    process.exit(1);
  }

  try {
    let entries = await readSyncLog(memoryDir);

    const limit = options.limit ?? 20;
    entries = entries.slice(-limit);

    if (options.json) {
      console.log(JSON.stringify(entries, null, 2));
      return;
    }

    if (entries.length === 0) {
      console.log("No sync history.");
      return;
    }

    console.log(`Sync history for ${formatPath(memoryDir)}`);
    console.log("-".repeat(60));

    for (const entry of entries) {
      const time = new Date(entry.timestamp).toLocaleString();
      const status =
        entry.result === "success" ? "OK" :
        entry.result === "partial" ? "PARTIAL" : "FAILED";

      let details = "";
      if (entry.pushed) details += ` +${entry.pushed}`;
      if (entry.pulled) details += ` -${entry.pulled}`;
      if (entry.conflicts) details += ` !${entry.conflicts}`;

      console.log(`${time}  ${entry.operation.padEnd(6)}  ${status.padEnd(8)}${details}`);

      if (entry.errors && entry.errors.length > 0) {
        for (const error of entry.errors.slice(0, 3)) {
          console.log(`    Error: ${error}`);
        }
      }
    }
  } catch (error) {
    console.error(`Error: ${error}`);
    process.exit(1);
  }
}
