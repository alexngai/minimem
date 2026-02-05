/**
 * minimem upsert - Create or update a memory file
 *
 * File paths are relative to the memory directory:
 *   minimem upsert MEMORY.md "content"        → {memoryDir}/MEMORY.md
 *   minimem upsert memory/notes.md "content"  → {memoryDir}/memory/notes.md
 *   minimem upsert /abs/path.md "content"     → /abs/path.md
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Minimem } from "../../minimem.js";
import {
  resolveMemoryDir,
  exitWithError,
  note,
  loadConfig,
  buildMinimemConfig,
  isInitialized,
  formatPath,
} from "../config.js";
import {
  addFrontmatter,
  parseFrontmatter,
  type SessionContext,
} from "../../session.js";

export type UpsertOptions = {
  dir?: string;
  global?: boolean;
  provider?: string;
  stdin?: boolean;
  session?: string;
  sessionSource?: string;
};

export async function upsert(
  file: string,
  content: string | undefined,
  options: UpsertOptions,
): Promise<void> {
  const memoryDir = resolveMemoryDir({ dir: options.dir, global: options.global });

  // Check if initialized
  if (!(await isInitialized(memoryDir))) {
    exitWithError(
      `${formatPath(memoryDir)} is not initialized.`,
      `Run: minimem init${options.dir ? ` ${options.dir}` : ""}`
    );
  }

  // Get content from stdin if --stdin flag is set
  let finalContent = content;
  if (options.stdin) {
    finalContent = await readStdin();
  }

  if (!finalContent) {
    exitWithError(
      "No content provided.",
      "Use --stdin or provide content as argument."
    );
  }

  // Build session context from explicit options
  const session: SessionContext | undefined = options.session
    ? {
        id: options.session,
        source: options.sessionSource,
        project: process.cwd(),
      }
    : undefined;

  // Resolve file path - all relative paths are relative to memoryDir
  const filePath = resolveFilePath(file, memoryDir);

  // Ensure the file is within the memory directory
  const resolvedPath = path.resolve(filePath);
  const resolvedMemoryDir = path.resolve(memoryDir);
  if (!resolvedPath.startsWith(resolvedMemoryDir + path.sep) && resolvedPath !== resolvedMemoryDir) {
    exitWithError(
      "File path must be within the memory directory.",
      `Memory dir: ${formatPath(memoryDir)}, File: ${formatPath(filePath)}`
    );
  }

  // Ensure parent directory exists
  const parentDir = path.dirname(filePath);
  await fs.mkdir(parentDir, { recursive: true });

  // Check if file exists (for reporting)
  let isUpdate = false;
  let existingContent: string | undefined;
  try {
    await fs.access(filePath);
    isUpdate = true;
    existingContent = await fs.readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist, this is a create
  }

  // Add session frontmatter if session context exists and file is markdown
  let contentToWrite = finalContent;
  if (session && filePath.endsWith(".md")) {
    if (isUpdate && existingContent) {
      // For updates, preserve existing frontmatter but update session
      const { frontmatter: existing, body } = parseFrontmatter(existingContent);
      // Check if the new content already has frontmatter
      const { frontmatter: newFm, body: newBody } = parseFrontmatter(finalContent);
      if (newFm) {
        // New content has frontmatter, merge with existing
        contentToWrite = addFrontmatter(newBody, {
          ...existing,
          ...newFm,
          session: { ...existing?.session, ...newFm.session, ...session },
        });
      } else {
        // New content has no frontmatter, add session to new content
        contentToWrite = addFrontmatter(finalContent, {
          ...existing,
          session: { ...existing?.session, ...session },
        });
      }
    } else {
      // New file - add frontmatter with session
      const { frontmatter: existingFm, body } = parseFrontmatter(finalContent);
      contentToWrite = addFrontmatter(body, {
        ...existingFm,
        session,
      });
    }
  }

  // Write content to file
  await fs.writeFile(filePath, contentToWrite, "utf-8");

  const relativePath = path.relative(memoryDir, filePath);
  const action = isUpdate ? "Updated" : "Created";
  console.log(`${action}: ${relativePath}`);
  console.log(`  in ${formatPath(memoryDir)}`);
  if (options.session) {
    console.log(`  Session: ${options.session}`);
  }

  // Try to sync the index (requires embedding provider)
  let minimem: Minimem | null = null;

  try {
    const cliConfig = await loadConfig(memoryDir);
    const config = buildMinimemConfig(memoryDir, cliConfig, {
      provider: options.provider,
      watch: false,
    });

    minimem = await Minimem.create(config);
    await minimem.sync();
    console.log("  Index synced.");
  } catch {
    // Sync failed, but file was written successfully
    note("Index not synced (run 'minimem sync' with API key to index).");
  } finally {
    minimem?.close();
  }
}

/**
 * Resolve file path to an absolute path.
 *
 * Simple rules:
 * - Absolute paths are used as-is
 * - Relative paths are relative to memoryDir
 *
 * Examples:
 *   MEMORY.md           → {memoryDir}/MEMORY.md
 *   memory/notes.md     → {memoryDir}/memory/notes.md
 *   memory/2024/jan.md  → {memoryDir}/memory/2024/jan.md
 *   /abs/path.md        → /abs/path.md
 */
function resolveFilePath(file: string, memoryDir: string): string {
  if (path.isAbsolute(file)) {
    return file;
  }
  return path.join(memoryDir, file);
}

/**
 * Read content from stdin
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  return new Promise((resolve, reject) => {
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", reject);
  });
}
