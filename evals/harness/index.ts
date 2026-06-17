/**
 * Retrieval eval harness — minimem's DOMAIN pieces only: materialize a BEIR corpus into minimem, run
 * queries → document rankings, and the lexical Jaccard baseline ranker. The generic eval machinery
 * (config matrix, IR metrics + bootstrap CIs, report rendering, regression gate) now lives in
 * **swarmkit-eval**; minimem drives it from `evals/swarmkit/`. See `evals/swarmkit/README.md`.
 */

export { materializeCorpus, sanitizeId, type CorpusMaps } from "./materialize.js";
export {
  openIndex,
  runQueries,
  runDataset,
  type HybridConfig,
  type RankedDoc,
  type OpenIndexOptions,
  type RunQueriesOptions,
  type RunDatasetOptions,
} from "./run.js";
export {
  jaccardRankings,
  textSimilarity,
  jaccardSimilarity,
  ngramSimilarity,
  tokenize,
} from "./jaccard.js";
