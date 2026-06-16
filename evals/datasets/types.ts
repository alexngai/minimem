/**
 * Types for loaded BEIR datasets.
 *
 * A BeirDataset is the fully-parsed, in-memory representation of one BEIR
 * benchmark corpus: documents, queries, and relevance judgments.
 */

export interface BeirDataset {
  /** Dataset name (e.g. "scifact", "nfcorpus", "arguana") */
  name: string;

  /**
   * Corpus documents, keyed by document _id.
   * Each entry has a title and body text.
   */
  corpus: Map<string, { title: string; text: string }>;

  /**
   * Queries, keyed by query _id.
   * Value is the raw query string.
   */
  queries: Map<string, string>;

  /**
   * Relevance judgments (qrels), keyed by query _id.
   * Inner map: document _id → relevance score (typically 0, 1, or 2).
   */
  qrels: Map<string, Map<string, number>>;
}
