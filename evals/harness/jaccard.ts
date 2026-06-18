/**
 * Lexical Jaccard baseline (W4) — the bar minimem must beat.
 *
 * Faithfully replicates cognitive-core's default `TextSimilaritySearchProvider`
 * (utils/similarity.ts): textSimilarity = 0.6 * tokenJaccard + 0.4 * trigramJaccard,
 * scored over each document's text. Kept in-repo so the comparison needs no
 * cognitive-core dependency.
 */

import type { BeirDataset } from "../datasets/types.js";
import type { RankedDoc } from "./run.js";

/** Lowercase, strip punctuation to spaces, split on whitespace. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

function getNgrams(text: string, n: number): Set<string> {
  const ngrams = new Set<string>();
  const s = text.toLowerCase();
  for (let i = 0; i <= s.length - n; i++) ngrams.add(s.slice(i, i + n));
  return ngrams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  // iterate the smaller set
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (large.has(x)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function jaccardSimilarity(a: string, b: string): number {
  return jaccard(new Set(tokenize(a)), new Set(tokenize(b)));
}

export function ngramSimilarity(a: string, b: string, n = 3): number {
  return jaccard(getNgrams(a, n), getNgrams(b, n));
}

/** Combined similarity — identical weights to cognitive-core's textSimilarity. */
export function textSimilarity(a: string, b: string): number {
  return jaccardSimilarity(a, b) * 0.6 + ngramSimilarity(a, b) * 0.4;
}

/**
 * Rank every corpus document against each query by `textSimilarity`, returning
 * per-query rankings in the same shape as the minimem harness (`runQueries`).
 * Document representations are precomputed once to avoid O(Q×D) re-tokenization.
 */
export function jaccardRankings(dataset: BeirDataset, k = 10): Map<string, RankedDoc[]> {
  const docs = [...dataset.corpus.entries()].map(([id, d]) => {
    const text = `${d.title} ${d.text}`;
    return { id, tokens: new Set(tokenize(text)), trigrams: getNgrams(text, 3) };
  });

  const rankings = new Map<string, RankedDoc[]>();
  for (const [qid, q] of dataset.queries) {
    const qTokens = new Set(tokenize(q));
    const qTrigrams = getNgrams(q, 3);
    const scored = docs
      .map((d) => ({
        docId: d.id,
        score: jaccard(qTokens, d.tokens) * 0.6 + jaccard(qTrigrams, d.trigrams) * 0.4,
      }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
    rankings.set(qid, scored);
  }
  return rankings;
}
