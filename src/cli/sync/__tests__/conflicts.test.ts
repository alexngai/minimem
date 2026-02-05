/**
 * Tests for change detection and quarantine
 *
 * Note: Shadow copy system was removed in favor of last-write-wins.
 * Only quarantine functions remain for manual review when needed.
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  detectChanges,
  quarantineConflict,
  listQuarantinedConflicts,
  getConflictsDir,
} from "../conflicts.js";
import { initCentralRepo } from "../central.js";
import { saveSyncState, computeFileHash } from "../state.js";
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

  describe("quarantine", () => {
    it("should quarantine file versions for manual review", async () => {
      const localContent = "Local version";
      const remoteContent = "Remote version";

      const conflictDir = await quarantineConflict(
        localDir,
        "MEMORY.md",
        localContent,
        remoteContent
      );

      const files = await fs.readdir(conflictDir);
      expect(files.includes("MEMORY.md.local")).toBeTruthy();
      expect(files.includes("MEMORY.md.remote")).toBeTruthy();

      const local = await fs.readFile(path.join(conflictDir, "MEMORY.md.local"), "utf-8");
      expect(local).toBe(localContent);
    });

    it("should handle null versions", async () => {
      const conflictDir = await quarantineConflict(
        localDir,
        "MEMORY.md",
        "Local only",
        null
      );

      const files = await fs.readdir(conflictDir);
      expect(files.includes("MEMORY.md.local")).toBeTruthy();
      expect(!files.includes("MEMORY.md.remote")).toBeTruthy();
    });

    it("should list quarantined file versions", async () => {
      await quarantineConflict(localDir, "MEMORY.md", "Local", "Remote");
      await new Promise((r) => setTimeout(r, 50)); // Slight delay for unique timestamp
      await quarantineConflict(localDir, "memory/file.md", "Local 2", "Remote 2");

      const conflicts = await listQuarantinedConflicts(localDir);

      expect(conflicts.length >= 2).toBeTruthy();
      expect(conflicts.some((c) => c.files.includes("MEMORY.md"))).toBeTruthy();
      expect(conflicts.some((c) => c.files.includes("memory/file.md"))).toBeTruthy();
    });

    it("should return empty array when no quarantined files", async () => {
      const conflicts = await listQuarantinedConflicts(localDir);
      expect(conflicts.length).toBe(0);
    });

    it("should create conflicts directory path correctly", () => {
      const conflictsDir = getConflictsDir(localDir);
      expect(conflictsDir).toBe(path.join(localDir, ".minimem", "conflicts"));
    });
  });

  describe("detectChanges", () => {
    it("should detect unchanged files", async () => {
      // Same content in both
      await fs.writeFile(path.join(localDir, "MEMORY.md"), "Same content");
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "Same content");

      // Set up sync state with matching hash
      const hash = await computeFileHash(path.join(localDir, "MEMORY.md"));
      const state = {
        version: 2,
        centralPath: "test-project",
        lastSync: new Date().toISOString(),
        files: {
          "MEMORY.md": {
            localHash: hash,
            remoteHash: hash,
            lastModified: new Date().toISOString(),
          },
        },
      };
      await saveSyncState(localDir, state);

      const result = await detectChanges(localDir);

      expect(result.summary.unchanged).toBe(1);
      expect(result.changes.length).toBe(0);
    });

    it("should detect local-only changes", async () => {
      // Local has different content
      await fs.writeFile(path.join(localDir, "MEMORY.md"), "Local change");
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "Original");

      const result = await detectChanges(localDir);

      expect(result.summary.localModified).toBe(1);
    });

    it("should detect remote-only files", async () => {
      // Remove local file, keep remote
      await fs.unlink(path.join(localDir, "MEMORY.md"));

      const result = await detectChanges(localDir);

      expect(result.summary.remoteOnly >= 1).toBeTruthy();
    });

    it("should detect differences when both changed", async () => {
      // Both have different content
      await fs.writeFile(path.join(localDir, "MEMORY.md"), "Local change");
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "Remote change");

      const result = await detectChanges(localDir);

      // With 2-way comparison, different content = local-modified
      expect(result.summary.localModified).toBe(1);
    });

    it("should detect new local files", async () => {
      await fs.writeFile(path.join(localDir, "memory", "new-file.md"), "New content");

      const result = await detectChanges(localDir);

      expect(result.summary.localOnly >= 1).toBeTruthy();
    });

    it("should detect new remote files", async () => {
      await fs.writeFile(path.join(remotePath, "memory", "new-remote.md"), "Remote content");

      const result = await detectChanges(localDir);

      expect(result.summary.remoteOnly >= 1).toBeTruthy();
    });
  });
});
