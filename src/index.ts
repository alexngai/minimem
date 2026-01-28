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
} from "./embeddings/embeddings.js";

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
export { buildFtsQuery, bm25RankToScore, mergeHybridResults } from "./search/hybrid.js";

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
