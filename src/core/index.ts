/**
 * Core module - Indexer and Searcher components
 *
 * These classes extract indexing and search concerns from the Minimem class
 * to improve separation of concerns and testability.
 */

export { MemoryIndexer, type IndexerConfig, type MemoryIndexMeta, type IndexStats } from "./indexer.js";
export { MemorySearcher, type SearchConfig, type SearchResult } from "./searcher.js";
