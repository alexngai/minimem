export type HybridSource = string;

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  vectorScore: number;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: HybridSource;
  snippet: string;
  textScore: number;
};

export function buildFtsQuery(raw: string): string | null {
  const tokens =
    raw
      .match(/[A-Za-z0-9_]+/g)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(" AND ");
}

/**
 * Convert BM25 rank from SQLite FTS5 to a 0-1 score.
 *
 * FTS5 BM25 ranks are NEGATIVE numbers where more negative = better match.
 * A rank of 0 means no match, -10 is better than -1.
 *
 * We use absolute value to convert to positive, then normalize to 0-1
 * using the formula: score = 1 / (1 + absRank)
 *
 * Examples:
 * - rank 0 (no match) -> score 1.0
 * - rank -1 (weak match) -> score 0.5
 * - rank -10 (strong match) -> score ~0.09
 *
 * Note: Higher absolute rank magnitude = better match = higher score after conversion.
 */
export function bm25RankToScore(rank: number): number {
  // Handle non-finite values (NaN, Infinity)
  if (!Number.isFinite(rank)) {
    return 0;
  }

  // BM25 ranks from FTS5 are negative (more negative = better match)
  // Use absolute value to get the magnitude
  const absRank = Math.abs(rank);

  // Convert to 0-1 score where higher magnitude = higher score
  // Using 1/(1+x) gives us a nice 0-1 range that decreases smoothly
  return 1 / (1 + absRank);
}

export function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
}): Array<{
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: HybridSource;
}> {
  const byId = new Map<
    string,
    {
      id: string;
      path: string;
      startLine: number;
      endLine: number;
      source: HybridSource;
      snippet: string;
      vectorScore: number;
      textScore: number;
    }
  >();

  for (const r of params.vector) {
    byId.set(r.id, {
      id: r.id,
      path: r.path,
      startLine: r.startLine,
      endLine: r.endLine,
      source: r.source,
      snippet: r.snippet,
      vectorScore: r.vectorScore,
      textScore: 0,
    });
  }

  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet && r.snippet.length > 0) existing.snippet = r.snippet;
    } else {
      byId.set(r.id, {
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: 0,
        textScore: r.textScore,
      });
    }
  }

  // When one side of the hybrid search has no results, normalize weights
  // so the available side scores at full strength. Without this, BM25-only
  // results would be scaled to 0.3 * textScore which is too low to pass
  // the default minScore threshold.
  let vw = params.vectorWeight;
  let tw = params.textWeight;
  if (params.vector.length === 0 && params.keyword.length > 0) {
    vw = 0;
    tw = 1;
  } else if (params.keyword.length === 0 && params.vector.length > 0) {
    vw = 1;
    tw = 0;
  }

  const merged = Array.from(byId.values()).map((entry) => {
    const score = vw * entry.vectorScore + tw * entry.textScore;
    return {
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      score,
      snippet: entry.snippet,
      source: entry.source,
    };
  });

  return merged.sort((a, b) => b.score - a.score);
}
