/**
 * LOCOMO dataset loader with on-disk cache.
 *
 * Downloads and caches `locomo10.json` from the canonical public source:
 *   https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
 *
 * The first run requires network access; subsequent runs use the cache and
 * work offline.
 *
 * Run standalone to verify the loader against the real data:
 *   npx tsx evals/locomo/dataset.ts
 */

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  ADVERSARIAL_CATEGORY_ID,
  CATEGORY_BY_ID,
  type LocomoConversation,
  type LocomoQuestion,
  type LocomoRawConversation,
  type LocomoRawQA,
  type LocomoRawSample,
  type LocomoRawTurn,
  type LocomoSession,
  type LocomoTurn,
} from "./types.js";

const LOCOMO_URL =
  "https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json";

export interface LoadLocomoOptions {
  /** Cache directory. Defaults to `<repo>/evals/locomo/cache`. */
  cacheDir?: string;
  /** Override the download URL (e.g. a mirror). */
  url?: string;
}

function defaultCacheDir(): string {
  const thisFile = new URL(import.meta.url).pathname;
  return path.join(path.dirname(thisFile), "cache");
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error(`No response body for ${url}`);
  }
  const handle = await fs.open(destPath, "w");
  try {
    const writer = handle.createWriteStream();
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      writer,
    );
  } finally {
    await handle.close();
  }
}

async function ensureCached(cacheDir: string, url: string): Promise<string> {
  const jsonPath = path.join(cacheDir, "locomo10.json");
  if (fsSync.existsSync(jsonPath)) return jsonPath;

  await fs.mkdir(cacheDir, { recursive: true });
  process.stderr.write(`[locomo] Downloading dataset from ${url}...\n`);
  await downloadFile(url, jsonPath);
  process.stderr.write(`[locomo] Cached at ${jsonPath}\n`);
  return jsonPath;
}

/**
 * Extract sessions from the dynamic-keyed raw conversation object.
 * Keys look like `session_1`, `session_1_date_time`, `session_2`, ...
 */
function parseSessions(raw: LocomoRawConversation): LocomoSession[] {
  const sessions: LocomoSession[] = [];

  for (const key of Object.keys(raw)) {
    // Match a bare session key (not the *_date_time / *_observation / *_summary variants)
    const match = /^session_(\d+)$/.exec(key);
    if (!match) continue;

    const index = Number.parseInt(match[1], 10);
    const turnsRaw = raw[key] as LocomoRawTurn[] | undefined;
    if (!Array.isArray(turnsRaw)) continue;

    const dateTime = (raw[`session_${index}_date_time`] as string | undefined) ?? "";
    const turns: LocomoTurn[] = turnsRaw.map((t) => ({
      speaker: t.speaker,
      diaId: t.dia_id,
      text: t.text,
      ...(t.blip_caption ? { imageCaption: t.blip_caption } : {}),
    }));

    sessions.push({ index, dateTime, turns });
  }

  sessions.sort((a, b) => a.index - b.index);
  return sessions;
}

function parseQuestion(raw: LocomoRawQA, id: string): LocomoQuestion {
  const isAdversarial = raw.category === ADVERSARIAL_CATEGORY_ID;
  const goldRaw = isAdversarial ? raw.adversarial_answer : raw.answer;
  return {
    id,
    question: raw.question,
    answer: goldRaw === undefined || goldRaw === null ? "" : String(goldRaw),
    evidence: raw.evidence ?? [],
    category: CATEGORY_BY_ID[raw.category] ?? "single_hop",
    categoryId: raw.category,
    isAdversarial,
  };
}

/** Parse an already-downloaded locomo10.json into normalized conversations. */
export function parseLocomo(rawSamples: LocomoRawSample[]): LocomoConversation[] {
  return rawSamples.map((sample) => {
    const questions = sample.qa.map((qa, i) =>
      parseQuestion(qa, `${sample.sample_id}#${i}`),
    );
    return {
      sampleId: sample.sample_id,
      speakerA: sample.conversation.speaker_a,
      speakerB: sample.conversation.speaker_b,
      sessions: parseSessions(sample.conversation),
      questions,
    };
  });
}

/**
 * Load LOCOMO, downloading + caching on first run.
 *
 * @returns 10 normalized conversations with flattened sessions and QA.
 */
export async function loadLocomo(
  opts?: LoadLocomoOptions,
): Promise<LocomoConversation[]> {
  const cacheDir = opts?.cacheDir ?? defaultCacheDir();
  const url = opts?.url ?? LOCOMO_URL;
  const jsonPath = await ensureCached(cacheDir, url);
  const content = await fs.readFile(jsonPath, "utf-8");
  const rawSamples = JSON.parse(content) as LocomoRawSample[];
  return parseLocomo(rawSamples);
}

/** Total number of turns across all sessions in a conversation. */
export function turnCount(conversation: LocomoConversation): number {
  return conversation.sessions.reduce((n, s) => n + s.turns.length, 0);
}

// Standalone verification: print dataset shape + category histogram.
if (import.meta.url === `file://${process.argv[1]}`) {
  loadLocomo()
    .then((conversations) => {
      const catCounts = new Map<string, number>();
      let totalQ = 0;
      let totalTurns = 0;
      for (const c of conversations) {
        totalTurns += turnCount(c);
        for (const q of c.questions) {
          totalQ++;
          catCounts.set(q.category, (catCounts.get(q.category) ?? 0) + 1);
        }
      }
      process.stdout.write(
        `LOCOMO: ${conversations.length} conversations, ${totalQ} QA, ${totalTurns} turns total\n`,
      );
      process.stdout.write(
        `Sessions/conv: ${conversations.map((c) => c.sessions.length).join(", ")}\n`,
      );
      for (const [cat, n] of [...catCounts.entries()].sort()) {
        process.stdout.write(`  ${cat}: ${n}\n`);
      }
    })
    .catch((err) => {
      process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
      process.exit(1);
    });
}
