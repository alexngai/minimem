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
