/**
 * minimem init - Initialize memory directory
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  resolveMemoryDir,
  getInitConfig,
  isInitialized,
  formatPath,
  loadConfig,
  buildMinimemConfig,
} from "../config.js";
import {
  loadManifest,
  resolveStoreName,
  getLinkedStoreNames,
  resolveStore,
} from "../../store/manifest.js";
import { materializeStore } from "../../store/materialize.js";
import { resolveInitEmbedding } from "../embedding-setup.js";

const MEMORY_TEMPLATE = `# Memory

This is your memory file. Add notes, decisions, and context here.

## Quick Start

- Add daily logs in the \`memory/\` directory (e.g., \`memory/2024-01-15.md\`)
- Use \`minimem search <query>\` to find relevant memories
- Use \`minimem append <text>\` to quickly add to today's log

## Notes

`;

export type InitOptions = {
  global?: boolean;
  force?: boolean;
  /** Skip initial sync (for testing or when no embedding key is available yet) */
  skipSync?: boolean;
  /** Preset embedding provider (openai|gemini|local|none|auto); skips prompting */
  provider?: string;
  /** Accept defaults without prompting (non-interactive) */
  yes?: boolean;
};

export async function init(
  dir: string | undefined,
  options: InitOptions,
): Promise<void> {
  const memoryDir = resolveMemoryDir({ dir, global: options.global });
  const displayPath = formatPath(memoryDir);

  // Check if already initialized
  if (!options.force && (await isInitialized(memoryDir))) {
    console.log(`Already initialized: ${displayPath}`);
    console.log("Use --force to reinitialize");
    return;
  }

  console.log(`Initializing minimem in ${displayPath}...`);

  // Create directories
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(path.join(memoryDir, "memory"), { recursive: true });

  // Create MEMORY.md if it doesn't exist
  const memoryFilePath = path.join(memoryDir, "MEMORY.md");
  try {
    await fs.access(memoryFilePath);
    console.log("  MEMORY.md already exists, skipping");
  } catch {
    await fs.writeFile(memoryFilePath, MEMORY_TEMPLATE, "utf-8");
    console.log("  Created MEMORY.md");
  }

  // Resolve embedding provider (prompts interactively when no key is present)
  const embeddingSetup = await resolveInitEmbedding({
    provider: options.provider,
    yes: options.yes,
  });

  // Create config.json directly in memoryDir (contained layout)
  const config = getInitConfig();
  config.embedding = embeddingSetup.embedding;
  const configPath = path.join(memoryDir, "config.json");
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  console.log("  Created config.json");
  for (const message of embeddingSetup.messages) {
    console.log(`  ${message}`);
  }

  // Create .gitignore
  const gitignorePath = path.join(memoryDir, ".gitignore");
  await fs.writeFile(gitignorePath, "index.db\nindex.db-*\n", "utf-8");
  console.log("  Created .gitignore");

  // Materialize linked stores if this directory is registered in the manifest
  await materializeLinkedStores(memoryDir);

  // Run initial sync to create the DB and index existing files
  if (!options.skipSync) {
    await initialSync(memoryDir);
  }

  console.log();
  console.log("Done! Your memory directory is ready.");
  console.log(`Search your memories with: minimem search "your query"${dir ? ` --dir ${dir}` : ""}`);
}

/**
 * Run initial sync: create the SQLite DB and index any existing memory files.
 */
async function initialSync(memoryDir: string): Promise<void> {
  console.log();
  console.log("Indexing memory files...");

  const cliConfig = await loadConfig(memoryDir);
  const config = buildMinimemConfig(memoryDir, cliConfig, {
    watch: false,
  });

  // Dynamic import to avoid pulling in node:sqlite at module load time
  const { Minimem } = await import("../../minimem.js");
  // Derive the instance type from create() — Minimem has a private constructor,
  // so InstanceType<typeof Minimem> is not usable here.
  let minimem: Awaited<ReturnType<typeof Minimem.create>> | null = null;

  try {
    minimem = await Minimem.create(config);
    await minimem.sync({ force: false });

    const status = await minimem.status();
    console.log(`  Indexed ${status.fileCount} file(s), ${status.chunkCount} chunk(s)`);
  } catch (err) {
    // Non-fatal — init succeeds even if sync fails (e.g. no API key yet)
    console.log("  Skipped indexing (set an embedding API key to enable)");
  } finally {
    minimem?.close();
  }
}

/**
 * Materialize all linked stores for a directory.
 * Ensures remote-backed linked stores are cloned into the cache
 * so they're ready for search without a first-use delay.
 */
async function materializeLinkedStores(memoryDir: string): Promise<void> {
  try {
    const manifest = await loadManifest();
    if (Object.keys(manifest.stores).length === 0) return;

    const storeName = resolveStoreName(manifest, memoryDir);
    if (!storeName) return;

    const linkedNames = await getLinkedStoreNames(manifest, storeName);
    if (linkedNames.length === 0) return;

    let materialized = 0;
    for (const linkedName of linkedNames) {
      const linkedDef = resolveStore(manifest, linkedName);
      if (!linkedDef) continue;

      const result = await materializeStore(linkedName, linkedDef);
      if (result) {
        if (result.strategy === "remote") {
          console.log(`  Materialized linked store "${linkedName}" from remote`);
        }
        await result.cleanup();
        materialized++;
      }
    }

    if (materialized > 0) {
      console.log(`  ${materialized} linked store(s) ready`);
    }
  } catch {
    // Non-fatal — init succeeds even if linked store materialization fails
  }
}
