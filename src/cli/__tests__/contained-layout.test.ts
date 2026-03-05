/**
 * Tests for contained layout support
 *
 * Verifies that minimem correctly handles the contained layout where
 * MEMORY.md, memory/, config.json, index.db, and .gitignore all live
 * in the same directory (.minimem/ or .swarm/minimem/).
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import { resolveConfigSubdir, isInitialized } from "../config.js";
import { discoverMemoryDir, resolveMemoryDir } from "../shared.js";
import { init } from "../commands/init.js";
import { getSyncStatePath } from "../sync/state.js";
import { getConflictsDir } from "../sync/conflicts.js";
import { getSyncLogPath } from "../commands/conflicts.js";

describe("contained layout", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-contained-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // ── discoverMemoryDir ───────────────────────────────────────────────────

  describe("discoverMemoryDir", () => {
    it("returns base when MEMORY.md exists at root (classic layout)", async () => {
      await fs.writeFile(path.join(tempDir, "MEMORY.md"), "# Memory\n");
      expect(discoverMemoryDir(tempDir)).toBe(tempDir);
    });

    it("returns .swarm/minimem/ when it has config.json", async () => {
      const swarmDir = path.join(tempDir, ".swarm", "minimem");
      await fs.mkdir(swarmDir, { recursive: true });
      await fs.writeFile(path.join(swarmDir, "config.json"), "{}");

      expect(discoverMemoryDir(tempDir)).toBe(swarmDir);
    });

    it("returns .minimem/ when it has config.json", async () => {
      const minimemDir = path.join(tempDir, ".minimem");
      await fs.mkdir(minimemDir, { recursive: true });
      await fs.writeFile(path.join(minimemDir, "config.json"), "{}");

      expect(discoverMemoryDir(tempDir)).toBe(minimemDir);
    });

    it("prefers classic layout over contained when MEMORY.md exists at root", async () => {
      // Both exist: classic wins
      await fs.writeFile(path.join(tempDir, "MEMORY.md"), "# Memory\n");
      const swarmDir = path.join(tempDir, ".swarm", "minimem");
      await fs.mkdir(swarmDir, { recursive: true });
      await fs.writeFile(path.join(swarmDir, "config.json"), "{}");

      expect(discoverMemoryDir(tempDir)).toBe(tempDir);
    });

    it("prefers .swarm/minimem/ over .minimem/", async () => {
      const swarmDir = path.join(tempDir, ".swarm", "minimem");
      await fs.mkdir(swarmDir, { recursive: true });
      await fs.writeFile(path.join(swarmDir, "config.json"), "{}");

      const minimemDir = path.join(tempDir, ".minimem");
      await fs.mkdir(minimemDir, { recursive: true });
      await fs.writeFile(path.join(minimemDir, "config.json"), "{}");

      expect(discoverMemoryDir(tempDir)).toBe(swarmDir);
    });

    it("returns base when no memory structure exists (fallback)", () => {
      expect(discoverMemoryDir(tempDir)).toBe(tempDir);
    });

    it("ignores .swarm/minimem/ without config.json", async () => {
      const swarmDir = path.join(tempDir, ".swarm", "minimem");
      await fs.mkdir(swarmDir, { recursive: true });
      // No config.json → should not discover

      expect(discoverMemoryDir(tempDir)).toBe(tempDir);
    });
  });

  // ── resolveConfigSubdir ─────────────────────────────────────────────────

  describe("resolveConfigSubdir", () => {
    it("returns '.' when config.json exists at root (contained)", async () => {
      await fs.writeFile(path.join(tempDir, "config.json"), "{}");

      expect(resolveConfigSubdir(tempDir)).toBe(".");
    });

    it("returns '.swarm/minimem' when config.json exists there", async () => {
      const swarmDir = path.join(tempDir, ".swarm", "minimem");
      await fs.mkdir(swarmDir, { recursive: true });
      await fs.writeFile(path.join(swarmDir, "config.json"), "{}");

      expect(resolveConfigSubdir(tempDir)).toBe(path.join(".swarm", "minimem"));
    });

    it("returns '.minimem' as default fallback", () => {
      expect(resolveConfigSubdir(tempDir)).toBe(".minimem");
    });

    it("prefers contained over .swarm/minimem", async () => {
      // config.json at root AND in .swarm/minimem → contained wins
      await fs.writeFile(path.join(tempDir, "config.json"), "{}");
      const swarmDir = path.join(tempDir, ".swarm", "minimem");
      await fs.mkdir(swarmDir, { recursive: true });
      await fs.writeFile(path.join(swarmDir, "config.json"), "{}");

      expect(resolveConfigSubdir(tempDir)).toBe(".");
    });

    it("respects MINIMEM_CONFIG_DIR env var", async () => {
      const original = process.env.MINIMEM_CONFIG_DIR;
      try {
        process.env.MINIMEM_CONFIG_DIR = "custom/path";
        expect(resolveConfigSubdir(tempDir)).toBe("custom/path");
      } finally {
        if (original === undefined) {
          delete process.env.MINIMEM_CONFIG_DIR;
        } else {
          process.env.MINIMEM_CONFIG_DIR = original;
        }
      }
    });

    it("ignores .swarm/minimem dir without config.json", async () => {
      const swarmDir = path.join(tempDir, ".swarm", "minimem");
      await fs.mkdir(swarmDir, { recursive: true });
      // No config.json

      expect(resolveConfigSubdir(tempDir)).toBe(".minimem");
    });
  });

  // ── init command ────────────────────────────────────────────────────────

  describe("init creates contained layout", () => {
    it("creates config.json at target root (not nested)", async () => {
      await init(tempDir, { force: false });

      expect(fsSync.existsSync(path.join(tempDir, "config.json"))).toBe(true);
      expect(fsSync.existsSync(path.join(tempDir, "MEMORY.md"))).toBe(true);
      expect(fsSync.existsSync(path.join(tempDir, "memory"))).toBe(true);
      expect(fsSync.existsSync(path.join(tempDir, ".gitignore"))).toBe(true);
    });

    it("does not create a nested .minimem/ subdirectory", async () => {
      await init(tempDir, { force: false });

      expect(fsSync.existsSync(path.join(tempDir, ".minimem"))).toBe(false);
    });

    it("is detected as initialized by isInitialized", async () => {
      await init(tempDir, { force: false });

      expect(await isInitialized(tempDir)).toBe(true);
    });

    it("config has correct default values", async () => {
      await init(tempDir, { force: false });

      const config = JSON.parse(
        fsSync.readFileSync(path.join(tempDir, "config.json"), "utf-8"),
      );
      expect(config.embedding.provider).toBe("auto");
      expect(config.hybrid.enabled).toBe(true);
    });
  });

  // ── sync paths with contained layout ────────────────────────────────────

  describe("sync paths resolve correctly for contained layout", () => {
    beforeEach(async () => {
      // Set up contained layout: config.json at root
      await fs.writeFile(
        path.join(tempDir, "config.json"),
        JSON.stringify({ embedding: { provider: "auto" } }),
      );
    });

    it("getSyncStatePath resolves to root (not .minimem/)", () => {
      const statePath = getSyncStatePath(tempDir);
      expect(statePath).toBe(path.join(tempDir, "sync-state.json"));
    });

    it("getConflictsDir resolves to root/conflicts (not .minimem/conflicts)", () => {
      const conflictsDir = getConflictsDir(tempDir);
      expect(conflictsDir).toBe(path.join(tempDir, "conflicts"));
    });

    it("getSyncLogPath resolves to root (not .minimem/)", () => {
      const logPath = getSyncLogPath(tempDir);
      expect(logPath).toBe(path.join(tempDir, "sync.log"));
    });
  });

  describe("sync paths resolve correctly for default layout", () => {
    beforeEach(async () => {
      // Default layout: .minimem/ subdir exists, no config.json at root
      await fs.mkdir(path.join(tempDir, ".minimem"), { recursive: true });
    });

    it("getSyncStatePath resolves to .minimem/", () => {
      const statePath = getSyncStatePath(tempDir);
      expect(statePath).toBe(path.join(tempDir, ".minimem", "sync-state.json"));
    });

    it("getConflictsDir resolves to .minimem/conflicts", () => {
      const conflictsDir = getConflictsDir(tempDir);
      expect(conflictsDir).toBe(path.join(tempDir, ".minimem", "conflicts"));
    });

    it("getSyncLogPath resolves to .minimem/", () => {
      const logPath = getSyncLogPath(tempDir);
      expect(logPath).toBe(path.join(tempDir, ".minimem", "sync.log"));
    });
  });

  describe("sync paths resolve correctly for .swarm/minimem layout", () => {
    beforeEach(async () => {
      const swarmDir = path.join(tempDir, ".swarm", "minimem");
      await fs.mkdir(swarmDir, { recursive: true });
      await fs.writeFile(path.join(swarmDir, "config.json"), "{}");
    });

    it("getSyncStatePath resolves to .swarm/minimem/", () => {
      const statePath = getSyncStatePath(tempDir);
      expect(statePath).toBe(
        path.join(tempDir, ".swarm", "minimem", "sync-state.json"),
      );
    });

    it("getConflictsDir resolves to .swarm/minimem/conflicts", () => {
      const conflictsDir = getConflictsDir(tempDir);
      expect(conflictsDir).toBe(
        path.join(tempDir, ".swarm", "minimem", "conflicts"),
      );
    });
  });

  // ── end-to-end: init + discovery ────────────────────────────────────────

  describe("end-to-end: init then discover", () => {
    it("init creates structure that discoverMemoryDir finds", async () => {
      const projectDir = path.join(tempDir, "myproject");
      const minimemDir = path.join(projectDir, ".minimem");
      await fs.mkdir(projectDir, { recursive: true });

      // Init inside .minimem/ (like swarmkit would)
      await init(minimemDir, { force: false });

      // Discovery from project root should find it
      expect(discoverMemoryDir(projectDir)).toBe(minimemDir);
    });

    it("init creates structure that discoverMemoryDir finds under .swarm/", async () => {
      const projectDir = path.join(tempDir, "myproject");
      const swarmDir = path.join(projectDir, ".swarm", "minimem");
      await fs.mkdir(projectDir, { recursive: true });

      // Init inside .swarm/minimem/ (like swarmkit with prefix)
      await init(swarmDir, { force: false });

      // Discovery from project root should find it
      expect(discoverMemoryDir(projectDir)).toBe(swarmDir);
    });

    it("init creates structure detected by resolveConfigSubdir as contained", async () => {
      await init(tempDir, { force: false });

      // resolveConfigSubdir should return "." (contained)
      expect(resolveConfigSubdir(tempDir)).toBe(".");
    });
  });
});
