/**
 * Tests for registry system
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createEmptyRegistry,
  readRegistry,
  writeRegistry,
  checkCollision,
  addMapping,
  removeMapping,
  findMapping,
  getMachineMappings,
  updateLastSync,
  normalizeRepoPath,
  compressPath,
  normalizePath,
  type Registry,
} from "../registry.js";

describe("Registry System", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-registry-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("createEmptyRegistry", () => {
    it("should create registry with empty mappings", () => {
      const registry = createEmptyRegistry();
      expect(registry.version).toBe(1);
      expect(registry.mappings).toEqual([]);
    });
  });

  describe("readRegistry / writeRegistry", () => {
    it("should return empty registry when file does not exist", async () => {
      const registry = await readRegistry(tempDir);
      expect(registry.mappings).toEqual([]);
    });

    it("should read and write registry correctly", async () => {
      const registry: Registry = {
        version: 1,
        mappings: [
          {
            path: "global/",
            localPath: "~/.minimem",
            machineId: "test-machine-1234",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
        ],
      };

      await writeRegistry(tempDir, registry);
      const loaded = await readRegistry(tempDir);

      expect(loaded.version).toBe(1);
      expect(loaded.mappings.length).toBe(1);
      expect(loaded.mappings[0].path).toBe("global/");
      expect(loaded.mappings[0].machineId).toBe("test-machine-1234");
    });

    it("should handle malformed registry file", async () => {
      await fs.writeFile(
        path.join(tempDir, ".minimem-registry.json"),
        "{ invalid json"
      );

      const registry = await readRegistry(tempDir);
      expect(registry.mappings).toEqual([]);
    });
  });

  describe("normalizeRepoPath", () => {
    it("should add trailing slash", () => {
      expect(normalizeRepoPath("global")).toBe("global/");
    });

    it("should preserve existing trailing slash", () => {
      expect(normalizeRepoPath("global/")).toBe("global/");
    });

    it("should remove multiple trailing slashes", () => {
      expect(normalizeRepoPath("global///")).toBe("global/");
    });

    it("should handle root path", () => {
      expect(normalizeRepoPath("/")).toBe("/");
    });
  });

  describe("compressPath / normalizePath", () => {
    it("should compress home directory to ~", () => {
      const homePath = path.join(os.homedir(), "test", "path");
      const compressed = compressPath(homePath);
      expect(compressed).toBe("~/test/path");
    });

    it("should expand ~ to home directory", () => {
      const expanded = normalizePath("~/test/path");
      expect(expanded).toBe(path.join(os.homedir(), "test", "path"));
    });

    it("should handle paths without home", () => {
      const absPath = "/tmp/test/path";
      expect(compressPath(absPath)).toBe(absPath);
      expect(normalizePath(absPath)).toBe(absPath);
    });
  });

  describe("checkCollision", () => {
    it("should return 'none' for new path", () => {
      const registry = createEmptyRegistry();
      const result = checkCollision(registry, "newpath/", "/tmp/test", "machine-1");
      expect(result).toBe("none");
    });

    it("should return 'same-machine' for existing path on same machine", () => {
      const registry: Registry = {
        version: 1,
        mappings: [
          {
            path: "global/",
            localPath: "~/.minimem",
            machineId: "machine-1",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
        ],
      };

      const result = checkCollision(registry, "global/", "/other/path", "machine-1");
      expect(result).toBe("same-machine");
    });

    it("should return 'collision' for existing path on different machine", () => {
      const registry: Registry = {
        version: 1,
        mappings: [
          {
            path: "global/",
            localPath: "~/.minimem",
            machineId: "machine-1",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
        ],
      };

      const result = checkCollision(registry, "global/", "/other/path", "machine-2");
      expect(result).toBe("collision");
    });

    it("should handle path normalization in collision check", () => {
      const registry: Registry = {
        version: 1,
        mappings: [
          {
            path: "global/",
            localPath: "~/.minimem",
            machineId: "machine-1",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
        ],
      };

      // Without trailing slash should still match
      const result = checkCollision(registry, "global", "/other/path", "machine-2");
      expect(result).toBe("collision");
    });
  });

  describe("addMapping", () => {
    it("should add new mapping", () => {
      const registry = createEmptyRegistry();
      const updated = addMapping(registry, {
        path: "global/",
        localPath: "~/.minimem",
        machineId: "machine-1",
        lastSync: "2024-01-15T10:30:00.000Z",
      });

      expect(updated.mappings.length).toBe(1);
      expect(updated.mappings[0].path).toBe("global/");
    });

    it("should update existing mapping for same machine", () => {
      const registry: Registry = {
        version: 1,
        mappings: [
          {
            path: "global/",
            localPath: "~/.minimem",
            machineId: "machine-1",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
        ],
      };

      // Use absolute path that will be compressed to ~/new-path
      const newPath = path.join(os.homedir(), "new-path");
      const updated = addMapping(registry, {
        path: "global/",
        localPath: newPath,
        machineId: "machine-1",
        lastSync: "2024-01-16T10:30:00.000Z",
      });

      expect(updated.mappings.length).toBe(1);
      expect(updated.mappings[0].localPath).toBe("~/new-path");
    });

    it("should compress local paths", () => {
      const registry = createEmptyRegistry();
      const homePath = path.join(os.homedir(), "test");
      const updated = addMapping(registry, {
        path: "test/",
        localPath: homePath,
        machineId: "machine-1",
        lastSync: "2024-01-15T10:30:00.000Z",
      });

      expect(updated.mappings[0].localPath).toBe("~/test");
    });
  });

  describe("removeMapping", () => {
    it("should remove existing mapping", () => {
      const registry: Registry = {
        version: 1,
        mappings: [
          {
            path: "global/",
            localPath: "~/.minimem",
            machineId: "machine-1",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
          {
            path: "work/",
            localPath: "~/work",
            machineId: "machine-1",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
        ],
      };

      const updated = removeMapping(registry, "global/", "machine-1");
      expect(updated.mappings.length).toBe(1);
      expect(updated.mappings[0].path).toBe("work/");
    });

    it("should not affect other machines' mappings", () => {
      const registry: Registry = {
        version: 1,
        mappings: [
          {
            path: "global/",
            localPath: "~/.minimem",
            machineId: "machine-1",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
          {
            path: "global/",
            localPath: "~/.minimem",
            machineId: "machine-2",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
        ],
      };

      const updated = removeMapping(registry, "global/", "machine-1");
      expect(updated.mappings.length).toBe(1);
      expect(updated.mappings[0].machineId).toBe("machine-2");
    });
  });

  describe("findMapping", () => {
    it("should find existing mapping", () => {
      const registry: Registry = {
        version: 1,
        mappings: [
          {
            path: "global/",
            localPath: "~/.minimem",
            machineId: "machine-1",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
        ],
      };

      const found = findMapping(registry, "global/", "machine-1");
      expect(found).toBeTruthy();
      expect(found!.localPath).toBe("~/.minimem");
    });

    it("should return undefined for non-existent mapping", () => {
      const registry = createEmptyRegistry();
      const found = findMapping(registry, "global/", "machine-1");
      expect(found).toBeUndefined();
    });
  });

  describe("getMachineMappings", () => {
    it("should return all mappings for a machine", () => {
      const registry: Registry = {
        version: 1,
        mappings: [
          {
            path: "global/",
            localPath: "~/.minimem",
            machineId: "machine-1",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
          {
            path: "work/",
            localPath: "~/work",
            machineId: "machine-1",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
          {
            path: "other/",
            localPath: "~/other",
            machineId: "machine-2",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
        ],
      };

      const mappings = getMachineMappings(registry, "machine-1");
      expect(mappings.length).toBe(2);
    });
  });

  describe("updateLastSync", () => {
    it("should update lastSync timestamp", () => {
      const registry: Registry = {
        version: 1,
        mappings: [
          {
            path: "global/",
            localPath: "~/.minimem",
            machineId: "machine-1",
            lastSync: "2024-01-15T10:30:00.000Z",
          },
        ],
      };

      const updated = updateLastSync(registry, "global/", "machine-1");
      expect(updated.mappings[0].lastSync).not.toBe("2024-01-15T10:30:00.000Z");
      // Should be a valid ISO date
      const date = new Date(updated.mappings[0].lastSync);
      expect(isNaN(date.getTime())).toBe(false);
    });
  });
});
