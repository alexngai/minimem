import type { DatabaseSync } from "node:sqlite";

import { cosineSimilarity, parseEmbedding, truncateUtf16Safe, vectorToBlob } from "../internal.js";

export type SearchSource = string;

export type SearchRowResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: SearchSource;
};

/**
 * Options for filtering search results by knowledge metadata
 */
export type KnowledgeSearchOptions = {
  /** Filter to chunks matching any of these domains */
  domain?: string[];
  /** Filter to chunks referencing any of these entities */
  entities?: string[];
  /** Minimum confidence threshold */
  minConfidence?: number;
  /** Filter to a specific knowledge type */
  knowledgeType?: string;
};

/**
 * Build SQL WHERE clause fragments for knowledge filters.
 * Uses json_each() for array column filtering.
 */
export function buildKnowledgeFilterSql(opts: KnowledgeSearchOptions): {
  sql: string;
  params: (string | number)[];
} {
  const clauses: string[] = [];
  const params: (string | number)[] = [];

  if (opts.knowledgeType) {
    clauses.push(` AND c.knowledge_type = ?`);
    params.push(opts.knowledgeType);
  }

  if (opts.minConfidence !== undefined) {
    clauses.push(` AND c.confidence >= ?`);
    params.push(opts.minConfidence);
  }

  if (opts.domain && opts.domain.length > 0) {
    // At least one of the provided domains must appear in the JSON array
    const domainPlaceholders = opts.domain.map(() => "?").join(", ");
    clauses.push(
      ` AND EXISTS (SELECT 1 FROM json_each(c.domains) AS d WHERE d.value IN (${domainPlaceholders}))`,
    );
    params.push(...opts.domain);
  }

  if (opts.entities && opts.entities.length > 0) {
    const entityPlaceholders = opts.entities.map(() => "?").join(", ");
    clauses.push(
      ` AND EXISTS (SELECT 1 FROM json_each(c.entities) AS e WHERE e.value IN (${entityPlaceholders}))`,
    );
    params.push(...opts.entities);
  }

  return { sql: clauses.join(""), params };
}

/**
 * Perform a vector similarity search against indexed memory chunks.
 *
 * First attempts to use sqlite-vec for fast approximate nearest neighbor search.
 * Falls back to brute-force cosine similarity over all chunks if the vector
 * extension is unavailable.
 *
 * @returns Matching chunks sorted by descending similarity score (0-1 range).
 */
export async function searchVector(params: {
  db: DatabaseSync;
  vectorTable: string;
  providerModel: string;
  queryVec: number[];
  limit: number;
  snippetMaxChars: number;
  ensureVectorReady: (dimensions: number) => Promise<boolean>;
  sourceFilterVec: { sql: string; params: SearchSource[] };
  sourceFilterChunks: { sql: string; params: SearchSource[] };
  /** Optional metadata WHERE on the chunks alias `c` (from buildKnowledgeFilterSql). */
  knowledgeFilter?: { sql: string; params: (string | number)[] };
}): Promise<SearchRowResult[]> {
  if (params.queryVec.length === 0 || params.limit <= 0) return [];
  const knowledgeSql = params.knowledgeFilter?.sql ?? "";
  const knowledgeParams = params.knowledgeFilter?.params ?? [];
  if (await params.ensureVectorReady(params.queryVec.length)) {
    const rows = params.db
      .prepare(
        `SELECT c.id, c.path, c.start_line, c.end_line, c.text,\n` +
          `       c.source,\n` +
          `       vec_distance_cosine(v.embedding, ?) AS dist\n` +
          `  FROM ${params.vectorTable} v\n` +
          `  JOIN chunks c ON c.id = v.id\n` +
          ` WHERE c.model = ?${params.sourceFilterVec.sql}${knowledgeSql}\n` +
          ` ORDER BY dist ASC\n` +
          ` LIMIT ?`,
      )
      .all(
        vectorToBlob(params.queryVec),
        params.providerModel,
        ...params.sourceFilterVec.params,
        ...knowledgeParams,
        params.limit,
      ) as Array<{
      id: string;
      path: string;
      start_line: number;
      end_line: number;
      text: string;
      source: SearchSource;
      dist: number;
    }>;
    return rows.map((row) => ({
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: 1 - row.dist,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
    }));
  }

  const candidates = listChunks({
    db: params.db,
    providerModel: params.providerModel,
    sourceFilter: params.sourceFilterChunks,
    knowledgeFilter: params.knowledgeFilter,
  });
  const scored = candidates
    .map((chunk) => ({
      chunk,
      score: cosineSimilarity(params.queryVec, chunk.embedding),
    }))
    .filter((entry) => Number.isFinite(entry.score));
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, params.limit)
    .map((entry) => ({
      id: entry.chunk.id,
      path: entry.chunk.path,
      startLine: entry.chunk.startLine,
      endLine: entry.chunk.endLine,
      score: entry.score,
      snippet: truncateUtf16Safe(entry.chunk.text, params.snippetMaxChars),
      source: entry.chunk.source,
    }));
}

/**
 * List all indexed chunks for a given embedding model and source filter.
 * Used as a fallback when sqlite-vec is not available for vector search.
 *
 * @returns All matching chunks with their parsed embedding vectors.
 */
export function listChunks(params: {
  db: DatabaseSync;
  providerModel: string;
  sourceFilter: { sql: string; params: SearchSource[] };
  /** Optional metadata WHERE on the chunks alias `c` (from buildKnowledgeFilterSql). */
  knowledgeFilter?: { sql: string; params: (string | number)[] };
}): Array<{
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
  source: SearchSource;
}> {
  const rows = params.db
    .prepare(
      `SELECT c.id, c.path, c.start_line, c.end_line, c.text, c.embedding, c.source\n` +
        `  FROM chunks c\n` +
        ` WHERE c.model = ?${params.sourceFilter.sql}${params.knowledgeFilter?.sql ?? ""}`,
    )
    .all(
      params.providerModel,
      ...params.sourceFilter.params,
      ...(params.knowledgeFilter?.params ?? []),
    ) as Array<{
    id: string;
    path: string;
    start_line: number;
    end_line: number;
    text: string;
    embedding: string;
    source: SearchSource;
  }>;

  return rows.map((row) => ({
    id: row.id,
    path: row.path,
    startLine: row.start_line,
    endLine: row.end_line,
    text: row.text,
    embedding: parseEmbedding(row.embedding),
    source: row.source,
  }));
}

/**
 * Perform a full-text keyword search using SQLite FTS5 with BM25 ranking.
 *
 * Tokenizes the query into quoted AND terms and runs them against the FTS index.
 * Results are scored using BM25 rank converted to a 0-1 range.
 *
 * @returns Matching chunks sorted by BM25 relevance, with both score and textScore fields.
 */
export async function searchKeyword(params: {
  db: DatabaseSync;
  ftsTable: string;
  providerModel: string;
  query: string;
  limit: number;
  snippetMaxChars: number;
  sourceFilter: { sql: string; params: SearchSource[] };
  buildFtsQuery: (raw: string) => string | null;
  bm25RankToScore: (rank: number) => number;
  /** Optional metadata WHERE on a joined chunks alias `c` (from buildKnowledgeFilterSql). */
  knowledgeFilter?: { sql: string; params: (string | number)[] };
}): Promise<Array<SearchRowResult & { textScore: number }>> {
  if (params.limit <= 0) return [];
  const ftsQuery = params.buildFtsQuery(params.query);
  if (!ftsQuery) return [];

  // When a metadata filter is present, join chunks so its columns are in scope.
  const kf = params.knowledgeFilter;
  const hasKnowledge = !!(kf && kf.sql);
  const sql = hasKnowledge
    ? `SELECT c.id, c.path, c.source, c.start_line, c.end_line, c.text,\n` +
      `       bm25(${params.ftsTable}) AS rank\n` +
      `  FROM ${params.ftsTable}\n` +
      `  JOIN chunks c ON c.id = ${params.ftsTable}.id\n` +
      ` WHERE ${params.ftsTable} MATCH ? AND ${params.ftsTable}.model = ?${params.sourceFilter.sql}${kf!.sql}\n` +
      ` ORDER BY rank ASC\n` +
      ` LIMIT ?`
    : `SELECT id, path, source, start_line, end_line, text,\n` +
      `       bm25(${params.ftsTable}) AS rank\n` +
      `  FROM ${params.ftsTable}\n` +
      ` WHERE ${params.ftsTable} MATCH ? AND model = ?${params.sourceFilter.sql}\n` +
      ` ORDER BY rank ASC\n` +
      ` LIMIT ?`;
  const bindings = hasKnowledge
    ? [ftsQuery, params.providerModel, ...params.sourceFilter.params, ...kf!.params, params.limit]
    : [ftsQuery, params.providerModel, ...params.sourceFilter.params, params.limit];

  const rows = params.db.prepare(sql).all(...bindings) as Array<{
    id: string;
    path: string;
    source: SearchSource;
    start_line: number;
    end_line: number;
    text: string;
    rank: number;
  }>;

  // Per-row BM25 score (monotonic in match strength), then max-normalize across
  // the result set so the best match scores 1.0. BM25 magnitudes are not
  // comparable to cosine (and vary wildly by corpus), so normalizing keeps the
  // text signal on a [0,1] scale for hybrid fusion and the minScore threshold.
  // Normalization is monotonic, so it preserves the BM25 ranking order.
  const scored = rows.map((row) => ({ row, raw: params.bm25RankToScore(row.rank) }));
  const maxRaw = scored.reduce((m, s) => (s.raw > m ? s.raw : m), 0);

  return scored.map(({ row, raw }) => {
    const textScore = maxRaw > 0 ? raw / maxRaw : 0;
    return {
      id: row.id,
      path: row.path,
      startLine: row.start_line,
      endLine: row.end_line,
      score: textScore,
      textScore,
      snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
      source: row.source,
    };
  });
}
