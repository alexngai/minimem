/**
 * Tests for sync state tracking
 *
 * Uses simplified 2-way comparison (local vs remote).
 * No lastSyncedHash - conflict resolution is last-write-wins.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  createEmptySyncState,
  loadSyncState,
  saveSyncState,
  computeFileHash,
  computeContentHash,
  listSyncableFiles,
  getFileSyncStatus,
  updateSyncStateAfterSync,
  removeFileFromSyncState,
  type SyncState,
} from "../state.js";

describe("Sync State", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-state-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("createEmptySyncState", () => {
    it("should create empty state with central path", () => {
      const state = createEmptySyncState("myproject/");
      expect(state.version).toBe(2);
      expect(state.lastSync).toBe(null);
      expect(state.centralPath).toBe("myproject/");
      expect(state.files).toEqual({});
    });
  });

  describe("loadSyncState / saveSyncState", () => {
    it("should return empty state when file does not exist", async () => {
      const state = await loadSyncState(tempDir, "test/");
      expect(state.lastSync).toBe(null);
      expect(state.files).toEqual({});
    });

    it("should save and load state correctly", async () => {
      await fs.mkdir(path.join(tempDir, ".minimem"), { recursive: true });

      const state: SyncState = {
        version: 2,
        lastSync: "2024-01-15T10:30:00.000Z",
        centralPath: "myproject/",
        files: {
          "MEMORY.md": {
            localHash: "abc123",
            remoteHash: "abc123",
            lastModified: "2024-01-15T10:30:00.000Z",
          },
        },
      };

      await saveSyncState(tempDir, state);
      const loaded = await loadSyncState(tempDir, "myproject/");

      expect(loaded.lastSync).toBe("2024-01-15T10:30:00.000Z");
      expect(loaded.files["MEMORY.md"].localHash).toBe("abc123");
    });

    it("should migrate v1 state to v2", async () => {
      await fs.mkdir(path.join(tempDir, ".minimem"), { recursive: true });

      // Write v1 state with lastSyncedHash
      const v1State = {
        version: 1,
        lastSync: "2024-01-15T10:30:00.000Z",
        centralPath: "myproject/",
        files: {
          "MEMORY.md": {
            localHash: "abc123",
            remoteHash: "abc123",
            lastSyncedHash: "abc123",
            lastModified: "2024-01-15T10:30:00.000Z",
          },
        },
      };

      await fs.writeFile(
        path.join(tempDir, ".minimem", "sync-state.json"),
        JSON.stringify(v1State, null, 2)
      );

      const loaded = await loadSyncState(tempDir, "myproject/");

      expect(loaded.version).toBe(2);
      // lastSyncedHash should be removed during migration
      expect((loaded.files["MEMORY.md"] as unknown as { lastSyncedHash?: string }).lastSyncedHash).toBeUndefined();
    });
  });

  describe("computeFileHash / computeContentHash", () => {
    it("should compute consistent hash for file", async () => {
      const filePath = path.join(tempDir, "test.txt");
      await fs.writeFile(filePath, "Hello, World!");

      const hash1 = await computeFileHash(filePath);
      const hash2 = await computeFileHash(filePath);

      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // SHA-256 hex
    });

    it("should compute consistent hash for content", () => {
      const hash1 = computeContentHash("Hello, World!");
      const hash2 = computeContentHash("Hello, World!");

      expect(hash1).toBe(hash2);
    });

    it("should produce different hashes for different content", () => {
      const hash1 = computeContentHash("Hello");
      const hash2 = computeContentHash("World");

      expect(hash1).not.toBe(hash2);
    });
  });

  describe("listSyncableFiles", () => {
    beforeEach(async () => {
      // Create test file structure
      await fs.mkdir(path.join(tempDir, "memory"), { recursive: true });
      await fs.mkdir(path.join(tempDir, ".minimem"), { recursive: true });
      await fs.writeFile(path.join(tempDir, "MEMORY.md"), "# Memory");
      await fs.writeFile(path.join(tempDir, "memory", "notes.md"), "# Notes");
      await fs.writeFile(path.join(tempDir, "memory", "draft.txt"), "Draft");
      await fs.writeFile(path.join(tempDir, ".minimem", "config.json"), "{}");
      await fs.writeFile(path.join(tempDir, "other.txt"), "Other");
    });

    it("should list files matching include patterns", async () => {
      const files = await listSyncableFiles(
        tempDir,
        ["MEMORY.md", "memory/**/*.md"],
        []
      );

      expect(files.includes("MEMORY.md")).toBeTruthy();
      expect(files.includes("memory/notes.md")).toBeTruthy();
      expect(!files.includes("memory/draft.txt")).toBeTruthy(); // .txt not matched
      expect(!files.includes("other.txt")).toBeTruthy(); // not matched
    });

    it("should exclude .minimem directory", async () => {
      const files = await listSyncableFiles(tempDir, ["**/*"], []);

      expect(!files.some((f) => f.includes(".minimem"))).toBeTruthy();
    });

    it("should apply exclude patterns", async () => {
      const files = await listSyncableFiles(
        tempDir,
        ["**/*.md"],
        ["memory/**"]
      );

      expect(files.includes("MEMORY.md")).toBeTruthy();
      expect(!files.includes("memory/notes.md")).toBeTruthy(); // excluded
    });

    it("should return sorted list", async () => {
      const files = await listSyncableFiles(
        tempDir,
        ["MEMORY.md", "memory/**/*.md"],
        []
      );

      const sorted = [...files].sort();
      expect(files).toEqual(sorted);
    });
  });

  describe("getFileSyncStatus", () => {
    // 2-way comparison: only localHash and remoteHash

    it("should return unchanged when hashes match", () => {
      const status = getFileSyncStatus("abc", "abc");
      expect(status).toBe("unchanged");
    });

    it("should return local-modified when hashes differ", () => {
      const status = getFileSyncStatus("local", "remote");
      expect(status).toBe("local-modified");
    });

    it("should return local-only for file only on local", () => {
      const status = getFileSyncStatus("abc", null);
      expect(status).toBe("local-only");
    });

    it("should return remote-only for file only on remote", () => {
      const status = getFileSyncStatus(null, "abc");
      expect(status).toBe("remote-only");
    });

    it("should return unchanged when both null", () => {
      const status = getFileSyncStatus(null, null);
      expect(status).toBe("unchanged");
    });
  });

  describe("updateSyncStateAfterSync", () => {
    it("should update file entry and lastSync", () => {
      const state = createEmptySyncState("test/");
      const updated = updateSyncStateAfterSync(state, "MEMORY.md", "newhash");

      expect(updated.lastSync).toBeTruthy();
      expect(updated.files["MEMORY.md"].localHash).toBe("newhash");
      expect(updated.files["MEMORY.md"].remoteHash).toBe("newhash");
    });
  });

  describe("removeFileFromSyncState", () => {
    it("should remove file entry", () => {
      const state: SyncState = {
        version: 2,
        lastSync: "2024-01-15T10:30:00.000Z",
        centralPath: "test/",
        files: {
          "MEMORY.md": {
            localHash: "abc",
            remoteHash: "abc",
            lastModified: "2024-01-15T10:30:00.000Z",
          },
          "notes.md": {
            localHash: "def",
            remoteHash: "def",
            lastModified: "2024-01-15T10:30:00.000Z",
          },
        },
      };

      const updated = removeFileFromSyncState(state, "MEMORY.md");

      expect(!("MEMORY.md" in updated.files)).toBeTruthy();
      expect("notes.md" in updated.files).toBeTruthy();
    });
  });
});
