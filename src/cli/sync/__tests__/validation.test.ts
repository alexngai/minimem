/**
 * Tests for registry validation
 */

import { describe, it, beforeEach, afterEach, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { validateRegistry, formatValidationResult } from "../validation.js";
import { initCentralRepo } from "../central.js";
import { writeRegistry, createEmptyRegistry, addMapping, type Registry } from "../registry.js";

describe("Registry Validation", () => {
  let tempDir: string;
  let centralRepo: string;
  let localDir: string;
  let xdgDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-validation-test-"));
    centralRepo = path.join(tempDir, "central");
    localDir = path.join(tempDir, "local");
    xdgDir = path.join(tempDir, "xdg-config");

    await fs.mkdir(localDir, { recursive: true });
    await fs.mkdir(path.join(localDir, ".minimem"), { recursive: true });
    await fs.mkdir(xdgDir, { recursive: true });

    // Initialize central repo
    await initCentralRepo(centralRepo);

    // Set up XDG config
    process.env.XDG_CONFIG_HOME = xdgDir;
    await fs.mkdir(path.join(xdgDir, "minimem"), { recursive: true });
    await fs.writeFile(
      path.join(xdgDir, "minimem", "config.json"),
      JSON.stringify({ centralRepo, machineId: "test-machine-1234" }, null, 2)
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

  describe("validateRegistry", () => {
    it("should return valid for empty registry", async () => {
      const result = await validateRegistry();

      expect(result.valid).toBe(true);
      expect(result.stats.totalMappings).toBe(0);
      expect(result.issues.length).toBe(0);
    });

    it("should return valid for registry with active mappings", async () => {
      const registry = createEmptyRegistry();
      const updated = addMapping(registry, {
        path: "test-project",
        localPath: localDir,
        machineId: "test-machine-1234",
        lastSync: new Date().toISOString(),
      });
      await writeRegistry(centralRepo, updated);

      const result = await validateRegistry();

      expect(result.valid).toBe(true);
      expect(result.stats.totalMappings).toBe(1);
      expect(result.stats.activeMappings).toBe(1);
    });

    it("should detect path collisions", async () => {
      const registry = createEmptyRegistry();
      // Same path, different machines
      registry.mappings.push({
        path: "shared-project",
        localPath: "/path/on/machine1",
        machineId: "machine-1",
        lastSync: new Date().toISOString(),
      });
      registry.mappings.push({
        path: "shared-project",
        localPath: "/path/on/machine2",
        machineId: "machine-2",
        lastSync: new Date().toISOString(),
      });
      await writeRegistry(centralRepo, registry);

      const result = await validateRegistry();

      expect(result.valid).toBe(false);
      expect(result.stats.collisions).toBe(1);
      expect(result.issues.some((i) => i.type === "collision")).toBeTruthy();
    });

    it("should detect stale mappings", async () => {
      const registry = createEmptyRegistry();
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 60); // 60 days ago

      registry.mappings.push({
        path: "old-project",
        localPath: "/path/to/old",
        machineId: "old-machine",
        lastSync: oldDate.toISOString(),
      });
      await writeRegistry(centralRepo, registry);

      const result = await validateRegistry();

      expect(result.stats.staleMappings).toBe(1);
      expect(result.issues.some((i) => i.type === "stale")).toBeTruthy();
    });

    it("should detect missing local directories", async () => {
      // Read the machineId that was set in XDG config
      const { loadXdgConfig } = await import("../../config.js");
      const xdgConfig = await loadXdgConfig();
      const currentMachineId = xdgConfig.machineId;

      const registry = createEmptyRegistry();
      registry.mappings.push({
        path: "missing-project",
        localPath: path.join(tempDir, "nonexistent"),
        machineId: currentMachineId!, // Current machine
        lastSync: new Date().toISOString(),
      });
      await writeRegistry(centralRepo, registry);

      const result = await validateRegistry();

      expect(result.stats.missingDirs).toBe(1);
      expect(result.issues.some((i) => i.type === "missing")).toBeTruthy();
    });

    it("should not check local dirs for other machines", async () => {
      const registry = createEmptyRegistry();
      registry.mappings.push({
        path: "other-project",
        localPath: "/nonexistent/path",
        machineId: "other-machine", // Different machine
        lastSync: new Date().toISOString(),
      });
      await writeRegistry(centralRepo, registry);

      const result = await validateRegistry();

      // Should not report missing dir since it's on a different machine
      expect(result.stats.missingDirs).toBe(0);
    });
  });

  describe("formatValidationResult", () => {
    it("should format valid result", async () => {
      const result = await validateRegistry();
      const formatted = formatValidationResult(result);

      expect(formatted.includes("Registry Validation Results")).toBeTruthy();
      expect(formatted.includes("No issues found")).toBeTruthy();
      expect(formatted.includes("valid")).toBeTruthy();
    });

    it("should format result with issues", async () => {
      // Create a collision
      const registry = createEmptyRegistry();
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
      const formatted = formatValidationResult(result);

      expect(formatted.includes("Issues:")).toBeTruthy();
      expect(formatted.includes("ERROR")).toBeTruthy();
      expect(formatted.includes("collision") || formatted.includes("multiple machines")).toBeTruthy();
    });
  });
});
