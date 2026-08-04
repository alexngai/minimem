/**
 * Post-fusion result selection: coverage, quotas, supersession and recency.
 *
 * Hybrid fusion ranks candidates by relevance alone, so the top-k can be k views of the
 * same passage while other facts the query asked for never surface. On a multi-principal
 * memory benchmark that showed up as 70% of one domain's failures retrieving *some but not
 * all* required items — a coverage failure, not a ranking failure.
 *
 * Everything here is opt-in and defaults to the previous behaviour (plain score-ordered
 * truncation), so it can be ablated.
 */

/** Minimal candidate shape; the caller supplies metadata it already has to hand. */
export interface SelectCandidate {
  id: string;
  score: number;
  /** Text used for redundancy comparison. */
  snippet?: string;
  /** Knowledge type, for per-type quotas. */
  knowledgeType?: string | null;
  /** Epoch millis of the note's stated creation date, for recency. */
  createdAt?: number | null;
  /** Knowledge id of a note this one supersedes. */
  supersedes?: string | null;
  /** This note's own knowledge id. */
  knowledgeId?: string | null;
}

export interface SelectOptions {
  limit: number;
  /**
   * Redundancy penalty in [0,1]. 0 (default) preserves pure relevance ordering. Higher
   * values trade relevance for coverage: a candidate's effective score is reduced in
   * proportion to its similarity with what is already selected.
   */
  diversity?: number;
  /** Per-knowledge-type floors, e.g. `{ observation: 20, "domain-summary": 6 }`. */
  quotas?: Record<string, number>;
  /**
   * Drop candidates whose knowledge id is superseded by another candidate in the pool.
   * Answers "what is the CURRENT value" correctly instead of returning either version.
   */
  supersede?: boolean;
  /** Weight in [0,1] blending normalised recency into the score. 0 (default) = off. */
  recency?: number;
}

const WORD = /[a-z0-9]+/g;

/** Cheap lexical overlap. Deliberately not embeddings: this runs per candidate pair. */
function tokens(text: string | undefined): Set<string> {
  if (!text) return new Set();
  return new Set(text.toLowerCase().match(WORD) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Apply selection to fused candidates. Input should be score-ordered and larger than
 * `limit` (the caller over-fetches via candidateMultiplier), otherwise there is nothing
 * to select between.
 */
export function selectResults<T extends SelectCandidate>(
  candidates: T[],
  opts: SelectOptions,
): T[] {
  const limit = Math.max(0, opts.limit);
  if (limit === 0 || candidates.length === 0) return [];

  let pool = candidates;

  // 1. Supersession. A note that another candidate explicitly supersedes is stale; drop it
  //    so "current value" queries cannot be answered from the older version. Only applied
  //    within the candidate pool — a superseding note that did not surface cannot mask one
  //    that did, which is the conservative direction.
  if (opts.supersede) {
    const superseded = new Set<string>();
    for (const c of pool) if (c.supersedes) superseded.add(c.supersedes);
    if (superseded.size > 0) {
      const kept = pool.filter((c) => !(c.knowledgeId && superseded.has(c.knowledgeId)));
      // Never let supersession empty the pool.
      if (kept.length > 0) pool = kept;
    }
  }

  // 2. Recency. Blends normalised age into the score rather than sorting by it, so a much
  //    more relevant older note still outranks a marginally relevant new one.
  const recency = clamp01(opts.recency ?? 0);
  let scored: { c: T; score: number }[] = pool.map((c) => ({ c, score: c.score }));
  if (recency > 0) {
    const stamps = pool.map((c) => c.createdAt).filter((t): t is number => typeof t === "number");
    if (stamps.length > 1) {
      const min = Math.min(...stamps);
      const max = Math.max(...stamps);
      const span = max - min;
      if (span > 0) {
        scored = scored.map(({ c, score }) => {
          const t = typeof c.createdAt === "number" ? (c.createdAt - min) / span : 0.5;
          return { c, score: score * (1 - recency) + t * recency };
        });
        scored.sort((a, b) => b.score - a.score);
      }
    }
  }

  // 3. Quotas. Reserve slots per knowledge type so a blended store cannot be crowded out by
  //    whichever layer happens to rank highest. Unfilled quota slots return to the pool.
  const picked: T[] = [];
  const taken = new Set<string>();
  if (opts.quotas) {
    for (const [type, n] of Object.entries(opts.quotas)) {
      if (n <= 0) continue;
      let count = 0;
      for (const { c } of scored) {
        if (count >= n || picked.length >= limit) break;
        if (taken.has(c.id)) continue;
        if ((c.knowledgeType ?? null) !== type) continue;
        picked.push(c);
        taken.add(c.id);
        count++;
      }
    }
  }

  // 4. Coverage. Greedy maximal-marginal-relevance over what remains: repeatedly take the
  //    candidate whose score, discounted by its similarity to everything already selected,
  //    is highest. With diversity 0 this reduces exactly to score order.
  const lambda = clamp01(opts.diversity ?? 0);
  const remaining = scored.filter(({ c }) => !taken.has(c.id));
  if (lambda === 0) {
    for (const { c } of remaining) {
      if (picked.length >= limit) break;
      picked.push(c);
    }
    return picked;
  }

  const toks = new Map<string, Set<string>>();
  for (const { c } of remaining) toks.set(c.id, tokens(c.snippet));
  const selectedToks: Set<string>[] = picked.map((c) => tokens(c.snippet));
  const pending = [...remaining];
  while (picked.length < limit && pending.length > 0) {
    let bestIdx = 0;
    let bestVal = -Infinity;
    for (let i = 0; i < pending.length; i++) {
      const { c, score } = pending[i];
      const t = toks.get(c.id) ?? new Set();
      let maxSim = 0;
      for (const s of selectedToks) {
        const sim = jaccard(t, s);
        if (sim > maxSim) maxSim = sim;
        if (maxSim >= 1) break;
      }
      const val = score * (1 - lambda) - maxSim * lambda;
      if (val > bestVal) {
        bestVal = val;
        bestIdx = i;
      }
    }
    const [chosen] = pending.splice(bestIdx, 1);
    picked.push(chosen.c);
    selectedToks.push(toks.get(chosen.c.id) ?? new Set());
  }
  return picked;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
