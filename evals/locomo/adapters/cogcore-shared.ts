/**
 * Shared plumbing for the cognitive-core arms (`cogcore-retrieval`,
 * `cogcore-memory`): open a memory-only KnowledgeBank, index its note files
 * with THIS repo's minimem (injected as the SearchProvider), retrieve, answer.
 *
 * cognitive-core is used memory-only — no PlaybookLibrary, no learning pipeline.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { KnowledgeBank, MinimemSearchProvider } from "cognitive-core/memory";
import { KnowledgeBankConfigSchema } from "cognitive-core";

import { Minimem } from "../../../src/index.js";
import { buildAnswerPrompt, type RetrievedExcerpt } from "../judge.js";
import type { LlmClient } from "../llm.js";
import type { LocomoQuestion, UsageStats } from "../types.js";

export type Embeddings = "local" | "none";

export interface CogcoreState {
  dir: string;
  memoryDir: string;
  kb: InstanceType<typeof KnowledgeBank>;
  mm: Minimem | null;
}

/** Create a scratch dir + an initialized, memory-only KnowledgeBank. */
export async function openBank(scratchRoot: string, prefix: string): Promise<CogcoreState> {
  const dir = await fs.mkdtemp(path.join(scratchRoot, prefix));
  const memoryDir = path.join(dir, "memory");
  const cfg = KnowledgeBankConfigSchema.parse({ enabled: true });
  const kb = new KnowledgeBank(memoryDir, cfg);
  await kb.init();
  return { dir, memoryDir, kb, mm: null };
}

/**
 * Index the KnowledgeBank's note files with minimem and inject minimem as the
 * bank's search provider. Call AFTER all notes (and any defrag) are written.
 */
export async function indexAndInject(
  state: CogcoreState,
  embeddings: Embeddings,
  topK: number,
): Promise<void> {
  const mm = await Minimem.create({
    memoryDir: state.memoryDir,
    dbPath: path.join(state.dir, "index.db"),
    embedding: embeddings === "local" ? { provider: "local" } : { provider: "none" },
    hybrid:
      embeddings === "local"
        ? { enabled: true, fusion: "rrf" }
        : { enabled: true, vectorWeight: 0, textWeight: 1, ftsQueryMode: "or" },
    query: { maxResults: topK, minScore: 0 },
    watch: { enabled: false },
  });
  await mm.sync({ reason: "ingest" });
  state.mm = mm;

  state.kb.setSearchProvider(
    new MinimemSearchProvider({
      search: (query, options) => mm.search(query, { ...options, skipStaleCheck: true }),
    }),
  );
}

/** Retrieve relevant knowledge and have the LLM answer. */
/** Hard cap on a single excerpt's characters (consolidated entity notes can be
 *  very large; this bounds prompt cost while keeping each note's leading facts). */
const MAX_EXCERPT_CHARS = 1200;
/** Keep all topK notes (cognitive-core drops to 1 note under a tight budget);
 *  per-excerpt truncation above is what actually bounds prompt cost. */
const MAX_KNOWLEDGE_TOKENS = 1_000_000;

export async function answerFromBank(
  state: CogcoreState,
  llm: LlmClient,
  question: LocomoQuestion,
  topK: number,
): Promise<{ text: string } & UsageStats> {
  const matches = await state.kb.getRelevantKnowledge(
    { description: question.question },
    { maxNotes: topK, maxTokens: MAX_KNOWLEDGE_TOKENS },
  );
  const excerpts: RetrievedExcerpt[] = matches.map((m) => {
    const body = m.note.body ?? "";
    return {
      ref: m.note.frontmatter.id,
      text: body.length > MAX_EXCERPT_CHARS ? `${body.slice(0, MAX_EXCERPT_CHARS)}…` : body,
    };
  });
  const prompt = buildAnswerPrompt(question, excerpts);
  const { text, usage } = await llm.chat([{ role: "user", content: prompt }]);
  return { text: text.trim(), ...usage };
}

export async function closeBank(state: CogcoreState | null): Promise<void> {
  if (!state) return;
  await state.kb.close?.();
  state.mm?.close?.();
  await fs.rm(state.dir, { recursive: true, force: true }).catch(() => {});
}

export function defaultScratchRoot(): string {
  return os.tmpdir();
}
