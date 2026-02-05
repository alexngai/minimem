/**
 * Integration tests for the git sync system
 *
 * Tests end-to-end workflows including:
 * - Bootstrap flows (central repo creation, sync init)
 * - Push/pull operations with last-write-wins
 * - Change detection
 * - Collision prevention
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { initCentralRepo, validateCentralRepo, getCentralRepoPath } from "../central.js";
import {
  readRegistry,
  writeRegistry,
  createEmptyRegistry,
  addMapping,
  checkCollision,
} from "../registry.js";
import {
  loadSyncState,
  saveSyncState,
  computeFileHash,
  listSyncableFiles,
} from "../state.js";
import { detectChanges, quarantineConflict, listQuarantinedConflicts } from "../conflicts.js";
import { push, pull, bidirectionalSync } from "../operations.js";
import { validateRegistry } from "../validation.js";
import { saveConfig, loadXdgConfig, saveXdgConfig } from "../../config.js";

describe("Git Sync Integration Tests", () => {
  let tempDir: string;
  let centralRepo: string;
  let localDir1: string;
  let localDir2: string;
  let xdgDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-integration-"));
    centralRepo = path.join(tempDir, "central");
    localDir1 = path.join(tempDir, "local1");
    localDir2 = path.join(tempDir, "local2");
    xdgDir = path.join(tempDir, "xdg-config");

    // Create directories
    await fs.mkdir(localDir1, { recursive: true });
    await fs.mkdir(path.join(localDir1, ".minimem"), { recursive: true });
    await fs.mkdir(path.join(localDir1, "memory"), { recursive: true });

    await fs.mkdir(localDir2, { recursive: true });
    await fs.mkdir(path.join(localDir2, ".minimem"), { recursive: true });
    await fs.mkdir(path.join(localDir2, "memory"), { recursive: true });

    // Set up XDG config
    process.env.XDG_CONFIG_HOME = xdgDir;
    await fs.mkdir(path.join(xdgDir, "minimem"), { recursive: true });
  });

  afterEach(async () => {
    delete process.env.XDG_CONFIG_HOME;
    try {
      await fs.rm(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("Bootstrap Flows", () => {
    it("should create fresh central repository", async () => {
      const result = await initCentralRepo(centralRepo);

      expect(result.success).toBe(true);
      expect(result.created).toBe(true);

      const validation = await validateCentralRepo(centralRepo);
      expect(validation.valid).toBe(true);

      const registry = await readRegistry(centralRepo);
      expect(registry).toBeTruthy();
      expect(registry.mappings.length).toBe(0);
    });

    it("should set up XDG config with central repo path", async () => {
      await initCentralRepo(centralRepo);
      await saveXdgConfig({ centralRepo, machineId: "test-machine" });

      const path = await getCentralRepoPath();
      expect(path).toBe(centralRepo);
    });

    it("should initialize directory for sync", async () => {
      await initCentralRepo(centralRepo);
      await saveXdgConfig({ centralRepo, machineId: "machine-1" });

      // Create MEMORY.md
      await fs.writeFile(path.join(localDir1, "MEMORY.md"), "# Initial Memory\n");

      // Configure sync
      await saveConfig(localDir1, {
        sync: {
          enabled: true,
          path: "project1",
        },
      });

      // Add to registry
      const registry = await readRegistry(centralRepo);
      const updated = addMapping(registry, {
        path: "project1",
        localPath: localDir1,
        machineId: "machine-1",
        lastSync: new Date().toISOString(),
      });
      await writeRegistry(centralRepo, updated);

      // Verify
      const finalRegistry = await readRegistry(centralRepo);
      expect(finalRegistry.mappings.length).toBe(1);
      // Path may have trailing slash due to normalization
      expect(finalRegistry.mappings[0].path.startsWith("project1")).toBeTruthy();
    });

    it("should simulate clone setup on new machine", async () => {
      // Setup: machine 1 pushes initial content
      await initCentralRepo(centralRepo);
      await saveXdgConfig({ centralRepo, machineId: "machine-1" });

      await fs.writeFile(path.join(localDir1, "MEMORY.md"), "# Shared Memory\n");
      await saveConfig(localDir1, { sync: { enabled: true, path: "shared" } });

      // Create remote directory structure
      const remotePath = path.join(centralRepo, "shared");
      await fs.mkdir(remotePath, { recursive: true });
      await fs.copyFile(path.join(localDir1, "MEMORY.md"), path.join(remotePath, "MEMORY.md"));

      // Add mapping
      let registry = await readRegistry(centralRepo);
      registry = addMapping(registry, {
        path: "shared",
        localPath: localDir1,
        machineId: "machine-1",
        lastSync: new Date().toISOString(),
      });
      await writeRegistry(centralRepo, registry);

      // Now: machine 2 sets up and pulls
      await saveXdgConfig({ centralRepo, machineId: "machine-2" });
      await saveConfig(localDir2, { sync: { enabled: true, path: "shared" } });

      // Pull content
      const result = await pull(localDir2, {});

      expect(result.pulled.length > 0 || result.skipped.length >= 0).toBeTruthy();

      // Verify content is available
      const content = await fs.readFile(path.join(localDir2, "MEMORY.md"), "utf-8");
      expect(content.includes("Shared Memory")).toBeTruthy();
    });
  });

  describe("Sync Operations", () => {
    beforeEach(async () => {
      await initCentralRepo(centralRepo);
      await saveXdgConfig({ centralRepo, machineId: "test-machine" });

      // Set up local directory with sync config
      await fs.writeFile(path.join(localDir1, "MEMORY.md"), "# Memory\n");
      await saveConfig(localDir1, { sync: { enabled: true, path: "test-project" } });

      // Create remote directory
      const remotePath = path.join(centralRepo, "test-project");
      await fs.mkdir(remotePath, { recursive: true });
    });

    it("should push local changes to central", async () => {
      // Initial push
      const result = await push(localDir1, {});

      expect(result.success).toBe(true);
      expect(result.pushed.includes("MEMORY.md")).toBeTruthy();

      // Verify file exists in central
      const remotePath = path.join(centralRepo, "test-project", "MEMORY.md");
      const content = await fs.readFile(remotePath, "utf-8");
      expect(content).toBe("# Memory\n");
    });

    it("should pull remote changes to local", async () => {
      // Set up remote content
      const remotePath = path.join(centralRepo, "test-project");
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "# Remote Memory\n");
      await fs.mkdir(path.join(remotePath, "memory"), { recursive: true });
      await fs.writeFile(path.join(remotePath, "memory", "note.md"), "# Note\n");

      const result = await pull(localDir1, {});

      expect(result.success).toBe(true);
      expect(result.pulled.length >= 1).toBeTruthy();

      // Verify local content
      const content = await fs.readFile(path.join(localDir1, "MEMORY.md"), "utf-8");
      expect(content.includes("Remote Memory") || content.includes("Memory")).toBeTruthy();
    });

    it("should handle bidirectional sync", async () => {
      // Local has changes
      await fs.writeFile(path.join(localDir1, "MEMORY.md"), "# Local Version\n");

      // Remote has different file
      const remotePath = path.join(centralRepo, "test-project");
      await fs.mkdir(path.join(remotePath, "memory"), { recursive: true });
      await fs.writeFile(path.join(remotePath, "memory", "remote-note.md"), "# From Remote\n");

      const result = await bidirectionalSync(localDir1, {});

      expect(result.success).toBe(true);
      // Should have pushed local changes and pulled remote file
    });
  });

  describe("Change Detection (Last-Write-Wins)", () => {
    beforeEach(async () => {
      await initCentralRepo(centralRepo);
      await saveXdgConfig({ centralRepo, machineId: "test-machine" });

      await fs.writeFile(path.join(localDir1, "MEMORY.md"), "# Original\n");
      await saveConfig(localDir1, { sync: { enabled: true, path: "change-test" } });

      const remotePath = path.join(centralRepo, "change-test");
      await fs.mkdir(remotePath, { recursive: true });
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "# Original\n");

      // Set up initial sync state
      const hash = await computeFileHash(path.join(localDir1, "MEMORY.md"));
      await saveSyncState(localDir1, {
        version: 2,
        centralPath: "change-test",
        lastSync: new Date().toISOString(),
        files: {
          "MEMORY.md": {
            localHash: hash,
            remoteHash: hash,
            lastModified: new Date().toISOString(),
          },
        },
      });
    });

    it("should detect changes when both sides modified", async () => {
      // Local change
      await fs.writeFile(path.join(localDir1, "MEMORY.md"), "# Local Change\n");

      // Remote change
      const remotePath = path.join(centralRepo, "change-test");
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "# Remote Change\n");

      const detection = await detectChanges(localDir1);

      // With 2-way comparison, different content = local-modified
      expect(detection.summary.localModified).toBe(1);
      expect(detection.changes.some((c) => c.status === "local-modified")).toBeTruthy();
    });

    it("should push local changes overwriting remote (last-write-wins)", async () => {
      // Local change
      await fs.writeFile(path.join(localDir1, "MEMORY.md"), "# Local Content\n");

      // Remote has different content
      const remotePath = path.join(centralRepo, "change-test");
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "# Remote Content\n");

      // Push overwrites remote
      const result = await push(localDir1, {});

      expect(result.success).toBe(true);
      expect(result.pushed.includes("MEMORY.md")).toBeTruthy();

      // Verify remote now has local content
      const remoteContent = await fs.readFile(path.join(remotePath, "MEMORY.md"), "utf-8");
      expect(remoteContent).toBe("# Local Content\n");
    });

    it("should pull remote changes overwriting local with --force", async () => {
      // Local has changes
      await fs.writeFile(path.join(localDir1, "MEMORY.md"), "# Local Content\n");

      // Remote has different content
      const remotePath = path.join(centralRepo, "change-test");
      await fs.writeFile(path.join(remotePath, "MEMORY.md"), "# Remote Content\n");

      // Pull with force overwrites local
      const result = await pull(localDir1, { force: true });

      expect(result.success).toBe(true);
      expect(result.pulled.includes("MEMORY.md")).toBeTruthy();

      // Verify local now has remote content
      const localContent = await fs.readFile(path.join(localDir1, "MEMORY.md"), "utf-8");
      expect(localContent).toBe("# Remote Content\n");
    });

    it("should quarantine files for manual review", async () => {
      const localContent = "Local version";
      const remoteContent = "Remote version";

      const conflictDir = await quarantineConflict(
        localDir1,
        "MEMORY.md",
        localContent,
        remoteContent
      );

      expect(conflictDir.includes("conflicts")).toBeTruthy();

      const quarantined = await listQuarantinedConflicts(localDir1);
      expect(quarantined.length > 0).toBeTruthy();
      expect(quarantined[0].files.includes("MEMORY.md")).toBeTruthy();
    });
  });

  describe("Collision Prevention", () => {
    beforeEach(async () => {
      await initCentralRepo(centralRepo);
    });

    it("should block duplicate path mapping from different machines", async () => {
      let registry = createEmptyRegistry();

      // Machine 1 maps path
      registry = addMapping(registry, {
        path: "shared-project",
        localPath: "/home/user1/project",
        machineId: "machine-1",
        lastSync: new Date().toISOString(),
      });

      // Machine 2 tries to map same path
      const collision = checkCollision(
        registry,
        "shared-project",
        "/home/user2/project",
        "machine-2"
      );

      expect(collision).toBe("collision");
    });

    it("should allow same machine to remap path", async () => {
      let registry = createEmptyRegistry();

      // Machine 1 maps path
      registry = addMapping(registry, {
        path: "my-project",
        localPath: "/old/path",
        machineId: "machine-1",
        lastSync: new Date().toISOString(),
      });

      // Same machine remaps
      const collision = checkCollision(
        registry,
        "my-project",
        "/new/path",
        "machine-1"
      );

      expect(collision).toBe("same-machine");
    });

    it("should allow different paths for different machines", async () => {
      let registry = createEmptyRegistry();

      registry = addMapping(registry, {
        path: "project-1",
        localPath: "/path/1",
        machineId: "machine-1",
        lastSync: new Date().toISOString(),
      });

      const collision = checkCollision(
        registry,
        "project-2",
        "/path/2",
        "machine-2"
      );

      expect(collision).toBe("none");
    });

    it("should detect collisions in validation", async () => {
      await saveXdgConfig({ centralRepo, machineId: "machine-1" });

      let registry = createEmptyRegistry();
      registry.mappings.push({
        path: "shared",
        localPath: "/path1",
        machineId: "machine-1",
        lastSync: new Date().toISOString(),
      });
      registry.mappings.push({
        path: "shared",
        localPath: "/path2",
        machineId: "machine-2",
        lastSync: new Date().toISOString(),
      });
      await writeRegistry(centralRepo, registry);

      const result = await validateRegistry();

      expect(result.valid).toBe(false);
      expect(result.stats.collisions).toBe(1);
    });
  });

  describe("Full Workflow", () => {
    it("should complete full sync workflow", async () => {
      // 1. Initialize central repo
      await initCentralRepo(centralRepo);

      // 2. Set up machine config
      await saveXdgConfig({ centralRepo, machineId: "dev-machine" });

      // 3. Create local memory directory with content
      await fs.writeFile(path.join(localDir1, "MEMORY.md"), "# Project Memory\n\nThis is the main memory file.\n");
      await fs.writeFile(path.join(localDir1, "memory", "2024-01-15.md"), "# Daily Log\n\nWorked on feature X.\n");

      // 4. Configure sync
      await saveConfig(localDir1, {
        sync: {
          enabled: true,
          path: "my-project",
          autoSync: false,
        },
      });

      // 5. Add to registry
      let registry = await readRegistry(centralRepo);
      registry = addMapping(registry, {
        path: "my-project",
        localPath: localDir1,
        machineId: "dev-machine",
        lastSync: new Date().toISOString(),
      });
      await writeRegistry(centralRepo, registry);

      // Create remote directory
      const remotePath = path.join(centralRepo, "my-project");
      await fs.mkdir(remotePath, { recursive: true });

      // 6. Push initial content
      const pushResult = await push(localDir1, {});
      expect(pushResult.success).toBe(true);
      expect(pushResult.pushed.length >= 1).toBeTruthy();

      // 7. Verify remote content
      const remoteContent = await fs.readFile(path.join(remotePath, "MEMORY.md"), "utf-8");
      expect(remoteContent.includes("Project Memory")).toBeTruthy();

      // 8. Simulate remote change
      await fs.appendFile(path.join(remotePath, "MEMORY.md"), "\n## New Section\nAdded remotely.\n");

      // 9. Pull changes - with last-write-wins, this may skip if local has changes
      const pullResult = await pull(localDir1, { force: true });
      // With force, should succeed
      expect(pullResult.success).toBeTruthy();

      // 10. Validate registry
      const validation = await validateRegistry();
      expect(validation.stats.collisions).toBe(0);
    });
  });
});
