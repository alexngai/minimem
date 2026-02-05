/**
 * Tests for directory type detection
 *
 * Simplified to two types:
 * - project-bound: inside git repo (synced via project's git)
 * - standalone: uses minimem sync or not in git (default)
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  detectDirectoryType,
  isInsideGitRepo,
  getGitRoot,
  hasSyncConfig,
  getDirectoryInfo,
} from "../detection.js";

describe("Directory Type Detection", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-detection-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("isInsideGitRepo", () => {
    it("should return false for directory without .git", async () => {
      const result = await isInsideGitRepo(tempDir);
      expect(result).toBe(false);
    });

    it("should return true for directory with .git", async () => {
      await fs.mkdir(path.join(tempDir, ".git"));
      const result = await isInsideGitRepo(tempDir);
      expect(result).toBe(true);
    });

    it("should return true for subdirectory of git repo", async () => {
      await fs.mkdir(path.join(tempDir, ".git"));
      const subDir = path.join(tempDir, "sub", "deep");
      await fs.mkdir(subDir, { recursive: true });

      const result = await isInsideGitRepo(subDir);
      expect(result).toBe(true);
    });

    it("should handle .git as file (worktrees)", async () => {
      await fs.writeFile(path.join(tempDir, ".git"), "gitdir: /path/to/git");
      const result = await isInsideGitRepo(tempDir);
      expect(result).toBe(true);
    });
  });

  describe("getGitRoot", () => {
    it("should return undefined for non-git directory", async () => {
      const result = await getGitRoot(tempDir);
      expect(result).toBe(undefined);
    });

    it("should return git root for git directory", async () => {
      await fs.mkdir(path.join(tempDir, ".git"));
      const result = await getGitRoot(tempDir);
      expect(result).toBe(tempDir);
    });

    it("should return git root from subdirectory", async () => {
      await fs.mkdir(path.join(tempDir, ".git"));
      const subDir = path.join(tempDir, "sub", "deep");
      await fs.mkdir(subDir, { recursive: true });

      const result = await getGitRoot(subDir);
      expect(result).toBe(tempDir);
    });
  });

  describe("hasSyncConfig", () => {
    it("should return false when no config exists", async () => {
      const result = await hasSyncConfig(tempDir);
      expect(result).toBe(false);
    });

    it("should return false when config has no sync section", async () => {
      await fs.mkdir(path.join(tempDir, ".minimem"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".minimem", "config.json"),
        JSON.stringify({ embedding: { provider: "auto" } })
      );

      const result = await hasSyncConfig(tempDir);
      expect(result).toBe(false);
    });

    it("should return true when sync.enabled is true", async () => {
      await fs.mkdir(path.join(tempDir, ".minimem"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".minimem", "config.json"),
        JSON.stringify({ sync: { enabled: true } })
      );

      const result = await hasSyncConfig(tempDir);
      expect(result).toBe(true);
    });

    it("should return true when sync.path is set", async () => {
      await fs.mkdir(path.join(tempDir, ".minimem"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".minimem", "config.json"),
        JSON.stringify({ sync: { path: "myproject/" } })
      );

      const result = await hasSyncConfig(tempDir);
      expect(result).toBe(true);
    });

    it("should return false when sync.enabled is false and no path", async () => {
      await fs.mkdir(path.join(tempDir, ".minimem"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".minimem", "config.json"),
        JSON.stringify({ sync: { enabled: false } })
      );

      const result = await hasSyncConfig(tempDir);
      expect(result).toBe(false);
    });
  });

  describe("detectDirectoryType", () => {
    it("should detect standalone (no git, no sync)", async () => {
      const result = await detectDirectoryType(tempDir);
      expect(result).toBe("standalone");
    });

    it("should detect project-bound (git, no sync)", async () => {
      await fs.mkdir(path.join(tempDir, ".git"));

      const result = await detectDirectoryType(tempDir);
      expect(result).toBe("project-bound");
    });

    it("should detect standalone (no git, sync enabled)", async () => {
      await fs.mkdir(path.join(tempDir, ".minimem"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".minimem", "config.json"),
        JSON.stringify({ sync: { enabled: true, path: "test/" } })
      );

      const result = await detectDirectoryType(tempDir);
      expect(result).toBe("standalone");
    });

    it("should detect standalone when both git and sync enabled (sync takes precedence)", async () => {
      await fs.mkdir(path.join(tempDir, ".git"));
      await fs.mkdir(path.join(tempDir, ".minimem"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".minimem", "config.json"),
        JSON.stringify({ sync: { enabled: true, path: "test/" } })
      );

      const result = await detectDirectoryType(tempDir);
      // Sync config takes precedence - directory uses minimem sync
      expect(result).toBe("standalone");
    });
  });

  describe("getDirectoryInfo", () => {
    it("should return full info for directory with both git and sync", async () => {
      await fs.mkdir(path.join(tempDir, ".git"));
      await fs.mkdir(path.join(tempDir, ".minimem"), { recursive: true });
      await fs.writeFile(
        path.join(tempDir, ".minimem", "config.json"),
        JSON.stringify({ sync: { enabled: true, path: "test/" } })
      );

      const info = await getDirectoryInfo(tempDir);

      // Sync config takes precedence
      expect(info.type).toBe("standalone");
      expect(info.gitRoot).toBe(tempDir);
      expect(info.hasSyncConfig).toBe(true);
    });

    it("should return undefined gitRoot for non-git directory", async () => {
      const info = await getDirectoryInfo(tempDir);

      expect(info.type).toBe("standalone");
      expect(info.gitRoot).toBe(undefined);
      expect(info.hasSyncConfig).toBe(false);
    });

    it("should return project-bound for git-only directory", async () => {
      await fs.mkdir(path.join(tempDir, ".git"));

      const info = await getDirectoryInfo(tempDir);

      expect(info.type).toBe("project-bound");
      expect(info.gitRoot).toBe(tempDir);
      expect(info.hasSyncConfig).toBe(false);
    });
  });
});
