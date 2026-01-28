/**
 * minimem status - Show index stats and provider info
 */

import { Minimem } from "../../minimem.js";
import {
  resolveMemoryDir,
  loadConfig,
  buildMinimemConfig,
  isInitialized,
  formatPath,
} from "../config.js";

export type StatusOptions = {
  dir?: string;
  global?: boolean;
  json?: boolean;
  provider?: string;
};

export async function status(options: StatusOptions): Promise<void> {
  const memoryDir = resolveMemoryDir({ dir: options.dir, global: options.global });

  // Check if initialized
  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    console.error(`Run: minimem init${options.dir ? ` ${options.dir}` : ""}`);
    process.exit(1);
  }

  // Load config and create Minimem instance
  const cliConfig = await loadConfig(memoryDir);
  const config = buildMinimemConfig(memoryDir, cliConfig, {
    provider: options.provider,
    watch: false,
  });

  let minimem: Minimem | null = null;

  try {
    minimem = await Minimem.create(config);
    const info = await minimem.status();

    if (options.json) {
      console.log(JSON.stringify(info, null, 2));
      return;
    }

    console.log("Minimem Status");
    console.log("==============");
    console.log();
    console.log(`Memory Dir:  ${formatPath(info.memoryDir)}`);
    console.log(`Database:    ${formatPath(info.dbPath)}`);
    console.log();
    console.log("Embedding Provider");
    if (info.bm25Only) {
      console.log(`  Provider:  none (BM25-only mode)`);
      console.log(`  Model:     ${info.model}`);
      if (info.fallbackReason) {
        console.log(`  Reason:    ${info.fallbackReason}`);
      }
    } else {
      console.log(`  Provider:  ${info.provider}`);
      console.log(`  Model:     ${info.model}`);
    }
    console.log();
    console.log("Search Capabilities");
    if (info.bm25Only) {
      console.log(`  Vector:    disabled (no embedding provider)`);
    } else {
      console.log(`  Vector:    ${info.vectorAvailable ? "available" : "not available"}`);
    }
    console.log(`  FTS:       ${info.ftsAvailable ? "available" : "not available"}`);
    console.log();
    console.log("Index Stats");
    console.log(`  Files:     ${info.fileCount}`);
    console.log(`  Chunks:    ${info.chunkCount}`);
    console.log(`  Cache:     ${info.cacheCount} embeddings`);
  } finally {
    minimem?.close();
  }
}
