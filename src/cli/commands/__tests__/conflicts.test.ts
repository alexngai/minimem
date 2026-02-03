/**
 * Tests for conflict CLI commands and sync logging
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  appendSyncLog,
  readSyncLog,
  getSyncLogPath,
  type SyncLogEntry,
} from "../conflicts.js";

describe("sync logging", () => {
  let tempDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-log-test-"));
    memoryDir = path.join(tempDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    await fs.mkdir(path.join(memoryDir, ".minimem"), { recursive: true });
  });

  afterEach(async () => {
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("appendSyncLog", () => {
    it("should create log file if not exists", async () => {
      const entry: SyncLogEntry = {
        timestamp: new Date().toISOString(),
        operation: "push",
        result: "success",
        pushed: 3,
      };

      await appendSyncLog(memoryDir, entry);

      const logPath = getSyncLogPath(memoryDir);
      const exists = await fs.access(logPath).then(() => true).catch(() => false);
      expect(exists).toBeTruthy();
    });

    it("should append multiple entries", async () => {
      const entry1: SyncLogEntry = {
        timestamp: new Date().toISOString(),
        operation: "push",
        result: "success",
        pushed: 2,
      };

      const entry2: SyncLogEntry = {
        timestamp: new Date().toISOString(),
        operation: "pull",
        result: "success",
        pulled: 3,
      };

      await appendSyncLog(memoryDir, entry1);
      await appendSyncLog(memoryDir, entry2);

      const entries = await readSyncLog(memoryDir);
      expect(entries.length).toBe(2);
      expect(entries[0].operation).toBe("push");
      expect(entries[1].operation).toBe("pull");
    });

    it("should store error messages", async () => {
      const entry: SyncLogEntry = {
        timestamp: new Date().toISOString(),
        operation: "push",
        result: "failure",
        errors: ["File not found", "Permission denied"],
      };

      await appendSyncLog(memoryDir, entry);

      const entries = await readSyncLog(memoryDir);
      expect(entries.length).toBe(1);
      expect(entries[0].errors).toEqual(["File not found", "Permission denied"]);
    });

    it("should record conflict count", async () => {
      const entry: SyncLogEntry = {
        timestamp: new Date().toISOString(),
        operation: "push",
        result: "partial",
        pushed: 2,
        conflicts: 1,
      };

      await appendSyncLog(memoryDir, entry);

      const entries = await readSyncLog(memoryDir);
      expect(entries[0].conflicts).toBe(1);
      expect(entries[0].result).toBe("partial");
    });
  });

  describe("readSyncLog", () => {
    it("should return empty array when no log exists", async () => {
      const entries = await readSyncLog(memoryDir);
      expect(entries).toEqual([]);
    });

    it("should parse JSONL format", async () => {
      const logPath = getSyncLogPath(memoryDir);
      const entries = [
        { timestamp: "2024-01-01T10:00:00Z", operation: "push", result: "success", pushed: 1 },
        { timestamp: "2024-01-01T11:00:00Z", operation: "pull", result: "success", pulled: 2 },
      ];

      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        entries.map((e) => JSON.stringify(e)).join("\n") + "\n"
      );

      const read = await readSyncLog(memoryDir);
      expect(read.length).toBe(2);
      expect(read[0].pushed).toBe(1);
      expect(read[1].pulled).toBe(2);
    });
  });

  describe("getSyncLogPath", () => {
    it("should return path in .minimem directory", () => {
      const logPath = getSyncLogPath(memoryDir);
      expect(logPath.includes(".minimem")).toBeTruthy();
      expect(logPath.endsWith("sync.log")).toBeTruthy();
    });
  });
});
