/**
 * LongMemEval dataset loader (thin wrapper over swarmkit-eval's normalized
 * `loadLongMemEval`, with an on-disk cache).
 *
 * The dataset is the *cleaned* LongMemEval_S (~500 questions, ~40 sessions /
 * ~115k tokens per haystack). Download once with:
 *
 *   mkdir -p evals/longmemeval/cache && cd evals/longmemeval/cache
 *   curl -L https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json \
 *     -o longmemeval_s.json
 *
 * Run standalone to verify the loader against the real data:
 *   npx tsx evals/longmemeval/dataset.ts
 */

import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadLongMemEval, type MemQAInstance } from "swarmkit-eval";

const LME_CLEANED_URL =
  "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";

function defaultCacheDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "cache");
}

export interface LoadLongMemEvalOptions {
  /** Cache directory. Defaults to `<repo>/evals/longmemeval/cache`. */
  cacheDir?: string;
  /** Cached filename. Defaults to `longmemeval_s.json`. */
  file?: string;
}

/** Resolve the cached dataset path, erroring with the download hint if absent. */
export function resolveDatasetPath(opts?: LoadLongMemEvalOptions): string {
  const cacheDir = opts?.cacheDir ?? defaultCacheDir();
  const file = opts?.file ?? "longmemeval_s.json";
  const jsonPath = path.join(cacheDir, file);
  if (!fsSync.existsSync(jsonPath)) {
    throw new Error(
      `LongMemEval dataset not found at ${jsonPath}.\n` +
        `Download it first:\n` +
        `  mkdir -p ${cacheDir} && curl -L "${LME_CLEANED_URL}" -o "${jsonPath}"`,
    );
  }
  return jsonPath;
}

/** Load LongMemEval_S into swarmkit-eval's normalized memory-QA model. */
export function loadLongMemEvalCached(opts?: LoadLongMemEvalOptions): MemQAInstance[] {
  return loadLongMemEval(resolveDatasetPath(opts));
}

/**
 * Deterministic, category-stratified down-sample of instances. LongMemEval has
 * exactly one question per instance, so sampling instances == sampling
 * questions. Stratifying by `question_type` keeps every category represented in
 * a small sample. Within a category, we stride for spread (not head-slice).
 */
export function sampleInstances(
  instances: MemQAInstance[],
  maxInstances?: number,
): MemQAInstance[] {
  if (!maxInstances || instances.length <= maxInstances) return instances;

  const byCat = new Map<string, MemQAInstance[]>();
  for (const inst of instances) {
    const cat = inst.questions[0]?.category ?? "unknown";
    const arr = byCat.get(cat) ?? [];
    arr.push(inst);
    byCat.set(cat, arr);
  }

  const cats = [...byCat.keys()].sort();
  const perCat = Math.max(1, Math.floor(maxInstances / cats.length));
  const out: MemQAInstance[] = [];
  for (const cat of cats) {
    const arr = byCat.get(cat)!;
    const take = Math.min(perCat, arr.length);
    const stride = arr.length / take;
    for (let i = 0; i < take && out.length < maxInstances; i++) {
      out.push(arr[Math.floor(i * stride)]!);
    }
  }
  // Top up to maxInstances by round-robin over leftovers (keeps it deterministic).
  if (out.length < maxInstances) {
    const chosen = new Set(out.map((i) => i.id));
    for (const inst of instances) {
      if (out.length >= maxInstances) break;
      if (!chosen.has(inst.id)) out.push(inst);
    }
  }
  return out;
}

// Standalone verification: print dataset shape + category histogram.
if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const instances = loadLongMemEvalCached();
    const catCounts = new Map<string, number>();
    let totalSessions = 0;
    let totalTurns = 0;
    let abstain = 0;
    for (const inst of instances) {
      totalSessions += inst.sessions.length;
      for (const s of inst.sessions) totalTurns += s.turns.length;
      for (const q of inst.questions) {
        catCounts.set(q.category, (catCounts.get(q.category) ?? 0) + 1);
        if (q.abstain) abstain++;
      }
    }
    process.stdout.write(
      `LongMemEval_S: ${instances.length} instances/questions, ${totalSessions} sessions, ${totalTurns} turns total\n`,
    );
    process.stdout.write(
      `  avg sessions/instance: ${(totalSessions / instances.length).toFixed(1)}, ` +
        `avg turns/instance: ${(totalTurns / instances.length).toFixed(1)}, abstain: ${abstain}\n`,
    );
    for (const [cat, n] of [...catCounts.entries()].sort()) {
      process.stdout.write(`  ${cat}: ${n}\n`);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  }
}
