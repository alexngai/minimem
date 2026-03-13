/**
 * StoreGraph: meta-layer above Minimem for managing linked stores.
 *
 * A StoreGraph resolves a store and its dependencies (depth 1),
 * materializes them as needed, and produces an array of MemoryInstance
 * objects that can be passed to MemoryToolExecutor or used directly.
 *
 * The Minimem class is unchanged — StoreGraph just orchestrates
 * multiple independent Minimem instances.
 */

import path from "node:path";

import { Minimem, type MinimemConfig } from "../minimem.js";
import type { MemoryInstance } from "../server/tools.js";
import {
  loadManifest,
  getLinkedStoreNames,
  resolveStore,
  resolveStoreName,
  type StoreManifest,
  type StoreDefinition,
} from "./manifest.js";
import { materializeStore, type MaterializeResult } from "./materialize.js";

export type StoreGraphOptions = {
  /** Path to the global manifest file (default: ~/.config/minimem/stores.json) */
  manifestPath?: string;
  /** Factory to create a MinimemConfig for a given store directory */
  configFactory?: (memoryDir: string, storeName: string) => Promise<MinimemConfig>;
  /** Debug logging */
  debug?: (message: string) => void;
};

export type ResolvedStore = {
  name: string;
  definition: StoreDefinition;
  materialization: MaterializeResult;
  instance: Minimem;
};

export class StoreGraph {
  private manifest: StoreManifest;
  private resolved: Map<string, ResolvedStore> = new Map();
  private configFactory: (memoryDir: string, storeName: string) => Promise<MinimemConfig>;
  private debug?: (message: string) => void;

  private constructor(
    manifest: StoreManifest,
    opts?: StoreGraphOptions,
  ) {
    this.manifest = manifest;
    this.debug = opts?.debug;
    this.configFactory = opts?.configFactory ?? defaultConfigFactory;
  }

  /**
   * Create a StoreGraph from the global manifest.
   */
  static async create(opts?: StoreGraphOptions): Promise<StoreGraph> {
    const manifest = await loadManifest(opts?.manifestPath);
    return new StoreGraph(manifest, opts);
  }

  /**
   * Create a StoreGraph from an explicit manifest object (useful for testing).
   */
  static fromManifest(
    manifest: StoreManifest,
    opts?: StoreGraphOptions,
  ): StoreGraph {
    return new StoreGraph(manifest, opts);
  }

  /**
   * Get the loaded manifest.
   */
  getManifest(): StoreManifest {
    return this.manifest;
  }

  /**
   * Resolve a store by name: materialize it and all its linked stores (depth 1).
   * Returns an array of MemoryInstance objects ready for search.
   *
   * Linked stores that fail to materialize are skipped with a warning.
   */
  async resolve(storeName: string): Promise<MemoryInstance[]> {
    const instances: MemoryInstance[] = [];

    // Resolve the primary store
    const primary = await this.resolveOne(storeName);
    if (!primary) {
      throw new Error(`Store "${storeName}" not found or unavailable`);
    }
    instances.push({
      minimem: primary.instance,
      memoryDir: primary.materialization.path,
      name: storeName,
    });

    // Resolve linked stores (depth 1)
    const linkedNames = await getLinkedStoreNames(this.manifest, storeName);
    for (const linkedName of linkedNames) {
      if (linkedName === storeName) continue; // skip self-links

      try {
        const linked = await this.resolveOne(linkedName);
        if (linked) {
          instances.push({
            minimem: linked.instance,
            memoryDir: linked.materialization.path,
            name: linkedName,
          });
        } else {
          this.debug?.(`Linked store "${linkedName}" unavailable, skipping`);
        }
      } catch (err) {
        this.debug?.(
          `Failed to resolve linked store "${linkedName}": ${String(err)}`,
        );
      }
    }

    return instances;
  }

  /**
   * Resolve a store by directory path (looks up the store name in the manifest).
   * Falls back to creating a standalone instance if the directory isn't in the manifest.
   */
  async resolveByPath(dirPath: string): Promise<MemoryInstance[]> {
    const storeName = resolveStoreName(this.manifest, dirPath);
    if (storeName) {
      return this.resolve(storeName);
    }

    // Not in manifest — return standalone instance with no links
    this.debug?.(`Directory "${dirPath}" not in manifest, using standalone`);
    const config = await this.configFactory(dirPath, path.basename(dirPath));
    const instance = await Minimem.create(config);
    return [
      {
        minimem: instance,
        memoryDir: dirPath,
        name: path.basename(dirPath),
      },
    ];
  }

  /**
   * List all known stores from the manifest with their link info.
   */
  async listStores(): Promise<
    Array<{
      name: string;
      path: string;
      remote?: string;
      links: string[];
      available: boolean;
    }>
  > {
    const result: Array<{
      name: string;
      path: string;
      remote?: string;
      links: string[];
      available: boolean;
    }> = [];

    for (const [name, def] of Object.entries(this.manifest.stores)) {
      const links = await getLinkedStoreNames(this.manifest, name);
      const { existsSync } = await import("node:fs");
      const available = existsSync(def.path) || !!def.remote;

      result.push({
        name,
        path: def.path,
        remote: def.remote,
        links,
        available,
      });
    }

    return result;
  }

  /**
   * Close all resolved Minimem instances and clean up materializations.
   */
  async close(): Promise<void> {
    for (const [, store] of this.resolved) {
      try {
        store.instance.close();
      } catch {
        // best effort
      }
      try {
        await store.materialization.cleanup();
      } catch {
        // best effort
      }
    }
    this.resolved.clear();
  }

  /**
   * Resolve a single store by name.
   * Returns cached instance if already resolved.
   */
  private async resolveOne(storeName: string): Promise<ResolvedStore | null> {
    // Return cached if available
    const cached = this.resolved.get(storeName);
    if (cached) return cached;

    const def = resolveStore(this.manifest, storeName);
    if (!def) return null;

    // Materialize
    const materialization = await materializeStore(storeName, def);
    if (!materialization) return null;

    // Create Minimem instance
    const config = await this.configFactory(materialization.path, storeName);
    const instance = await Minimem.create(config);

    const resolved: ResolvedStore = {
      name: storeName,
      definition: def,
      materialization,
      instance,
    };

    this.resolved.set(storeName, resolved);
    return resolved;
  }
}

/**
 * Default config factory: creates a minimal config with auto embedding.
 * In practice, the CLI will provide a factory that respects per-store configs.
 */
async function defaultConfigFactory(
  memoryDir: string,
  _storeName: string,
): Promise<MinimemConfig> {
  return {
    memoryDir,
    embedding: { provider: "auto" },
    watch: { enabled: false },
  };
}
