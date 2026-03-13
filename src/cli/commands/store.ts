/**
 * minimem store commands - Manage linked memory stores
 *
 * Commands:
 *   store:list   - List all registered stores and their links
 *   store:add    - Register a store in the global manifest
 *   store:remove - Remove a store from the global manifest
 *   store:link   - Link one store to another (per-store links.json)
 *   store:unlink - Remove a link between stores
 */

import path from "node:path";
import {
  loadManifest,
  saveManifest,
  loadStoreLinks,
  saveStoreLinks,
  getLinkedStoreNames,
  getManifestPath,
  type StoreDefinition,
} from "../../store/manifest.js";
import { materializeStore } from "../../store/materialize.js";
import { exitWithError, formatPath } from "../config.js";

export type StoreListOptions = {
  json?: boolean;
};

export async function storeList(options: StoreListOptions): Promise<void> {
  const manifest = await loadManifest();
  const storeNames = Object.keys(manifest.stores);

  if (storeNames.length === 0) {
    console.log("No stores registered.");
    console.log(`\nRegister a store with: minimem store:add <name> <path>`);
    return;
  }

  if (options.json) {
    const result: Record<string, { path: string; remote?: string; links: string[] }> = {};
    for (const name of storeNames) {
      const def = manifest.stores[name];
      const links = await getLinkedStoreNames(manifest, name);
      result[name] = { path: def.path, remote: def.remote, links };
    }
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Registered stores (${getManifestPath()}):\n`);
  for (const name of storeNames) {
    const def = manifest.stores[name];
    const links = await getLinkedStoreNames(manifest, name);
    console.log(`  ${name}`);
    console.log(`    path: ${formatPath(def.path)}`);
    if (def.remote) {
      console.log(`    remote: ${def.remote}`);
    }
    if (def.description) {
      console.log(`    description: ${def.description}`);
    }
    if (links.length > 0) {
      console.log(`    links: ${links.join(", ")}`);
    }
    console.log();
  }
}

export type StoreAddOptions = {
  remote?: string;
  description?: string;
};

export async function storeAdd(
  name: string,
  storePath: string,
  options: StoreAddOptions,
): Promise<void> {
  const manifest = await loadManifest();
  const absPath = path.resolve(storePath);

  if (manifest.stores[name]) {
    exitWithError(
      `Store "${name}" already exists.`,
      `Use a different name or remove it first with: minimem store:remove ${name}`,
    );
  }

  const def: StoreDefinition = {
    path: absPath,
    remote: options.remote,
    description: options.description,
  };

  manifest.stores[name] = def;
  await saveManifest(manifest);

  console.log(`Registered store "${name}" at ${formatPath(absPath)}`);
  if (options.remote) {
    console.log(`  remote: ${options.remote}`);
  }

  // Materialize the store (clone remote if local path doesn't exist)
  const result = await materializeStore(name, def);
  if (result) {
    if (result.strategy === "remote") {
      console.log(`  Cloned remote into ${formatPath(result.path)}`);
    }
    await result.cleanup();
  } else if (options.remote) {
    console.log(`  Warning: could not materialize store (remote clone failed)`);
  }
}

export async function storeRemove(name: string): Promise<void> {
  const manifest = await loadManifest();

  if (!manifest.stores[name]) {
    exitWithError(`Store "${name}" not found.`);
  }

  delete manifest.stores[name];
  await saveManifest(manifest);

  console.log(`Removed store "${name}"`);
}

export async function storeLink(
  storeName: string,
  targetName: string,
): Promise<void> {
  const manifest = await loadManifest();

  const storeDef = manifest.stores[storeName];
  if (!storeDef) {
    exitWithError(
      `Store "${storeName}" not found.`,
      `Register it first with: minimem store:add ${storeName} <path>`,
    );
  }

  if (!manifest.stores[targetName]) {
    exitWithError(
      `Target store "${targetName}" not found.`,
      `Register it first with: minimem store:add ${targetName} <path>`,
    );
  }

  if (storeName === targetName) {
    exitWithError("Cannot link a store to itself.");
  }

  const links = await loadStoreLinks(storeDef.path);

  if (links.links.includes(targetName)) {
    console.log(`Store "${storeName}" already links to "${targetName}"`);
    return;
  }

  links.links.push(targetName);
  await saveStoreLinks(storeDef.path, links);

  console.log(`Linked "${storeName}" → "${targetName}"`);
  console.log(`  When searching "${storeName}", "${targetName}" will be included automatically.`);
}

export async function storeUnlink(
  storeName: string,
  targetName: string,
): Promise<void> {
  const manifest = await loadManifest();

  const storeDef = manifest.stores[storeName];
  if (!storeDef) {
    exitWithError(`Store "${storeName}" not found.`);
  }

  const links = await loadStoreLinks(storeDef.path);

  if (!links.links.includes(targetName)) {
    console.log(`Store "${storeName}" does not link to "${targetName}"`);
    return;
  }

  links.links = links.links.filter((l) => l !== targetName);
  await saveStoreLinks(storeDef.path, links);

  console.log(`Unlinked "${storeName}" from "${targetName}"`);
}
