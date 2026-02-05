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
  type ToolDefinition,
  type ToolInputSchema,
  type ToolResult,
  type MemorySearchParams,
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
} from "./session.js";
