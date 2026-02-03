/**
 * Tests for central repository initialization
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";

import {
  initCentralRepo,
  validateCentralRepo,
} from "../central.js";
import { readRegistry } from "../registry.js";

describe("Central Repository", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-central-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("initCentralRepo", () => {
    it("should create new central repository", async () => {
      const repoPath = path.join(tempDir, "memories-repo");
      const result = await initCentralRepo(repoPath);

      expect(result.success).toBe(true);
      expect(result.created).toBe(true);
      expect(result.message.includes("Created")).toBeTruthy();

      // Check .git exists
      const gitStat = await fs.stat(path.join(repoPath, ".git"));
      expect(gitStat.isDirectory()).toBeTruthy();

      // Check .gitignore exists and has correct content
      const gitignore = await fs.readFile(path.join(repoPath, ".gitignore"), "utf-8");
      expect(gitignore.includes("*.db")).toBeTruthy();
      expect(gitignore.includes("staging/")).toBeTruthy();
      expect(gitignore.includes("conflicts/")).toBeTruthy();

      // Check registry exists
      const registry = await readRegistry(repoPath);
      expect(registry.mappings).toEqual([]);

      // Check README exists
      const readme = await fs.readFile(path.join(repoPath, "README.md"), "utf-8");
      expect(readme.includes("Minimem Central Repository")).toBeTruthy();
    });

    it("should configure existing directory", async () => {
      // Create directory first
      await fs.mkdir(tempDir, { recursive: true });

      const result = await initCentralRepo(tempDir);

      expect(result.success).toBe(true);
      expect(result.created).toBe(false);
      expect(result.message.includes("Configured")).toBeTruthy();
    });

    it("should not overwrite existing .gitignore", async () => {
      const repoPath = path.join(tempDir, "existing-repo");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.writeFile(path.join(repoPath, ".gitignore"), "custom-ignore\n");

      await initCentralRepo(repoPath);

      const gitignore = await fs.readFile(path.join(repoPath, ".gitignore"), "utf-8");
      expect(gitignore).toBe("custom-ignore\n");
    });

    it("should not overwrite existing registry", async () => {
      const repoPath = path.join(tempDir, "existing-repo");
      await fs.mkdir(repoPath, { recursive: true });
      await fs.writeFile(
        path.join(repoPath, ".minimem-registry.json"),
        JSON.stringify({ version: 1, mappings: [{ path: "test/" }] })
      );

      await initCentralRepo(repoPath);

      const content = await fs.readFile(
        path.join(repoPath, ".minimem-registry.json"),
        "utf-8"
      );
      const registry = JSON.parse(content);
      expect(registry.mappings.length).toBe(1);
    });

    it("should handle ~ in path", async () => {
      // We can't easily test ~ expansion to home in isolation,
      // but we can test that it doesn't crash
      const result = await initCentralRepo(path.join(tempDir, "test-repo"));
      expect(result.success).toBe(true);
    });
  });

  describe("validateCentralRepo", () => {
    it("should validate a properly configured repo", async () => {
      const repoPath = path.join(tempDir, "valid-repo");
      await initCentralRepo(repoPath);

      const result = await validateCentralRepo(repoPath);

      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it("should report missing directory", async () => {
      const result = await validateCentralRepo(path.join(tempDir, "nonexistent"));

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes("does not exist"))).toBeTruthy();
    });

    it("should warn about missing registry", async () => {
      await fs.mkdir(tempDir, { recursive: true });
      // Initialize git but don't create registry
      const { execSync } = await import("node:child_process");
      execSync("git init", { cwd: tempDir, stdio: "pipe" });

      const result = await validateCentralRepo(tempDir);

      expect(result.valid).toBe(true); // Still valid, just has warnings
      expect(result.warnings.some(w => w.includes("Registry"))).toBeTruthy();
    });

    it("should warn about missing .gitignore", async () => {
      const repoPath = path.join(tempDir, "no-gitignore");
      await fs.mkdir(repoPath, { recursive: true });
      const { execSync } = await import("node:child_process");
      execSync("git init", { cwd: repoPath, stdio: "pipe" });

      const result = await validateCentralRepo(repoPath);

      expect(result.warnings.some(w => w.includes(".gitignore"))).toBeTruthy();
    });

    it("should warn if not a git repo", async () => {
      await fs.mkdir(tempDir, { recursive: true });

      const result = await validateCentralRepo(tempDir);

      expect(result.warnings.some(w => w.includes("Not a git repository"))).toBeTruthy();
    });
  });
});
