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

import {
  KnowledgeBank,
  KeywordExpandingSearchProvider,
  MinimemSearchProvider,
} from "cognitive-core/memory";
import type {
  SearchProvider,
  SearchProviderResult,
} from "cognitive-core/memory";
import { KnowledgeBankConfigSchema } from "cognitive-core";

import { Minimem } from "../../../src/index.js";
import { buildAnswerPrompt, type RetrievedExcerpt } from "../judge.js";
import type { LlmClient } from "../llm.js";
import type { AnswerResult, LocomoQuestion } from "../types.js";

/**
 * Retrieval embedding backend for the cogcore arms:
 * - `local`  — minimem's node-llama-cpp model (embeddinggemma-300M), hybrid RRF
 * - `nomic`  — Ollama `nomic-embed-text` via the OpenAI-compatible endpoint
 *              (apples-to-apples with the mem0 arm), hybrid RRF
 * - `none`   — BM25 full-text only
 */
export type Embeddings = "local" | "none" | "nomic";

/** LLM hook for keyword-expanding retrieval (question → search keywords). */
export type CompletionFn = (prompt: string) => Promise<string>;

const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";

type MinimemArgs = Parameters<typeof Minimem.create>[0];

function embeddingConfig(embeddings: Embeddings): Pick<MinimemArgs, "embedding" | "hybrid"> {
  if (embeddings === "none") {
    return {
      embedding: { provider: "none" },
      hybrid: { enabled: true, vectorWeight: 0, textWeight: 1, ftsQueryMode: "or" },
    };
  }
  if (embeddings === "nomic") {
    return {
      embedding: {
        provider: "openai",
        model: "nomic-embed-text",
        openai: { baseUrl: `${OLLAMA_URL}/v1`, apiKey: "ollama" },
      },
      hybrid: { enabled: true, fusion: "rrf" },
    };
  }
  return {
    embedding: { provider: "local" },
    hybrid: { enabled: true, fusion: "rrf" },
  };
}

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
  /** When set, wrap retrieval in a keyword-expansion pass (question → keywords). */
  keywordExpansion?: CompletionFn,
  /** When set, wrap retrieval in MMR diversity re-ranking over a wide pool. */
  mmr?: MmrConfig,
): Promise<void> {
  const mm = await Minimem.create({
    memoryDir: state.memoryDir,
    dbPath: path.join(state.dir, "index.db"),
    ...embeddingConfig(embeddings),
    query: { maxResults: mmr ? Math.max(mmr.poolSize, topK) : topK, minScore: 0 },
    watch: { enabled: false },
  });
  await mm.sync({ reason: "ingest" });
  state.mm = mm;

  const provider = new MinimemSearchProvider({
    search: (query, options) => mm.search(query, { ...options, skipStaleCheck: true }),
  });
  let searchProvider: SearchProvider = provider;
  if (keywordExpansion) {
    searchProvider = new KeywordExpandingSearchProvider(searchProvider, keywordExpansion);
  }
  if (mmr) {
    searchProvider = new MmrSearchProvider(searchProvider, mmr);
  }
  state.kb.setSearchProvider(searchProvider);
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

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Minimal note shape the MMR re-ranker needs (id + body for redundancy). */
interface NoteLike {
  frontmatter: { id: string };
  body?: string;
}

export interface MmrConfig {
  /** Relevance vs diversity trade-off (1 = pure relevance, 0 = pure diversity). */
  lambda: number;
  /** Candidate pool pulled from the inner provider before MMR selection. */
  poolSize: number;
}

/**
 * Maximal Marginal Relevance re-ranker (decorator over any SearchProvider).
 *
 * The recall diagnostic showed multi-hop evidence is retrievable (95% @k=50) but
 * crowded out of the top-k by redundant near-duplicate hits (73% @k=10). MMR pulls
 * a wide pool from the inner provider, then greedily selects k items maximizing
 *   lambda * relevance - (1 - lambda) * max lexical similarity to already-picked,
 * so a second-hop turn displaces a redundant restatement of the first hop.
 *
 * Redundancy is lexical (token Jaccard on note bodies) — no embedding access
 * needed since the KnowledgeBank hands us the candidate notes directly.
 */
export class MmrSearchProvider implements SearchProvider {
  readonly name: string;
  constructor(
    private readonly inner: SearchProvider,
    private readonly config: MmrConfig,
  ) {
    this.name = `mmr(${inner.name})`;
  }

  async search(
    query: string,
    candidates: NoteLike[],
    options?: { maxResults?: number },
  ): Promise<SearchProviderResult[]> {
    const k = options?.maxResults ?? 10;
    const pool = await this.inner.search(query, candidates as never, {
      ...options,
      maxResults: Math.max(this.config.poolSize, k),
    });
    if (pool.length <= k) return pool;

    const bodyById = new Map<string, string>();
    for (const c of candidates) bodyById.set(c.frontmatter.id, c.body ?? "");
    const tokCache = new Map<string, Set<string>>();
    const toks = (id: string): Set<string> => {
      let t = tokCache.get(id);
      if (!t) {
        t = tokenize(bodyById.get(id) ?? "");
        tokCache.set(id, t);
      }
      return t;
    };

    // Normalize relevance to [0,1] across the pool so lambda is comparable to
    // the [0,1] Jaccard redundancy term.
    const scores = pool.map((p) => p.score);
    const min = Math.min(...scores);
    const range = Math.max(...scores) - min || 1;
    const norm = (s: number): number => (s - min) / range;

    const selected: SearchProviderResult[] = [];
    const remaining = [...pool];
    const { lambda } = this.config;
    while (selected.length < k && remaining.length > 0) {
      let bestIdx = 0;
      let bestScore = -Infinity;
      for (let i = 0; i < remaining.length; i++) {
        const cand = remaining[i];
        let maxSim = 0;
        for (const sel of selected) {
          const sim = jaccard(toks(cand.noteId), toks(sel.noteId));
          if (sim > maxSim) maxSim = sim;
        }
        const mmr = lambda * norm(cand.score) - (1 - lambda) * maxSim;
        if (mmr > bestScore) {
          bestScore = mmr;
          bestIdx = i;
        }
      }
      selected.push(remaining.splice(bestIdx, 1)[0]);
    }
    return selected;
  }
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

/** A retrieval match with the fields the multi-query merge needs. */
interface KnowMatch {
  note: { body?: string; frontmatter: { id: string } };
  matchType?: string;
  score?: number;
}

/**
 * Decompose a question into the minimal set of standalone lookup queries needed
 * to answer it. Multi-hop questions ("which city did BOTH X and Y visit?") need
 * each hop retrieved separately — a single embedding of the whole question tends
 * to surface one hop and bury the other. Returns the original question plus any
 * sub-queries (deduped). Falls back to just the original on any LLM/parse error.
 */
async function decomposeQuestion(llm: LlmClient, question: string): Promise<string[]> {
  try {
    const { text } = await llm.chat([
      {
        role: "user",
        content: [
          "Decide whether a question needs MULTIPLE separate memory lookups to answer.",
          "Most questions do NOT — return them unchanged as a single-element array.",
          "ONLY split when the answer requires combining facts about DIFFERENT subjects/events",
          "that would be stored separately (comparisons, intersections, or two distinct people/things).",
          "When you split, write one self-contained query per hop (resolve pronouns to names). Max 4.",
          "",
          "Examples:",
          'Q: "What kind of pot did Mel make?" → ["What kind of pot did Mel make?"]',
          'Q: "When did Caroline join the support group?" → ["When did Caroline join the support group?"]',
          'Q: "Which city did both Ann and Bob visit?" → ["Which cities has Ann visited?", "Which cities has Bob visited?"]',
          'Q: "What hobby do Jon and his daughter share?" → ["What are Jon\'s hobbies?", "What are Jon\'s daughter\'s hobbies?"]',
          "",
          "Return ONLY a JSON array of strings.",
          "",
          `Question: ${question}`,
        ].join("\n"),
      },
    ]);
    const arr = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
    if (Array.isArray(arr)) {
      const qs = arr.filter((s): s is string => typeof s === "string" && s.trim().length > 0);
      const seen = new Set<string>();
      const out: string[] = [];
      for (const q of [question, ...qs]) {
        const k = q.trim().toLowerCase();
        if (!seen.has(k)) {
          seen.add(k);
          out.push(q.trim());
        }
      }
      return out.slice(0, 5);
    }
  } catch {
    // Fall back to single-query.
  }
  return [question];
}

/**
 * Multi-query variant of {@link answerFromBank}: decompose the question, retrieve
 * for each sub-query, then interleave-dedupe (round-robin) so EACH hop is
 * represented in the final top-`topK` context even at a fixed budget. This targets
 * multi_hop, where single-query retrieval surfaces one hop and buries the other.
 */
export async function answerFromBankMultiQuery(
  state: CogcoreState,
  llm: LlmClient,
  question: LocomoQuestion,
  topK: number,
): Promise<AnswerResult> {
  const subQueries = await decomposeQuestion(llm, question.question);
  // Single query → identical to the plain path (avoids extra retrieval cost).
  if (subQueries.length === 1) return answerFromBank(state, llm, question, topK);

  const perQuery = await Promise.all(
    subQueries.map((q) =>
      state.kb.getRelevantKnowledge(
        { description: q },
        { maxNotes: topK, maxTokens: MAX_KNOWLEDGE_TOKENS },
      ) as Promise<KnowMatch[]>,
    ),
  );

  // Round-robin interleave across sub-queries, deduping by note id, until topK.
  const seen = new Set<string>();
  const merged: KnowMatch[] = [];
  for (let rank = 0; merged.length < topK; rank++) {
    let advanced = false;
    for (const list of perQuery) {
      if (rank < list.length) {
        advanced = true;
        const m = list[rank];
        const id = m.note.frontmatter.id;
        if (!seen.has(id)) {
          seen.add(id);
          merged.push(m);
          if (merged.length >= topK) break;
        }
      }
    }
    if (!advanced) break;
  }

  const excerpts: RetrievedExcerpt[] = merged.map((m) => {
    const body = m.note.body ?? "";
    const type = m.matchType ?? "semantic";
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
  await state.mm?.close?.();
  await fs.rm(state.dir, { recursive: true, force: true }).catch(() => {});
}

export function defaultScratchRoot(): string {
  return os.tmpdir();
}
