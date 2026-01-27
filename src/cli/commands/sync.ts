/**
 * minimem sync - Force re-index memory files
 */

import { Minimem } from "../../minimem.js";
import {
  resolveMemoryDir,
  loadConfig,
  buildMinimemConfig,
  isInitialized,
  formatPath,
} from "../config.js";

export type SyncOptions = {
  dir?: string;
  global?: boolean;
  force?: boolean;
  provider?: string;
};

export async function sync(options: SyncOptions): Promise<void> {
  const memoryDir = resolveMemoryDir({ dir: options.dir, global: options.global });

  // Check if initialized
  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    console.error(`Run: minimem init${options.dir ? ` ${options.dir}` : ""}`);
    process.exit(1);
  }

  console.log(`Syncing ${formatPath(memoryDir)}...`);

  // Load config and create Minimem instance
  const cliConfig = await loadConfig(memoryDir);
  const config = buildMinimemConfig(memoryDir, cliConfig, {
    provider: options.provider,
    watch: false,
  });

  // Add debug logging
  config.debug = (message, data) => {
    if (data) {
      console.log(`  ${message}`, data);
    } else {
      console.log(`  ${message}`);
    }
  };

  let minimem: Minimem | null = null;

  try {
    minimem = await Minimem.create(config);

    const startTime = Date.now();
    await minimem.sync({ force: options.force });
    const duration = Date.now() - startTime;

    const status = await minimem.status();

    console.log();
    console.log(`Sync complete in ${duration}ms`);
    console.log(`  Files: ${status.fileCount}`);
    console.log(`  Chunks: ${status.chunkCount}`);
    console.log(`  Cache: ${status.cacheCount} embeddings`);
  } finally {
    minimem?.close();
  }
}
