/**
 * minimem daemon - Background sync daemon commands
 */

import fs from "node:fs/promises";

import {
  startDaemon,
  startDaemonBackground,
  stopDaemon,
  getDaemonStatus,
  isDaemonRunning,
  getDaemonLogPath,
} from "../sync/daemon.js";
import { exitWithError } from "../config.js";

export type DaemonOptions = {
  background?: boolean;
  foreground?: boolean;
};

/**
 * Start the daemon
 */
export async function daemonCommand(options: DaemonOptions): Promise<void> {
  // If --foreground is specified, run in foreground (used by background spawn)
  if (options.foreground) {
    console.log("Starting daemon in foreground...");
    try {
      await startDaemon();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      exitWithError(`Daemon: ${message}`);
    }
    return;
  }

  // Check if already running
  if (await isDaemonRunning()) {
    console.log("Daemon is already running.");
    console.log("Use 'minimem daemon:stop' to stop it.");
    return;
  }

  if (options.background) {
    console.log("Starting daemon in background...");
    try {
      const pid = await startDaemonBackground();
      console.log(`Daemon started with PID ${pid}`);
      console.log(`Log file: ${getDaemonLogPath()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      exitWithError(`Failed to start daemon: ${message}`);
    }
  } else {
    console.log("Starting daemon in foreground...");
    console.log("Press Ctrl+C to stop.");
    console.log("");
    try {
      await startDaemon();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      exitWithError(`Daemon: ${message}`);
    }
  }
}

/**
 * Stop the daemon
 */
export async function daemonStopCommand(): Promise<void> {
  const status = await getDaemonStatus();

  if (!status.running) {
    console.log("Daemon is not running.");
    return;
  }

  console.log(`Stopping daemon (PID ${status.pid})...`);

  const stopped = await stopDaemon();

  if (stopped) {
    console.log("Daemon stopped.");
  } else {
    exitWithError("Failed to stop daemon.");
  }
}

/**
 * Show daemon status
 */
export async function daemonStatusCommand(): Promise<void> {
  const status = await getDaemonStatus();

  if (status.running) {
    console.log("Daemon status: running");
    console.log(`  PID: ${status.pid}`);
    console.log(`  Log: ${getDaemonLogPath()}`);
  } else {
    console.log("Daemon status: stopped");
  }
}

export type LogOptions = {
  lines?: number;
  follow?: boolean;
};

/**
 * Show daemon logs
 */
export async function daemonLogsCommand(options: LogOptions): Promise<void> {
  const logPath = getDaemonLogPath();

  try {
    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.split("\n").filter(Boolean);

    const numLines = options.lines ?? 50;
    const displayLines = lines.slice(-numLines);

    for (const line of displayLines) {
      console.log(line);
    }

    if (options.follow) {
      console.log("\n--- Following log (Ctrl+C to stop) ---\n");

      // Simple follow implementation using polling
      let lastSize = (await fs.stat(logPath)).size;

      const poll = async () => {
        try {
          const stats = await fs.stat(logPath);
          if (stats.size > lastSize) {
            const fd = await fs.open(logPath, "r");
            const buffer = Buffer.alloc(stats.size - lastSize);
            await fd.read(buffer, 0, buffer.length, lastSize);
            await fd.close();

            process.stdout.write(buffer.toString());
            lastSize = stats.size;
          }
        } catch {
          // File may have been rotated
          lastSize = 0;
        }
      };

      const interval = setInterval(poll, 1000);

      process.on("SIGINT", () => {
        clearInterval(interval);
        process.exit(0);
      });

      // Keep running
      await new Promise(() => {});
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      console.log("No daemon log found.");
    } else {
      const message = error instanceof Error ? error.message : String(error);
      exitWithError(`Error reading log: ${message}`);
    }
  }
}
