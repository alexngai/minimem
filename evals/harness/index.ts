/**
 * Retrieval eval harness. Materializes a BEIR corpus into minimem, runs queries,
 * aggregates chunk hits to document rankings (W3), scores them against qrels and
 * compares to a lexical baseline (W4).
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
  scoreRankings,
  dcg,
  ndcgAtK,
  recallAtK,
  reciprocalRankAtK,
  hitAtK,
  mean,
  bootstrapCI,
  mulberry32,
  type AggregateScore,
  type MetricStat,
  type ScoreOptions,
} from "./metrics.js";
export {
  jaccardRankings,
  textSimilarity,
  jaccardSimilarity,
  ngramSimilarity,
  tokenize,
} from "./jaccard.js";
export { formatMarkdown, toJSON, type ConfigResult, type ReportOptions } from "./report.js";
export {
  runMatrix,
  needsVector,
  P0_CONFIGS,
  BM25_CONFIGS,
  type ConfigSpec,
  type RunMatrixOptions,
  type MatrixOutcome,
} from "./matrix.js";
export {
  checkRegression,
  buildBaseline,
  baselineKey,
  type Baseline,
  type GateResult,
} from "./gate.js";
