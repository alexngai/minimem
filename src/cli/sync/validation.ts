/**
 * Registry validation
 *
 * Validates registry for path collisions, stale mappings, and missing directories.
 */

import fs from "node:fs/promises";
import path from "node:path";

import { readRegistry, type Registry, type RegistryMapping } from "./registry.js";
import { getCentralRepoPath } from "./central.js";
import { loadXdgConfig } from "../config.js";

export type ValidationIssue = {
  type: "collision" | "stale" | "missing" | "orphan";
  severity: "warning" | "error";
  message: string;
  path?: string;
  machineId?: string;
  details?: Record<string, unknown>;
};

export type ValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
  stats: {
    totalMappings: number;
    activeMappings: number;
    staleMappings: number;
    collisions: number;
    missingDirs: number;
  };
};

const STALE_THRESHOLD_DAYS = 30;

/**
 * Validate the registry
 */
export async function validateRegistry(): Promise<ValidationResult> {
  const result: ValidationResult = {
    valid: true,
    issues: [],
    stats: {
      totalMappings: 0,
      activeMappings: 0,
      staleMappings: 0,
      collisions: 0,
      missingDirs: 0,
    },
  };

  const centralRepo = await getCentralRepoPath();
  if (!centralRepo) {
    result.issues.push({
      type: "missing",
      severity: "warning",
      message: "No central repository configured",
    });
    return result;
  }

  let registry: Registry;
  try {
    registry = await readRegistry(centralRepo);
  } catch (error) {
    result.issues.push({
      type: "missing",
      severity: "error",
      message: `Failed to read registry: ${error}`,
    });
    result.valid = false;
    return result;
  }

  const xdgConfig = await loadXdgConfig();
  const currentMachineId = xdgConfig.machineId;
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - STALE_THRESHOLD_DAYS * 24 * 60 * 60 * 1000);

  result.stats.totalMappings = registry.mappings.length;

  // Group mappings by central path to detect collisions
  const pathToMappings = new Map<string, RegistryMapping[]>();

  for (const mapping of registry.mappings) {
    const existing = pathToMappings.get(mapping.path) || [];
    existing.push(mapping);
    pathToMappings.set(mapping.path, existing);
  }

  // Check for collisions
  for (const [centralPath, mappings] of pathToMappings) {
    if (mappings.length > 1) {
      // Multiple machines mapping to same path
      const machineIds = mappings.map((m) => m.machineId);
      const uniqueMachines = new Set(machineIds);

      if (uniqueMachines.size > 1) {
        result.issues.push({
          type: "collision",
          severity: "error",
          message: `Path '${centralPath}' is mapped by multiple machines: ${Array.from(uniqueMachines).join(", ")}`,
          path: centralPath,
          details: { machines: Array.from(uniqueMachines) },
        });
        result.stats.collisions++;
        result.valid = false;
      }
    }
  }

  // Check each mapping
  for (const mapping of registry.mappings) {
    // Check for stale mappings
    const lastSyncDate = new Date(mapping.lastSync);
    if (lastSyncDate < staleThreshold) {
      const daysSinceSync = Math.floor(
        (now.getTime() - lastSyncDate.getTime()) / (24 * 60 * 60 * 1000)
      );

      result.issues.push({
        type: "stale",
        severity: "warning",
        message: `Mapping '${mapping.path}' by '${mapping.machineId}' is stale (last sync: ${daysSinceSync} days ago)`,
        path: mapping.path,
        machineId: mapping.machineId,
        details: { lastSync: mapping.lastSync, daysSinceSync },
      });
      result.stats.staleMappings++;
    } else {
      result.stats.activeMappings++;
    }

    // Check if local directory exists (only for current machine)
    if (mapping.machineId === currentMachineId) {
      const localPath = expandPath(mapping.localPath);
      try {
        await fs.access(localPath);
      } catch {
        result.issues.push({
          type: "missing",
          severity: "warning",
          message: `Local directory no longer exists: ${mapping.localPath}`,
          path: mapping.path,
          machineId: mapping.machineId,
          details: { localPath: mapping.localPath },
        });
        result.stats.missingDirs++;
      }
    }
  }

  return result;
}

/**
 * Expand path (handle ~ for home directory)
 */
function expandPath(p: string): string {
  if (p.startsWith("~/")) {
    return path.join(process.env.HOME || "", p.slice(2));
  }
  return p;
}

/**
 * Format validation result for display
 */
export function formatValidationResult(result: ValidationResult): string {
  const lines: string[] = [];

  lines.push("Registry Validation Results");
  lines.push("-".repeat(40));

  lines.push(`Total mappings: ${result.stats.totalMappings}`);
  lines.push(`Active mappings: ${result.stats.activeMappings}`);

  if (result.stats.staleMappings > 0) {
    lines.push(`Stale mappings: ${result.stats.staleMappings}`);
  }
  if (result.stats.collisions > 0) {
    lines.push(`Collisions: ${result.stats.collisions}`);
  }
  if (result.stats.missingDirs > 0) {
    lines.push(`Missing directories: ${result.stats.missingDirs}`);
  }

  if (result.issues.length > 0) {
    lines.push("");
    lines.push("Issues:");

    for (const issue of result.issues) {
      const prefix = issue.severity === "error" ? "ERROR" : "WARN";
      lines.push(`  [${prefix}] ${issue.message}`);
    }
  } else {
    lines.push("");
    lines.push("No issues found.");
  }

  lines.push("");
  lines.push(result.valid ? "Registry is valid." : "Registry has errors that need attention.");

  return lines.join("\n");
}
