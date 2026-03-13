/**
 * Store manifest: defines known stores and their relationships.
 *
 * Manifests can live in two places:
 * 1. Global: ~/.config/minimem/stores.json (user-wide registry)
 * 2. Per-store: .minimem/links.json (declares that store's dependencies)
 *
 * The global manifest is the source of truth for store metadata (path, remote).
 * Per-store link files declare which other stores a store depends on.
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

/**
 * A single store definition in the global manifest.
 */
export type StoreDefinition = {
  /** Absolute path to the store's memory directory */
  path: string;
  /** Git remote URL for remote materialization */
  remote?: string;
  /** Human-readable description */
  description?: string;
};

/**
 * Global store manifest (~/.config/minimem/stores.json)
 */
export type StoreManifest = {
  stores: Record<string, StoreDefinition>;
};

/**
 * Per-store links file (.minimem/links.json or .swarm/minimem/links.json)
 * Declares which other stores this store depends on.
 */
export type StoreLinks = {
  /** Store names that this store links to (depth-1 only) */
  links: string[];
};

const GLOBAL_MANIFEST_PATH = path.join(
  os.homedir(),
  ".config",
  "minimem",
  "stores.json",
);

const LINKS_FILENAME = "links.json";

/**
 * Load the global store manifest.
 * Returns an empty manifest if the file doesn't exist.
 */
export async function loadManifest(
  manifestPath?: string,
): Promise<StoreManifest> {
  const filePath = manifestPath ?? GLOBAL_MANIFEST_PATH;
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(content) as StoreManifest;
    // Expand ~ in paths
    for (const [name, def] of Object.entries(parsed.stores ?? {})) {
      parsed.stores[name] = {
        ...def,
        path: expandHome(def.path),
      };
    }
    return { stores: parsed.stores ?? {} };
  } catch {
    return { stores: {} };
  }
}

/**
 * Save the global store manifest.
 */
export async function saveManifest(
  manifest: StoreManifest,
  manifestPath?: string,
): Promise<void> {
  const filePath = manifestPath ?? GLOBAL_MANIFEST_PATH;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(manifest, null, 2), "utf-8");
}

/**
 * Load per-store links from a memory directory.
 * Checks .minimem/links.json, .swarm/minimem/links.json, and links.json (contained layout).
 */
export async function loadStoreLinks(memoryDir: string): Promise<StoreLinks> {
  const candidates = [
    path.join(memoryDir, ".minimem", LINKS_FILENAME),
    path.join(memoryDir, ".swarm", "minimem", LINKS_FILENAME),
    path.join(memoryDir, LINKS_FILENAME),
  ];

  for (const candidate of candidates) {
    try {
      const content = await fs.readFile(candidate, "utf-8");
      const parsed = JSON.parse(content) as StoreLinks;
      return { links: parsed.links ?? [] };
    } catch {
      continue;
    }
  }

  return { links: [] };
}

/**
 * Save per-store links to a memory directory.
 * Writes to the first config subdirectory that exists.
 */
export async function saveStoreLinks(
  memoryDir: string,
  links: StoreLinks,
): Promise<void> {
  // Find existing config subdirectory
  const candidates = [
    path.join(memoryDir, ".minimem"),
    path.join(memoryDir, ".swarm", "minimem"),
    memoryDir, // contained layout
  ];

  let targetDir = candidates[0]; // default to .minimem
  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      targetDir = candidate;
      break;
    }
  }

  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(
    path.join(targetDir, LINKS_FILENAME),
    JSON.stringify(links, null, 2),
    "utf-8",
  );
}

/**
 * Resolve store name to its definition.
 * Looks up the store in the global manifest.
 */
export function resolveStore(
  manifest: StoreManifest,
  storeName: string,
): StoreDefinition | null {
  return manifest.stores[storeName] ?? null;
}

/**
 * Resolve a directory path to its store name in the manifest.
 * Returns the first store whose path matches.
 */
export function resolveStoreName(
  manifest: StoreManifest,
  dirPath: string,
): string | null {
  const resolved = path.resolve(dirPath);
  for (const [name, def] of Object.entries(manifest.stores)) {
    if (path.resolve(def.path) === resolved) {
      return name;
    }
  }
  return null;
}

/**
 * Get all linked store names for a given store (depth 1 only).
 * Merges links from the global manifest and per-store links file.
 */
export async function getLinkedStoreNames(
  manifest: StoreManifest,
  storeName: string,
): Promise<string[]> {
  const storeDef = manifest.stores[storeName];
  if (!storeDef) return [];

  // Load per-store links
  const storeLinks = await loadStoreLinks(storeDef.path);

  // Deduplicate
  return [...new Set(storeLinks.links)];
}

/**
 * Get the default global manifest path.
 */
export function getManifestPath(): string {
  return GLOBAL_MANIFEST_PATH;
}

function expandHome(filePath: string): string {
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}
