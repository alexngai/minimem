/**
 * BEIR dataset loader with on-disk cache.
 *
 * Downloads and caches BEIR datasets from the canonical public distribution:
 * https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/<name>.zip
 *
 * NOTE: `loadBeirDataset` requires network access on first run to download
 * the zip. Subsequent runs use the on-disk cache and work fully offline.
 *
 * Run with tsx (dev only — not part of the published build):
 *   npx tsx evals/datasets/beir.ts
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { BeirDataset } from "./types.js";

export type BeirDatasetName = "scifact" | "nfcorpus" | "arguana";

export interface LoadBeirOptions {
  /**
   * Directory for cached dataset files.
   * Defaults to `<repo-root>/evals/datasets/cache`.
   */
  cacheDir?: string;

  /**
   * Which qrels split to load. Defaults to "test".
   */
  split?: string;
}

const BEIR_BASE_URL =
  "https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets";

/**
 * Resolve the default cache directory relative to this file.
 * Keeps cache co-located with evals/datasets/cache/.
 */
function defaultCacheDir(): string {
  // __dirname is not available in ESM; use import.meta.url
  const thisFile = new URL(import.meta.url).pathname;
  return path.join(path.dirname(thisFile), "cache");
}

/**
 * Parse a BEIR corpus.jsonl file.
 * Each line is a JSON object with `_id`, `title`, and `text`.
 *
 * @param filePath - Absolute path to corpus.jsonl
 * @returns Map from doc _id to {title, text}
 */
export async function parseCorpus(
  filePath: string
): Promise<Map<string, { title: string; text: string }>> {
  const content = await fs.readFile(filePath, "utf-8");
  const corpus = new Map<string, { title: string; text: string }>();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const obj = JSON.parse(trimmed) as {
      _id: string;
      title: string;
      text: string;
    };
    corpus.set(obj._id, { title: obj.title ?? "", text: obj.text ?? "" });
  }

  return corpus;
}

/**
 * Parse a BEIR queries.jsonl file.
 * Each line is a JSON object with `_id` and `text`.
 *
 * @param filePath - Absolute path to queries.jsonl
 * @returns Map from query _id to query text
 */
export async function parseQueries(
  filePath: string
): Promise<Map<string, string>> {
  const content = await fs.readFile(filePath, "utf-8");
  const queries = new Map<string, string>();

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const obj = JSON.parse(trimmed) as { _id: string; text: string };
    queries.set(obj._id, obj.text ?? "");
  }

  return queries;
}

/**
 * Parse a BEIR qrels TSV file.
 * Format: header row ("query-id\tcorpus-id\tscore"), then data rows.
 *
 * @param filePath - Absolute path to qrels/<split>.tsv
 * @returns Map from query_id to (doc_id -> relevance score)
 */
export async function parseQrels(
  filePath: string
): Promise<Map<string, Map<string, number>>> {
  const content = await fs.readFile(filePath, "utf-8");
  const qrels = new Map<string, Map<string, number>>();
  let firstLine = true;

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Skip header row
    if (firstLine) {
      firstLine = false;
      if (trimmed.startsWith("query-id")) continue;
    }

    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;

    const [queryId, corpusId, scoreStr] = parts;
    const score = parseInt(scoreStr, 10);

    if (!qrels.has(queryId)) {
      qrels.set(queryId, new Map());
    }
    qrels.get(queryId)!.set(corpusId, score);
  }

  return qrels;
}

/**
 * Parse a BEIR dataset from an already-extracted directory.
 * Pure function — no network, no side effects.
 *
 * @param dir   - Path to the extracted dataset directory (contains corpus.jsonl, queries.jsonl, qrels/)
 * @param split - qrels split to load (default: "test")
 * @returns Parsed BeirDataset (without the `name` field; caller fills it in)
 */
export async function parseBeirDir(
  dir: string,
  split = "test"
): Promise<Omit<BeirDataset, "name">> {
  const corpusPath = path.join(dir, "corpus.jsonl");
  const queriesPath = path.join(dir, "queries.jsonl");
  const qrelsPath = path.join(dir, "qrels", `${split}.tsv`);

  const [corpus, queries, qrels] = await Promise.all([
    parseCorpus(corpusPath),
    parseQueries(queriesPath),
    parseQrels(qrelsPath),
  ]);

  return { corpus, queries, qrels };
}

/**
 * Download a URL to a local file path using built-in fetch.
 */
async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }

  const fileHandle = await fs.open(destPath, "w");
  try {
    const writer = fileHandle.createWriteStream();
    await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), writer);
  } finally {
    await fileHandle.close();
  }
}

/**
 * Unzip a .zip archive into a destination directory using the system `unzip`
 * command (available on all POSIX systems) or a fallback streaming approach.
 *
 * We use child_process.spawn to call the system `unzip` binary because Node's
 * built-in zlib only handles gzip streams, not ZIP archives (which require
 * random-access reading of the central directory). This avoids adding any npm
 * dependency (e.g. jszip, adm-zip).
 */
async function unzipFile(zipPath: string, destDir: string): Promise<void> {
  const { spawn } = await import("node:child_process");

  await fs.mkdir(destDir, { recursive: true });

  await new Promise<void>((resolve, reject) => {
    const proc = spawn("unzip", ["-q", "-o", zipPath, "-d", destDir], {
      stdio: ["ignore", "ignore", "pipe"],
    });

    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`unzip failed (exit ${code}): ${stderr}`));
      }
    });

    proc.on("error", reject);
  });
}

/**
 * Ensure the dataset is downloaded and extracted in the cache.
 * Returns the path to the extracted dataset directory.
 *
 * Cache layout:
 *   <cacheDir>/<name>/          ← extracted dataset directory
 *   <cacheDir>/<name>.zip       ← downloaded archive (removed after extraction)
 */
async function ensureCached(
  name: BeirDatasetName,
  cacheDir: string
): Promise<string> {
  const datasetDir = path.join(cacheDir, name);
  const markerFile = path.join(datasetDir, "corpus.jsonl");

  // Fast path: already extracted
  if (fsSync.existsSync(markerFile)) {
    return datasetDir;
  }

  await fs.mkdir(cacheDir, { recursive: true });

  const zipPath = path.join(cacheDir, `${name}.zip`);
  const url = `${BEIR_BASE_URL}/${name}.zip`;

  process.stderr.write(
    `[beir] Downloading ${name} from ${url}...\n`
  );

  await downloadFile(url, zipPath);

  process.stderr.write(`[beir] Extracting ${name}.zip...\n`);
  await unzipFile(zipPath, cacheDir);

  // Remove the zip to save disk space
  await fs.unlink(zipPath).catch(() => {
    // Non-fatal: leave zip if deletion fails
  });

  // Verify extraction succeeded
  if (!fsSync.existsSync(markerFile)) {
    throw new Error(
      `Extraction of ${name}.zip succeeded but corpus.jsonl not found at ${markerFile}. ` +
        `The zip may have a different internal directory structure.`
    );
  }

  process.stderr.write(`[beir] ${name} cached at ${datasetDir}\n`);
  return datasetDir;
}

/**
 * Load a BEIR dataset by name, downloading and caching it on first run.
 *
 * NETWORK REQUIREMENT: The first call for a given dataset name requires
 * internet access to download from the BEIR public distribution. Subsequent
 * calls use the on-disk cache and work offline.
 *
 * @param name    - Dataset name: "scifact" | "nfcorpus" | "arguana"
 * @param opts    - Options: cacheDir (default: evals/datasets/cache), split (default: "test")
 * @returns Fully parsed BeirDataset
 *
 * @example
 * ```ts
 * import { loadBeirDataset } from "./evals/datasets/beir.js";
 *
 * const ds = await loadBeirDataset("scifact");
 * console.log(ds.corpus.size);  // ~5183
 * console.log(ds.queries.size); // ~300
 * ```
 */
export async function loadBeirDataset(
  name: BeirDatasetName,
  opts?: LoadBeirOptions
): Promise<BeirDataset> {
  const cacheDir = opts?.cacheDir ?? defaultCacheDir();
  const split = opts?.split ?? "test";

  const datasetDir = await ensureCached(name, cacheDir);
  const parsed = await parseBeirDir(datasetDir, split);

  return { name, ...parsed };
}
