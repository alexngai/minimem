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
import type { AnswerResult, LocomoQuestion } from "../types.js";

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
 *  very large; this bounds prompt cost). Consolidated notes are relevance-ranked
 *  per fact before truncation — see excerptForQuery. */
const MAX_EXCERPT_CHARS = 1200;

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/**
 * Build an excerpt for a note under a char budget.
 *
 * Consolidated entity/domain notes are a `# title` header followed by many
 * `## <id>`-delimited fact sections in CHRONOLOGICAL order. Naive head-truncation
 * keeps only the earliest (usually least relevant) facts and drops the ones that
 * answer the question. Instead: keep the header, then greedily add the fact
 * sections most similar (token overlap) to the question until the budget is hit.
 * Non-consolidated notes (single turns/facts) fall back to head truncation.
 */
function excerptForQuery(body: string, question: string): string {
  if (body.length <= MAX_EXCERPT_CHARS) return body;
  const sections = body.split(/\n(?=##\s)/);
  if (sections.length <= 1) return `${body.slice(0, MAX_EXCERPT_CHARS)}…`;

  const header = /^##\s/.test(sections[0]) ? "" : sections.shift() ?? "";
  const qTokens = tokenize(question);
  const scored = sections.map((s) => {
    let overlap = 0;
    for (const t of tokenize(s)) if (qTokens.has(t)) overlap++;
    return { s, overlap };
  });
  scored.sort((a, b) => b.overlap - a.overlap);

  let out = header ? `${header.trim()}\n` : "";
  for (const { s } of scored) {
    if (out.length + s.length + 1 > MAX_EXCERPT_CHARS) continue;
    out += `${s.trim()}\n`;
  }
  return out.trim();
}
/** Keep all topK notes (cognitive-core drops to 1 note under a tight budget);
 *  per-excerpt truncation above is what actually bounds prompt cost. */
const MAX_KNOWLEDGE_TOKENS = 1_000_000;

export async function answerFromBank(
  state: CogcoreState,
  llm: LlmClient,
  question: LocomoQuestion,
  topK: number,
): Promise<AnswerResult> {
  const matches = await state.kb.getRelevantKnowledge(
    { description: question.question },
    { maxNotes: topK, maxTokens: MAX_KNOWLEDGE_TOKENS },
  );
  const excerpts: RetrievedExcerpt[] = matches.map((m) => {
    const body = m.note.body ?? "";
    const type = (m as { matchType?: string }).matchType ?? "semantic";
    return {
      ref: `${m.note.frontmatter.id} [${type}]`,
      text: excerptForQuery(body, question.question),
    };
  });
  const prompt = buildAnswerPrompt(question, excerpts);
  const { text, usage } = await llm.chat([{ role: "user", content: prompt }]);
  return { text: text.trim(), retrieved: excerpts, ...usage };
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
