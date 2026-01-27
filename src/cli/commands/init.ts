/**
 * minimem init - Initialize memory directory
 */

import fs from "node:fs/promises";
import path from "node:path";

import {
  resolveMemoryDir,
  saveConfig,
  getDefaultConfig,
  isInitialized,
  formatPath,
} from "../config.js";

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
  await fs.mkdir(path.join(memoryDir, ".minimem"), { recursive: true });

  // Create MEMORY.md if it doesn't exist
  const memoryFilePath = path.join(memoryDir, "MEMORY.md");
  try {
    await fs.access(memoryFilePath);
    console.log("  MEMORY.md already exists, skipping");
  } catch {
    await fs.writeFile(memoryFilePath, MEMORY_TEMPLATE, "utf-8");
    console.log("  Created MEMORY.md");
  }

  // Create config
  const config = getDefaultConfig();
  await saveConfig(memoryDir, config);
  console.log("  Created .minimem/config.json");

  // Create .gitignore for .minimem directory
  const gitignorePath = path.join(memoryDir, ".minimem", ".gitignore");
  await fs.writeFile(gitignorePath, "index.db\nindex.db-*\n", "utf-8");
  console.log("  Created .minimem/.gitignore");

  console.log();
  console.log("Done! Your memory directory is ready.");
  console.log();
  console.log("Next steps:");
  console.log(`  1. Set your embedding API key:`);
  console.log(`     export OPENAI_API_KEY=your-key`);
  console.log(`     # or: export GOOGLE_API_KEY=your-key`);
  console.log();
  console.log(`  2. Add some memories to MEMORY.md or memory/*.md`);
  console.log();
  console.log(`  3. Search your memories:`);
  console.log(`     minimem search "your query"${dir ? ` --dir ${dir}` : ""}`);
}
