/**
 * minimem search - Semantic search through memory
 *
 * Supports searching across multiple memory directories in a single query.
 */

import * as path from "node:path";
import * as os from "node:os";
import { Minimem, type MinimemSearchResult } from "../../minimem.js";
import {
  loadConfig,
  buildMinimemConfig,
  isInitialized,
  formatPath,
} from "../config.js";

export type SearchOptions = {
  dir?: string[];
  global?: boolean;
  max?: string;
  minScore?: string;
  provider?: string;
  json?: boolean;
};

type SearchResultWithSource = MinimemSearchResult & {
  memoryDir: string;
};

export async function search(
  query: string,
  options: SearchOptions,
): Promise<void> {
  // Collect all directories to search
  const directories = resolveSearchDirectories(options);

  if (directories.length === 0) {
    console.error("Error: No memory directories specified.");
    console.error("Use --dir <path> or --global to specify directories to search.");
    process.exit(1);
  }

  // Validate all directories are initialized
  const validDirs: string[] = [];
  for (const dir of directories) {
    if (await isInitialized(dir)) {
      validDirs.push(dir);
    } else {
      console.error(`Warning: ${formatPath(dir)} is not initialized, skipping.`);
    }
  }

  if (validDirs.length === 0) {
    console.error("Error: No valid initialized memory directories found.");
    process.exit(1);
  }

  const maxResults = options.max ? parseInt(options.max, 10) : 10;
  const minScore = options.minScore ? parseFloat(options.minScore) : undefined;

  // Search each directory and collect results
  const allResults: SearchResultWithSource[] = [];
  const instances: Minimem[] = [];

  try {
    for (const memoryDir of validDirs) {
      const cliConfig = await loadConfig(memoryDir);
      const config = buildMinimemConfig(memoryDir, cliConfig, {
        provider: options.provider,
        watch: false,
      });

      const minimem = await Minimem.create(config);
      instances.push(minimem);

      // Get more results per directory, then merge and trim
      const perDirMax = Math.ceil(maxResults * 1.5);
      const results = await minimem.search(query, { maxResults: perDirMax, minScore });

      // Add source directory to each result
      for (const result of results) {
        allResults.push({
          ...result,
          memoryDir,
        });
      }
    }

    // Sort by score descending and limit to maxResults
    allResults.sort((a, b) => b.score - a.score);
    const topResults = allResults.slice(0, maxResults);

    if (topResults.length === 0) {
      console.log("No results found.");
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(topResults, null, 2));
      return;
    }

    // Format results for terminal
    const showSource = validDirs.length > 1;

    for (const result of topResults) {
      const score = (result.score * 100).toFixed(1);
      const location = `${result.path}:${result.startLine}-${result.endLine}`;

      if (showSource) {
        console.log(`[${score}%] ${formatPath(result.memoryDir)}`);
        console.log(`       ${location}`);
      } else {
        console.log(`[${score}%] ${location}`);
      }
      console.log(formatSnippet(result.snippet));
      console.log();
    }

    const dirSummary = validDirs.length > 1
      ? ` across ${validDirs.length} directories`
      : "";
    console.log(`Found ${topResults.length} result${topResults.length === 1 ? "" : "s"}${dirSummary}`);
  } finally {
    // Clean up all instances
    for (const instance of instances) {
      instance.close();
    }
  }
}

/**
 * Resolve all directories to search based on options
 */
function resolveSearchDirectories(options: SearchOptions): string[] {
  const dirs: string[] = [];

  // Add explicit directories
  if (options.dir && options.dir.length > 0) {
    for (const dir of options.dir) {
      dirs.push(path.resolve(dir));
    }
  }

  // Add global directory if --global flag is set
  if (options.global) {
    const globalDir = path.join(os.homedir(), ".minimem");
    if (!dirs.includes(globalDir)) {
      dirs.push(globalDir);
    }
  }

  // If no directories specified, use current directory
  if (dirs.length === 0) {
    dirs.push(process.cwd());
  }

  return dirs;
}

/**
 * Format snippet for terminal display
 */
function formatSnippet(snippet: string): string {
  const lines = snippet.split("\n");
  const formatted = lines.map((line) => `  ${line}`).join("\n");

  // Truncate if too long
  if (formatted.length > 500) {
    return formatted.slice(0, 497) + "...";
  }

  return formatted;
}
