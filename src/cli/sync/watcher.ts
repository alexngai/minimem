/**
 * File watcher with debouncing for memory directories
 */

import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import { EventEmitter } from "node:events";

import { listSyncableFiles } from "./state.js";

export type WatcherEvent = "add" | "change" | "unlink";

export type FileChange = {
  event: WatcherEvent;
  file: string; // Relative path
};

export type WatcherOptions = {
  /** Debounce interval in milliseconds (default: 2000) */
  debounceMs?: number;
  /** Patterns to include (default: MEMORY.md, memory/*.md) */
  include?: string[];
  /** Patterns to exclude */
  exclude?: string[];
  /** Use polling instead of native events (for network drives) */
  usePolling?: boolean;
  /** Polling interval in milliseconds (default: 1000) */
  pollInterval?: number;
};

export type WatcherInstance = {
  /** Stop watching and clean up */
  close: () => Promise<void>;
  /** Add event listener */
  on: (event: "changes", listener: (changes: FileChange[]) => void) => void;
  /** Remove event listener */
  off: (event: "changes", listener: (changes: FileChange[]) => void) => void;
  /** Whether the watcher is ready */
  ready: boolean;
};

const DEFAULT_DEBOUNCE_MS = 2000;
const DEFAULT_POLL_INTERVAL = 1000;

const DEFAULT_INCLUDE = ["MEMORY.md", "memory/**/*.md"];
const DEFAULT_EXCLUDE = [".minimem/**", "node_modules/**", ".git/**"];

/**
 * Create a file watcher for a memory directory
 */
export function createFileWatcher(
  memoryDir: string,
  options: WatcherOptions = {}
): WatcherInstance {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const include = options.include ?? DEFAULT_INCLUDE;
  const exclude = options.exclude ?? DEFAULT_EXCLUDE;

  const emitter = new EventEmitter();
  let watcher: FSWatcher | null = null;
  let ready = false;

  // Pending changes for debouncing
  let pendingChanges: Map<string, FileChange> = new Map();
  let debounceTimer: NodeJS.Timeout | null = null;

  /**
   * Flush pending changes
   */
  const flushChanges = () => {
    if (pendingChanges.size > 0) {
      const changes = Array.from(pendingChanges.values());
      pendingChanges = new Map();
      emitter.emit("changes", changes);
    }
    debounceTimer = null;
  };

  /**
   * Schedule a debounced flush
   */
  const scheduleFlush = () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(flushChanges, debounceMs);
  };

  /**
   * Handle a file event
   */
  const handleEvent = (event: WatcherEvent, filePath: string) => {
    // Get relative path
    const relativePath = path.relative(memoryDir, filePath);

    // Skip files in .minimem
    if (relativePath.startsWith(".minimem")) {
      return;
    }

    // Check if file matches include patterns
    const isIncluded = include.some((pattern) => {
      if (pattern.includes("*")) {
        // Simple glob matching
        const regex = new RegExp(
          "^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$"
        );
        return regex.test(relativePath);
      }
      return relativePath === pattern || relativePath.startsWith(pattern + "/");
    });

    if (!isIncluded) {
      return;
    }

    // Check if file matches exclude patterns
    const isExcluded = exclude.some((pattern) => {
      if (pattern.includes("*")) {
        const regex = new RegExp(
          "^" + pattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*") + "$"
        );
        return regex.test(relativePath);
      }
      return relativePath === pattern || relativePath.startsWith(pattern);
    });

    if (isExcluded) {
      return;
    }

    // Add to pending changes (later events override earlier for same file)
    pendingChanges.set(relativePath, { event, file: relativePath });
    scheduleFlush();
  };

  // Create watcher
  const watchPaths = include.map((pattern) => path.join(memoryDir, pattern));

  watcher = chokidar.watch(watchPaths, {
    ignored: exclude.map((pattern) => path.join(memoryDir, pattern)),
    persistent: true,
    ignoreInitial: true,
    usePolling: options.usePolling ?? false,
    interval: options.pollInterval ?? DEFAULT_POLL_INTERVAL,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher
    .on("add", (filePath) => handleEvent("add", filePath))
    .on("change", (filePath) => handleEvent("change", filePath))
    .on("unlink", (filePath) => handleEvent("unlink", filePath))
    .on("ready", () => {
      ready = true;
    })
    .on("error", (error) => {
      console.error(`Watcher error: ${error}`);
    });

  return {
    close: async () => {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      if (watcher) {
        await watcher.close();
        watcher = null;
      }
      emitter.removeAllListeners();
    },

    on: (event: "changes", listener: (changes: FileChange[]) => void) => {
      emitter.on(event, listener);
    },

    off: (event: "changes", listener: (changes: FileChange[]) => void) => {
      emitter.off(event, listener);
    },

    get ready() {
      return ready;
    },
  };
}

/**
 * Watch multiple directories
 */
export function createMultiDirWatcher(
  memoryDirs: string[],
  options: WatcherOptions = {}
): WatcherInstance {
  const watchers = memoryDirs.map((dir) => ({
    dir,
    watcher: createFileWatcher(dir, options),
  }));

  const emitter = new EventEmitter();

  // Forward events from all watchers
  for (const { dir, watcher } of watchers) {
    watcher.on("changes", (changes) => {
      // Add directory info to changes
      const changesWithDir = changes.map((c) => ({
        ...c,
        file: path.join(dir, c.file),
      }));
      emitter.emit("changes", changesWithDir);
    });
  }

  return {
    close: async () => {
      await Promise.all(watchers.map(({ watcher }) => watcher.close()));
      emitter.removeAllListeners();
    },

    on: (event: "changes", listener: (changes: FileChange[]) => void) => {
      emitter.on(event, listener);
    },

    off: (event: "changes", listener: (changes: FileChange[]) => void) => {
      emitter.off(event, listener);
    },

    get ready() {
      return watchers.every(({ watcher }) => watcher.ready);
    },
  };
}
