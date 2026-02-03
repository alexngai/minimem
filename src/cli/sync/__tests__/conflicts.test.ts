/**
 * Tests for conflict detection and quarantine
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  detectConflicts,
  quarantineConflict,
  listQuarantinedConflicts,
  getShadowsDir,
  getConflictsDir,
  createShadowCopy,
  readShadowCopy,
  deleteShadowCopy,
  cleanShadows,
} from "../conflicts.js";
import { initCentralRepo } from "../central.js";
import { loadSyncState, saveSyncState, computeFileHash } from "../state.js";
import { saveConfig } from "../../config.js";

describe("conflicts", () => {
  let tempDir: string;
  let localDir: string;
  let centralRepo: string;
  let remotePath: string;

  beforeEach(async () => {
    // Create temp directories
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-conflicts-test-"));
    localDir = path.join(tempDir, "local");
    centralRepo = path.join(tempDir, "central");
    remotePath = path.join(centralRepo, "test-project");

    // Set up directories
    await fs.mkdir(localDir, { recursive: true });
    await fs.mkdir(path.join(localDir, ".minimem"), { recursive: true });
    await fs.mkdir(path.join(localDir, "memory"), { recursive: true });
    await fs.mkdir(remotePath, { recursive: true });
    await fs.mkdir(path.join(remotePath, "memory"), { recursive: true });

    // Initialize central repo
    await initCentralRepo(centralRepo);

    // Write MEMORY.md to both
    await fs.writeFile(path.join(localDir, "MEMORY.md"), "# Local Memory\n");
    await fs.writeFile(path.join(remotePath, "MEMORY.md"), "# Remote Memory\n");

    // Configure sync
    const config = {
      sync: {
        enabled: true,
        path: "test-project",
      },
    };
    await saveConfig(localDir, config);

    // Set up XDG config with central repo path
    const xdgDir = path.join(tempDir, "xdg-config");
    await fs.mkdir(xdgDir, { recursive: true });
    process.env.XDG_CONFIG_HOME = xdgDir;
    await fs.mkdir(path.join(xdgDir, "minimem"), { recursive: true });
    await fs.writeFile(
      path.join(xdgDir, "minimem", "config.json"),
      JSON.stringify({ centralRepo }, null, 2)
    );
  });

  afterEach(async () => {
    delete process.env.XDG_CONFIG_HOME;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("shadow copies", () => {
    it("should create and read shadow copy", async () => {
      const content = "Original file content";
      await createShadowCopy(localDir, "MEMORY.md", content);

      const read = await readShadowCopy(localDir, "MEMORY.md");
      expect(read).toBe(content);
    });

    it("should flatten file paths in shadow names", async () => {
      await createShadowCopy(localDir, "memory/2024-01-01.md", "Content");

      const shadowsDir = getShadowsDir(localDir);
      const files = await fs.readdir(shadowsDir);
      expect(files.some((f) => f.includes("memory_2024-01-01.md.base"))).toBeTruthy();
    });

    it("should return null for non-existent shadow", async () => {
      const read = await readShadowCopy(localDir, "nonexistent.md");
      expect(read).toBe(null);
    });

    it("should delete shadow copy", async () => {
      await createShadowCopy(localDir, "MEMORY.md", "Content");
      await deleteShadowCopy(localDir, "MEMORY.md");

      const read = await readShadowCopy(localDir, "MEMORY.md");
      expect(read).toBe(null);
    });

    it("should clean all shadows", async () => {
      await createShadowCopy(localDir, "MEMORY.md", "Content 1");
      await createShadowCopy(localDir, "memory/file.md", "Content 2");

      await cleanShadows(localDir);

      const read1 = await readShadowCopy(localDir, "MEMORY.md");
      const read2 = await readShadowCopy(localDir, "memory/file.md");
      expect(read1).toBe(null);
      expect(read2).toBe(null);
    });
  });

  describe("quarantine", () => {
    it("should quarantine conflict with all versions", async () => {
      const localContent = "Local version";
      const remoteContent = "Remote version";
      const baseContent = "Base version";

      const conflictDir = await quarantineConflict(
        localDir,
        "MEMORY.md",
        localContent,
        remoteContent,
        baseContent
      );

      const files = await fs.readdir(conflictDir);
      expect(files.includes("MEMORY.md.local")).toBeTruthy();
      expect(files.includes("MEMORY.md.remote")).toBeTruthy();
      expect(files.includes("MEMORY.md.base")).toBeTruthy();

      const local = await fs.readFile(path.join(conflictDir, "MEMORY.md.local"), "utf-8");
      expect(local).toBe(localContent);
    });

    it("should handle null versions", async () => {
      const conflictDir = await quarantineConflict(
        localDir,
        "MEMORY.md",
        "Local only",
        null,
        null
      );

      const files = await fs.readdir(conflictDir);
      expect(files.includes("MEMORY.md.local")).toBeTruthy();
      expect(!files.includes("MEMORY.md.remote")).toBeTruthy();
      expect(!files.includes("MEMORY.md.base")).toBeTruthy();
    });

    it("should list quarantined conflicts", async () => {
      await quarantineConflict(localDir, "MEMORY.md", "Local", "Remote", "Base");
      await new Promise((r) => setTimeout(r, 50)); // Slight delay for unique timestamp
      await quarantineConflict(localDir, "memory/file.md", "Local 2", "Remote 2", null);

      const conflicts = await listQuarantinedConflicts(localDir);

      expect(conflicts.length >= 2).toBeTruthy();
      expect(conflicts.some((c) => c.files.includes("MEMORY.md"))).toBeTruthy();
      expect(conflicts.some((c) => c.files.includes("memory/file.md"))).toBeTruthy();
    });

    it("should return empty array when no conflicts", async () => {
      const conflicts = await listQuarantinedConflicts(localDir);
      expect(conflicts.length).toBe(0);
    });
  });

  describe("detectConflicts", () => {
    it("should detect unchanged files", async () => {
      // Same content in both
      await fs.writeFile(path.join(localDir, "MEMORY.md"), "Same content");
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "Same content");

      // Set up sync state with matching hash
      const hash = await computeFileHash(path.join(localDir, "MEMORY.md"));
      const state = {
        repoPath: "test-project",
        lastSync: new Date().toISOString(),
        files: {
          "MEMORY.md": {
            localHash: hash,
            remoteHash: hash,
            lastSyncedHash: hash,
            lastModified: new Date().toISOString(),
          },
        },
      };
      await saveSyncState(localDir, state);

      const result = await detectConflicts(localDir);

      expect(result.summary.unchanged).toBe(1);
      expect(result.summary.conflicts).toBe(0);
    });

    it("should detect local-only changes", async () => {
      // Local has different content
      await fs.writeFile(path.join(localDir, "MEMORY.md"), "Local change");
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "Original");

      // State shows original was synced
      const hash = await computeFileHash(path.join(remotePath, "MEMORY.md"));
      const state = {
        repoPath: "test-project",
        lastSync: new Date().toISOString(),
        files: {
          "MEMORY.md": {
            localHash: hash,
            remoteHash: hash,
            lastSyncedHash: hash,
            lastModified: new Date().toISOString(),
          },
        },
      };
      await saveSyncState(localDir, state);

      const result = await detectConflicts(localDir);

      expect(result.summary.localOnly).toBe(1);
    });

    it("should detect remote-only changes", async () => {
      // Remote has different content
      await fs.writeFile(path.join(localDir, "MEMORY.md"), "Original");
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "Remote change");

      // State shows original was synced
      const hash = await computeFileHash(path.join(localDir, "MEMORY.md"));
      const state = {
        repoPath: "test-project",
        lastSync: new Date().toISOString(),
        files: {
          "MEMORY.md": {
            localHash: hash,
            remoteHash: hash,
            lastSyncedHash: hash,
            lastModified: new Date().toISOString(),
          },
        },
      };
      await saveSyncState(localDir, state);

      const result = await detectConflicts(localDir);

      expect(result.summary.remoteOnly).toBe(1);
    });

    it("should detect conflicts when both changed", async () => {
      // Both have different content from base
      await fs.writeFile(path.join(localDir, "MEMORY.md"), "Local change");
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "Remote change");

      // State shows something else was synced
      const state = {
        repoPath: "test-project",
        lastSync: new Date().toISOString(),
        files: {
          "MEMORY.md": {
            localHash: "original-hash",
            remoteHash: "original-hash",
            lastSyncedHash: "original-hash",
            lastModified: new Date().toISOString(),
          },
        },
      };
      await saveSyncState(localDir, state);

      const result = await detectConflicts(localDir);

      expect(result.summary.conflicts).toBe(1);
    });

    it("should detect new local files", async () => {
      await fs.writeFile(path.join(localDir, "memory", "new-file.md"), "New content");

      // No state for this file
      const state = {
        repoPath: "test-project",
        lastSync: new Date().toISOString(),
        files: {},
      };
      await saveSyncState(localDir, state);

      const result = await detectConflicts(localDir);

      expect(result.summary.newLocal >= 1).toBeTruthy();
    });

    it("should detect new remote files", async () => {
      await fs.writeFile(path.join(remotePath, "memory", "new-remote.md"), "Remote content");

      // No state for this file
      const state = {
        repoPath: "test-project",
        lastSync: new Date().toISOString(),
        files: {},
      };
      await saveSyncState(localDir, state);

      const result = await detectConflicts(localDir);

      expect(result.summary.newRemote >= 1).toBeTruthy();
    });
  });
});
