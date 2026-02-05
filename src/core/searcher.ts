/**
 * MemorySearcher - Handles search operations
 *
 * Responsible for:
 * - Executing vector searches
 * - Executing keyword (FTS) searches
 * - Merging results with hybrid scoring
 */

import type { DatabaseSync } from "node:sqlite";

import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "../search/hybrid.js";
import { searchKeyword, searchVector } from "../search/search.js";
import type { EmbeddingProvider } from "../embeddings/embeddings.js";
import type { DebugFn } from "../internal.js";

const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;

export type SearchConfig = {
  hybrid: {
    enabled: boolean;
    vectorWeight: number;
    textWeight: number;
    candidateMultiplier: number;
  };
  query: {
    maxResults: number;
    minScore: number;
  };
  debug?: DebugFn;
};

export type SearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
};

/**
 * MemorySearcher handles search queries against the indexed memory
 */
export class MemorySearcher {
  private readonly db: DatabaseSync;
  private readonly provider: EmbeddingProvider;
  private readonly config: SearchConfig;

  // State from parent
  private vectorState: {
    available: boolean;
    dims?: number;
  };
  private ftsAvailable: boolean;

  // Callback to ensure vector is ready
  private ensureVectorReadyFn?: (dims?: number) => Promise<boolean>;

  constructor(
    db: DatabaseSync,
    provider: EmbeddingProvider,
    config: SearchConfig,
    options?: {
      vectorState?: { available: boolean; dims?: number };
      ftsAvailable?: boolean;
      ensureVectorReady?: (dims?: number) => Promise<boolean>;
    }
  ) {
    this.db = db;
    this.provider = provider;
    this.config = config;
    this.vectorState = options?.vectorState ?? { available: false };
    this.ftsAvailable = options?.ftsAvailable ?? false;
    this.ensureVectorReadyFn = options?.ensureVectorReady;
  }

  /**
   * Update vector/FTS availability (called by parent when extensions load)
   */
  setVectorState(state: { available: boolean; dims?: number }): void {
    this.vectorState = state;
  }

  setFtsAvailable(available: boolean): void {
    this.ftsAvailable = available;
  }

  /**
   * Execute a search query
   */
  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number }
  ): Promise<SearchResult[]> {
    const cleaned = query.trim();
    if (!cleaned) return [];

    const minScore = opts?.minScore ?? this.config.query.minScore;
    const maxResults = opts?.maxResults ?? this.config.query.maxResults;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * this.config.hybrid.candidateMultiplier))
    );

    const sourceFilter = { sql: "", params: [] as string[] };

    // Execute keyword search if hybrid is enabled
    const keywordResults =
      this.config.hybrid.enabled && this.ftsAvailable
        ? await searchKeyword({
            db: this.db,
            ftsTable: FTS_TABLE,
            providerModel: this.provider.model,
            query: cleaned,
            limit: candidates,
            snippetMaxChars: SNIPPET_MAX_CHARS,
            sourceFilter,
            buildFtsQuery,
            bm25RankToScore,
          }).catch(() => [])
        : [];

    // Embed query and execute vector search
    const queryVec = await this.embedQueryWithTimeout(cleaned);
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await searchVector({
          db: this.db,
          vectorTable: VECTOR_TABLE,
          providerModel: this.provider.model,
          queryVec,
          limit: candidates,
          snippetMaxChars: SNIPPET_MAX_CHARS,
          ensureVectorReady: (dims) => this.ensureVectorReady(dims),
          sourceFilterVec: sourceFilter,
          sourceFilterChunks: sourceFilter,
        }).catch(() => [])
      : [];

    // If hybrid is disabled, return vector results only
    if (!this.config.hybrid.enabled) {
      return vectorResults
        .filter((entry) => entry.score >= minScore)
        .slice(0, maxResults)
        .map((r) => ({
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          score: r.score,
          snippet: r.snippet,
        }));
    }

    // Merge results with hybrid scoring
    const merged = mergeHybridResults({
      vector: vectorResults.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
      })),
      keyword: keywordResults.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
      })),
      vectorWeight: this.config.hybrid.vectorWeight,
      textWeight: this.config.hybrid.textWeight,
    });

    return merged
      .filter((entry) => entry.score >= minScore)
      .slice(0, maxResults)
      .map((r) => ({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        snippet: r.snippet,
      }));
  }

  /**
   * Embed a query string with timeout
   */
  private async embedQueryWithTimeout(text: string): Promise<number[]> {
    const timeout =
      this.provider.id === "local"
        ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS
        : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;

    return Promise.race([
      this.provider.embedQuery(text),
      new Promise<number[]>((_, reject) =>
        setTimeout(() => reject(new Error("embedding query timeout")), timeout)
      ),
    ]);
  }

  /**
   * Ensure vector extension is ready
   */
  private async ensureVectorReady(dims?: number): Promise<boolean> {
    if (this.vectorState.available) return true;
    if (this.ensureVectorReadyFn) {
      return this.ensureVectorReadyFn(dims);
    }
    return false;
  }
}
