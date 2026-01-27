// Main export
export { Minimem, type MinimemConfig, type MinimemSearchResult } from "./minimem.js";

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
} from "./embeddings.js";

// Utilities
export {
  chunkMarkdown,
  hashText,
  listMemoryFiles,
  buildFileEntry,
  cosineSimilarity,
  isMemoryPath,
  normalizeRelPath,
  type MemoryChunk,
  type MemoryFileEntry,
} from "./internal.js";

// Search utilities
export { buildFtsQuery, bm25RankToScore, mergeHybridResults } from "./hybrid.js";

// Batch embedding
export { runOpenAiEmbeddingBatches, type OpenAiBatchRequest } from "./batch-openai.js";
export { runGeminiEmbeddingBatches, type GeminiBatchRequest } from "./batch-gemini.js";

// Tools (for LLM integrations)
export {
  getToolDefinitions,
  createToolExecutor,
  MemoryToolExecutor,
  MEMORY_TOOLS,
  MEMORY_SEARCH_TOOL,
  MEMORY_GET_TOOL,
  MEMORY_WRITE_TOOL,
  MEMORY_APPEND_TOOL,
  MEMORY_LOG_TOOL,
  MEMORY_LIST_TOOL,
  type ToolDefinition,
  type ToolInputSchema,
  type ToolResult,
  type MemorySearchParams,
  type MemoryGetParams,
  type MemoryWriteParams,
  type MemoryAppendParams,
  type MemoryLogParams,
  type MemoryListParams,
} from "./tools.js";

// MCP Server
export {
  McpServer,
  createMcpServer,
  runMcpServer,
  generateMcpConfig,
  type McpServerConfig,
} from "./mcp.js";
