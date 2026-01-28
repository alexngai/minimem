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
  session?: string;
  sessionSource?: string;
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

  // Add session marker if explicit session provided
  let finalText = text;
  if (options.session) {
    const timestamp = new Date().toISOString();
    const sourceInfo = options.sessionSource ? ` source=${options.sessionSource}` : "";
    finalText = `<!-- ${timestamp} session=${options.session}${sourceInfo} -->\n${text}`;
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
      await minimem.appendFile(targetPath, finalText);
    } else {
      // Append to today's daily log
      targetPath = await minimem.appendToday(finalText);
    }

    console.log(`Appended to ${targetPath}`);
    if (options.session) {
      console.log(`  Session: ${options.session}`);
    }
  } finally {
    minimem?.close();
  }
}
