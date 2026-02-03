/**
 * Tests for daemon module
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  getDaemonDir,
  getPidFilePath,
  getDaemonLogPath,
  isDaemonRunning,
  getDaemonStatus,
} from "../daemon.js";

describe("Daemon", () => {
  let originalHome: string | undefined;
  let tempHome: string;

  beforeEach(async () => {
    // Create temp home directory
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-daemon-test-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempHome;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    try {
      await fs.rm(tempHome, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("getDaemonDir", () => {
    it("should return path in home directory", () => {
      const dir = getDaemonDir();
      expect(dir.includes(".minimem")).toBeTruthy();
      expect(dir.startsWith(tempHome)).toBeTruthy();
    });
  });

  describe("getPidFilePath", () => {
    it("should return path to daemon.pid", () => {
      const pidPath = getPidFilePath();
      expect(pidPath.endsWith("daemon.pid")).toBeTruthy();
      expect(pidPath.includes(".minimem")).toBeTruthy();
    });
  });

  describe("getDaemonLogPath", () => {
    it("should return path to daemon.log", () => {
      const logPath = getDaemonLogPath();
      expect(logPath.endsWith("daemon.log")).toBeTruthy();
      expect(logPath.includes(".minimem")).toBeTruthy();
    });
  });

  describe("isDaemonRunning", () => {
    it("should return false when no PID file exists", async () => {
      const running = await isDaemonRunning();
      expect(running).toBe(false);
    });

    it("should return false when PID file has invalid content", async () => {
      const daemonDir = getDaemonDir();
      await fs.mkdir(daemonDir, { recursive: true });
      await fs.writeFile(getPidFilePath(), "not-a-number");

      const running = await isDaemonRunning();
      expect(running).toBe(false);
    });

    it("should return false when process is not running", async () => {
      const daemonDir = getDaemonDir();
      await fs.mkdir(daemonDir, { recursive: true });
      // Use a PID that definitely doesn't exist
      await fs.writeFile(getPidFilePath(), "999999999");

      const running = await isDaemonRunning();
      expect(running).toBe(false);

      // PID file should be cleaned up
      const exists = await fs.access(getPidFilePath()).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });

    it("should return true for current process PID", async () => {
      const daemonDir = getDaemonDir();
      await fs.mkdir(daemonDir, { recursive: true });
      await fs.writeFile(getPidFilePath(), String(process.pid));

      const running = await isDaemonRunning();
      expect(running).toBe(true);
    });
  });

  describe("getDaemonStatus", () => {
    it("should return not running when no daemon", async () => {
      const status = await getDaemonStatus();
      expect(status.running).toBe(false);
      expect(status.pid).toBe(undefined);
    });

    it("should return running with PID when daemon is running", async () => {
      const daemonDir = getDaemonDir();
      await fs.mkdir(daemonDir, { recursive: true });
      await fs.writeFile(getPidFilePath(), String(process.pid));

      const status = await getDaemonStatus();
      expect(status.running).toBe(true);
      expect(status.pid).toBe(process.pid);
    });
  });
});
