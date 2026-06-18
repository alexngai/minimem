/**
 * Materialize a BEIR corpus into a minimem memory directory.
 *
 * Each corpus document becomes one `memory/<sanitized-id>.md` file
 * (`# title` + body). Returns id↔path maps so chunk-level search results can be
 * mapped back to document ids for qrels-based scoring.
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { BeirDataset } from "../datasets/types.js";

export interface CorpusMaps {
  /** doc _id -> relative memory path (e.g. "memory/doc1.md") */
  idToPath: Map<string, string>;
  /** relative memory path (as minimem returns it) -> doc _id */
  pathToId: Map<string, string>;
}

/** Sanitize a BEIR doc id into a filesystem-safe filename stem. */
export function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return cleaned.length > 0 ? cleaned : "doc";
}

/**
 * Write every corpus document as a markdown file under `<memoryDir>/memory/`.
 * Filenames are collision-safe (a deterministic `_<n>` suffix disambiguates ids
 * that sanitize to the same stem). Writes are batched to bound open file
 * descriptors on large corpora.
 */
export async function materializeCorpus(
  corpus: BeirDataset["corpus"],
  memoryDir: string,
  opts?: { concurrency?: number },
): Promise<CorpusMaps> {
  const concurrency = opts?.concurrency ?? 64;
  const memorySub = path.join(memoryDir, "memory");
  await fs.mkdir(memorySub, { recursive: true });

  const idToPath = new Map<string, string>();
  const pathToId = new Map<string, string>();
  const usedStems = new Set<string>();

  // Plan filenames first (deterministic, single pass) so collisions resolve the
  // same way every run regardless of write concurrency.
  const plan: Array<{ relPath: string; content: string }> = [];
  for (const [id, doc] of corpus) {
    let stem = sanitizeId(id);
    if (usedStems.has(stem)) {
      let n = 1;
      while (usedStems.has(`${stem}_${n}`)) n++;
      stem = `${stem}_${n}`;
    }
    usedStems.add(stem);

    const relPath = `memory/${stem}.md`;
    const title = doc.title?.trim();
    const content = title ? `# ${title}\n\n${doc.text}\n` : `${doc.text}\n`;

    idToPath.set(id, relPath);
    pathToId.set(relPath, id);
    plan.push({ relPath, content });
  }

  for (let i = 0; i < plan.length; i += concurrency) {
    const batch = plan.slice(i, i + concurrency);
    await Promise.all(
      batch.map((p) => fs.writeFile(path.join(memoryDir, p.relPath), p.content)),
    );
  }

  return { idToPath, pathToId };
}
