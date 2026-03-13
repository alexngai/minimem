/**
 * minimem search - Semantic search through memory
 *
 * Supports searching across multiple memory directories in a single query.
 * When a directory is registered in the store manifest with linked stores,
 * those linked stores are automatically included in the search.
 */

import { Minimem, type MinimemSearchResult } from "../../minimem.js";
import {
  loadManifest,
  resolveStoreName,
  getLinkedStoreNames,
  resolveStore,
} from "../../store/manifest.js";
import { materializeStore, type MaterializeResult } from "../../store/materialize.js";
import {
  resolveMemoryDirs,
  exitWithError,
  warn,
  note,
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
  /** Disable linked store resolution */
  noLinks?: boolean;
};

type SearchResultWithSource = MinimemSearchResult & {
  memoryDir: string;
};

export async function search(
  query: string,
  options: SearchOptions,
): Promise<void> {
  const directories = resolveMemoryDirs(options);

  if (directories.length === 0) {
    exitWithError(
      "No memory directories specified.",
      "Use --dir <path> or --global to specify directories to search."
    );
  }

  // Validate all directories are initialized
  const validDirs: string[] = [];
  for (const dir of directories) {
    if (await isInitialized(dir)) {
      validDirs.push(dir);
    } else {
      warn(`${formatPath(dir)} is not initialized, skipping.`);
    }
  }

  if (validDirs.length === 0) {
    exitWithError("No valid initialized memory directories found.");
  }

  // Resolve linked stores unless disabled
  const { dirs: allDirs, cleanups } = options.noLinks
    ? { dirs: validDirs, cleanups: [] as Array<() => Promise<void>> }
    : await resolveLinkedDirs(validDirs);

  const maxResults = options.max ? parseInt(options.max, 10) : 10;
  const minScore = options.minScore ? parseFloat(options.minScore) : undefined;

  // Search each directory and collect results
  const allResults: SearchResultWithSource[] = [];
  const instances: Minimem[] = [];

  let warnedBm25 = false;

  try {
    for (const memoryDir of allDirs) {
      const cliConfig = await loadConfig(memoryDir);
      const config = buildMinimemConfig(memoryDir, cliConfig, {
        provider: options.provider,
        watch: false,
      });

      const minimem = await Minimem.create(config);
      instances.push(minimem);

      // Warn once if running in BM25-only mode
      if (!warnedBm25) {
        const status = await minimem.status();
        if (status.bm25Only) {
          note("Running in BM25-only mode (no embedding API configured).");
          note("Results are based on keyword matching only.\n");
          warnedBm25 = true;
        }
      }

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
    const showSource = allDirs.length > 1;

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

    const dirSummary = allDirs.length > 1
      ? ` across ${allDirs.length} directories`
      : "";
    console.log(`Found ${topResults.length} result${topResults.length === 1 ? "" : "s"}${dirSummary}`);
  } finally {
    // Clean up all instances
    for (const instance of instances) {
      instance.close();
    }
    // Clean up materializations (symlinks, etc.)
    for (const cleanup of cleanups) {
      await cleanup().catch(() => {});
    }
  }
}

/**
 * Resolve linked stores for all directories.
 * For each directory that is registered in the store manifest,
 * materializes its linked stores (depth 1) and adds them to the search set.
 * Remote-backed stores are cloned/fetched into the cache automatically.
 */
async function resolveLinkedDirs(
  dirs: string[],
): Promise<{ dirs: string[]; cleanups: Array<() => Promise<void>> }> {
  const cleanups: Array<() => Promise<void>> = [];
  try {
    const manifest = await loadManifest();
    if (Object.keys(manifest.stores).length === 0) {
      return { dirs, cleanups };
    }

    const allDirs = new Set(dirs);

    for (const dir of dirs) {
      const storeName = resolveStoreName(manifest, dir);
      if (!storeName) continue;

      const linkedNames = await getLinkedStoreNames(manifest, storeName);
      for (const linkedName of linkedNames) {
        const linkedDef = resolveStore(manifest, linkedName);
        if (!linkedDef) continue;

        try {
          const result = await materializeStore(linkedName, linkedDef);
          if (result) {
            allDirs.add(result.path);
            cleanups.push(result.cleanup);
          }
        } catch {
          // Materialization failed — skip this linked store
        }
      }
    }

    return { dirs: [...allDirs], cleanups };
  } catch {
    return { dirs, cleanups };
  }
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
