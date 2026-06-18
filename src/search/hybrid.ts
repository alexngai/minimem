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

export type FtsQueryMode = "and" | "or";

export function buildFtsQuery(raw: string, mode: FtsQueryMode = "or"): string | null {
  const tokens =
    raw
      .match(/[A-Za-z0-9_]+/g)
      ?.map((t) => t.trim())
      .filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  const quoted = tokens.map((t) => `"${t.replaceAll('"', "")}"`);
  return quoted.join(mode === "or" ? " OR " : " AND ");
}

/**
 * Convert an FTS5 BM25 rank into a 0–1 relevance score (higher = better).
 *
 * FTS5 `bm25()` returns NEGATIVE values where more-negative = better match, and
 * the SQL orders `rank ASC` (best first). The score must therefore INCREASE with
 * match strength (|rank|) so it combines correctly with cosine similarity in the
 * weighted hybrid merge (which sorts by score DESC). The previous `1/(1+|rank|)`
 * was inverted — it ranked the strongest BM25 matches LAST, making weighted-hybrid
 * and pure-BM25 ranking near-random (BEIR/SciFact nDCG@10 ~0.01 vs ~0.66).
 *
 * score = |rank| / (1 + |rank|): 0 for no signal, →1 for a strong match,
 * monotonically increasing in |rank| (preserving the SQL best-first order).
 *
 * Examples:
 * - rank 0    -> 0.0   (no relevance signal)
 * - rank -1   -> 0.5   (weak match)
 * - rank -10  -> ~0.91 (strong match)
 */
export function bm25RankToScore(rank: number): number {
  // Handle non-finite values (NaN, Infinity)
  if (!Number.isFinite(rank)) {
    return 0;
  }

  // FTS5 BM25 ranks are negative (more negative = better match); use magnitude.
  const absRank = Math.abs(rank);

  // Monotonically increasing in match strength, bounded to [0, 1).
  return absRank / (1 + absRank);
}

export type FusionStrategy = "weighted" | "rrf";

export function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  /** Fusion strategy: "weighted" (default) blends scores; "rrf" fuses by rank. */
  fusion?: FusionStrategy;
  /** RRF rank constant (default: 60). Only used when fusion === "rrf". */
  rrfK?: number;
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

  const fusion = params.fusion ?? "weighted";

  if (fusion === "rrf") {
    // Reciprocal Rank Fusion: scale-free, fuses by rank position rather than
    // by blending incomparable cosine and BM25 magnitudes. The input arrays
    // are already sorted best-first, so their index is the rank. Raw RRF scores
    // are tiny (~1/k), so we max-normalize within the result set (best = 1.0),
    // keeping scores on a [0,1] scale comparable to cosine and the minScore
    // threshold. Normalization is monotonic, so it preserves the RRF order.
    const k = params.rrfK ?? 60;
    const vRank = new Map<string, number>();
    params.vector.forEach((r, i) => {
      if (!vRank.has(r.id)) vRank.set(r.id, i);
    });
    const kRank = new Map<string, number>();
    params.keyword.forEach((r, i) => {
      if (!kRank.has(r.id)) kRank.set(r.id, i);
    });
    const fused = Array.from(byId.values()).map((entry) => {
      const vr = vRank.get(entry.id);
      const kr = kRank.get(entry.id);
      const raw =
        (vr !== undefined ? 1 / (k + vr + 1) : 0) +
        (kr !== undefined ? 1 / (k + kr + 1) : 0);
      return { entry, raw };
    });
    const maxRaw = fused.reduce((m, f) => (f.raw > m ? f.raw : m), 0);
    return fused
      .map(({ entry, raw }) => ({
        path: entry.path,
        startLine: entry.startLine,
        endLine: entry.endLine,
        score: maxRaw > 0 ? raw / maxRaw : 0,
        snippet: entry.snippet,
        source: entry.source,
      }))
      .sort((a, b) => b.score - a.score);
  }

  // Weighted-sum fusion (default).
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
