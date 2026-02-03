/**
 * Registry system for sync path collision prevention
 *
 * The registry is stored in the central repo as .minimem-registry.json
 * and tracks which local directories are mapped to which paths.
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const REGISTRY_FILENAME = ".minimem-registry.json";

export type RegistryMapping = {
  /** Path in central repo (e.g., "global/", "work/") */
  path: string;
  /** Local directory path (with ~ for home) */
  localPath: string;
  /** Machine identifier */
  machineId: string;
  /** Last sync timestamp (ISO format) */
  lastSync: string;
};

export type Registry = {
  version: number;
  mappings: RegistryMapping[];
};

export type CollisionCheckResult = "none" | "same-machine" | "collision";

/**
 * Get the registry file path for a central repo
 */
export function getRegistryPath(centralRepo: string): string {
  return path.join(centralRepo, REGISTRY_FILENAME);
}

/**
 * Create an empty registry
 */
export function createEmptyRegistry(): Registry {
  return {
    version: 1,
    mappings: [],
  };
}

/**
 * Read registry from central repo
 * Returns empty registry if file doesn't exist
 */
export async function readRegistry(centralRepo: string): Promise<Registry> {
  const registryPath = getRegistryPath(centralRepo);

  try {
    const content = await fs.readFile(registryPath, "utf-8");
    const registry = JSON.parse(content) as Registry;

    // Validate basic structure
    if (!registry.mappings || !Array.isArray(registry.mappings)) {
      return createEmptyRegistry();
    }

    return registry;
  } catch (error) {
    // File doesn't exist or is invalid
    return createEmptyRegistry();
  }
}

/**
 * Write registry to central repo atomically
 * Writes to temp file then renames to avoid corruption
 */
export async function writeRegistry(
  centralRepo: string,
  registry: Registry
): Promise<void> {
  const registryPath = getRegistryPath(centralRepo);
  const tempPath = `${registryPath}.${crypto.randomBytes(4).toString("hex")}.tmp`;

  // Ensure version is set
  registry.version = registry.version || 1;

  // Write to temp file
  await fs.writeFile(tempPath, JSON.stringify(registry, null, 2), "utf-8");

  // Atomic rename
  await fs.rename(tempPath, registryPath);
}

/**
 * Normalize a path for comparison
 * Expands ~ and resolves to absolute path
 */
export function normalizePath(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.resolve(os.homedir(), filePath.slice(2));
  }
  if (filePath === "~") {
    return os.homedir();
  }
  return path.resolve(filePath);
}

/**
 * Compress a path for storage
 * Replaces home directory with ~
 */
export function compressPath(filePath: string): string {
  const home = os.homedir();
  const resolved = path.resolve(filePath);
  if (resolved.startsWith(home)) {
    return "~" + resolved.slice(home.length);
  }
  return resolved;
}

/**
 * Normalize central repo path (remove trailing slash, etc.)
 */
export function normalizeRepoPath(repoPath: string): string {
  // Remove trailing slashes but keep at least one char
  let normalized = repoPath.replace(/\/+$/, "");
  if (normalized === "") {
    normalized = "/";
  }
  // Ensure it ends with / for directory paths (except root)
  if (!normalized.endsWith("/") && normalized !== "/") {
    normalized += "/";
  }
  return normalized;
}

/**
 * Check if a path mapping would collide with existing mappings
 *
 * Returns:
 * - "none": path is free, can be used
 * - "same-machine": same machine already has this path, can update
 * - "collision": different machine has this path, blocked
 */
export function checkCollision(
  registry: Registry,
  centralPath: string,
  localPath: string,
  machineId: string
): CollisionCheckResult {
  const normalizedCentralPath = normalizeRepoPath(centralPath);
  const normalizedLocalPath = normalizePath(localPath);

  for (const mapping of registry.mappings) {
    const mappingCentralPath = normalizeRepoPath(mapping.path);
    const mappingLocalPath = normalizePath(mapping.localPath);

    // Check if central path matches
    if (mappingCentralPath === normalizedCentralPath) {
      // Same machine, same or different local path - can update
      if (mapping.machineId === machineId) {
        return "same-machine";
      }

      // Different machine - collision
      return "collision";
    }
  }

  return "none";
}

/**
 * Add or update a mapping in the registry
 */
export function addMapping(
  registry: Registry,
  mapping: RegistryMapping
): Registry {
  const normalizedPath = normalizeRepoPath(mapping.path);
  const normalizedLocalPath = compressPath(mapping.localPath);

  // Remove existing mapping for this path+machine combination
  const filteredMappings = registry.mappings.filter(
    (m) =>
      !(
        normalizeRepoPath(m.path) === normalizedPath &&
        m.machineId === mapping.machineId
      )
  );

  // Add new mapping
  filteredMappings.push({
    ...mapping,
    path: normalizedPath,
    localPath: normalizedLocalPath,
  });

  return {
    ...registry,
    mappings: filteredMappings,
  };
}

/**
 * Remove a mapping from the registry
 */
export function removeMapping(
  registry: Registry,
  centralPath: string,
  machineId: string
): Registry {
  const normalizedPath = normalizeRepoPath(centralPath);

  const filteredMappings = registry.mappings.filter(
    (m) =>
      !(normalizeRepoPath(m.path) === normalizedPath && m.machineId === machineId)
  );

  return {
    ...registry,
    mappings: filteredMappings,
  };
}

/**
 * Find a mapping by central path and machine ID
 */
export function findMapping(
  registry: Registry,
  centralPath: string,
  machineId: string
): RegistryMapping | undefined {
  const normalizedPath = normalizeRepoPath(centralPath);

  return registry.mappings.find(
    (m) =>
      normalizeRepoPath(m.path) === normalizedPath && m.machineId === machineId
  );
}

/**
 * Get all mappings for a specific machine
 */
export function getMachineMappings(
  registry: Registry,
  machineId: string
): RegistryMapping[] {
  return registry.mappings.filter((m) => m.machineId === machineId);
}

/**
 * Update the lastSync timestamp for a mapping
 */
export function updateLastSync(
  registry: Registry,
  centralPath: string,
  machineId: string
): Registry {
  const normalizedPath = normalizeRepoPath(centralPath);

  const mappings = registry.mappings.map((m) => {
    if (
      normalizeRepoPath(m.path) === normalizedPath &&
      m.machineId === machineId
    ) {
      return {
        ...m,
        lastSync: new Date().toISOString(),
      };
    }
    return m;
  });

  return {
    ...registry,
    mappings,
  };
}
