// Main export
export { Minimem, type MinimemConfig, type MinimemSearchResult } from "./minimem.js";

// Type alias for backward compatibility (some files import SearchResult)
export type { MinimemSearchResult as SearchResult } from "./minimem.js";

// Embedding providers
export {
  createEmbeddingProvider,
  createOpenAiEmbeddingProvider,
  createGeminiEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderOptions,
  type EmbeddingProviderResult,
  type OpenAiEmbeddingClient,
  type GeminiEmbeddingClient,
} from "./embeddings/embeddings.js";

// Utilities
export {
  chunkMarkdown,
  stripPrivateContent,
  extractChunkMetadata,
  hashText,
  listMemoryFiles,
  buildFileEntry,
  cosineSimilarity,
  isMemoryPath,
  type MemoryChunk,
  type MemoryFileEntry,
  type DebugFn,
} from "./internal.js";

// Note: Internal utilities (normalizeRelPath, logError, buildFtsQuery, bm25RankToScore,
// mergeHybridResults) are not exported. Import from source files directly if needed.

// Batch embedding
export { runOpenAiEmbeddingBatches, type OpenAiBatchRequest } from "./embeddings/batch-openai.js";
export { runGeminiEmbeddingBatches, type GeminiBatchRequest } from "./embeddings/batch-gemini.js";

// Tools (for LLM integrations)
export {
  getToolDefinitions,
  createToolExecutor,
  MemoryToolExecutor,
  MEMORY_TOOLS,
  MEMORY_SEARCH_TOOL,
  MEMORY_GET_DETAILS_TOOL,
  KNOWLEDGE_SEARCH_TOOL,
  KNOWLEDGE_GRAPH_TOOL,
  KNOWLEDGE_PATH_TOOL,
  type ToolDefinition,
  type ToolInputSchema,
  type ToolResult,
  type MemorySearchParams,
  type MemoryGetDetailsParams,
  type KnowledgeSearchParams,
  type KnowledgeGraphParams,
  type KnowledgePathParams,
  type MemoryInstance,
} from "./server/tools.js";

// MCP Server
export {
  McpServer,
  createMcpServer,
  runMcpServer,
  generateMcpConfig,
  type McpServerConfig,
} from "./server/mcp.js";

// Session tracking
export {
  parseFrontmatter,
  serializeFrontmatter,
  addFrontmatter,
  addSessionToContent,
  extractSession,
  type SessionContext,
  type MemoryFrontmatter,
  type KnowledgeSource,
  type KnowledgeLink,
} from "./session.js";

// Knowledge search and graph
export {
  type KnowledgeSearchOptions,
  buildKnowledgeFilterSql,
} from "./search/search.js";

export {
  getLinksFrom,
  getLinksTo,
  getNeighbors,
  getPathBetween,
  type GraphLink,
  type GraphNeighbor,
} from "./search/graph.js";

// Core components (for advanced usage and custom integrations)
export {
  MemoryIndexer,
  MemorySearcher,
  type IndexerConfig,
  type SearchConfig,
  type IndexStats,
  type MemoryIndexMeta,
  type SearchResult as CoreSearchResult,
} from "./core/index.js";

// Store graph (multi-store linking)
export {
  StoreGraph,
  loadManifest,
  saveManifest,
  loadStoreLinks,
  saveStoreLinks,
  resolveStore,
  resolveStoreName,
  getLinkedStoreNames,
  getManifestPath,
  materializeStore,
  getRemoteCacheDir,
  listCachedStores,
  clearStoreCache,
  type StoreGraphOptions,
  type ResolvedStore,
  type StoreManifest,
  type StoreDefinition,
  type StoreLinks,
  type MaterializeResult,
} from "./store/index.js";
