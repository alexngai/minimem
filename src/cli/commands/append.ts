/**
 * minimem append - Quick append to today's daily log
 */

import { Minimem } from "../../minimem.js";
import {
  resolveMemoryDir,
  loadConfig,
  buildMinimemConfig,
  isInitialized,
  formatPath,
} from "../config.js";

export type AppendOptions = {
  dir?: string;
  global?: boolean;
  file?: string;
  provider?: string;
};

export async function append(
  text: string,
  options: AppendOptions,
): Promise<void> {
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

    let targetPath: string;

    if (options.file) {
      // Append to specific file
      targetPath = options.file;
      await minimem.appendFile(targetPath, text);
    } else {
      // Append to today's daily log
      targetPath = await minimem.appendToday(text);
    }

    console.log(`Appended to ${targetPath}`);
  } finally {
    minimem?.close();
  }
}
