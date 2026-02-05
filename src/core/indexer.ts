/**
 * MemoryIndexer - Handles file indexing and embedding management
 *
 * Responsible for:
 * - Processing memory files into chunks
 * - Computing and caching embeddings
 * - Managing file records in the database
 * - Detecting stale content
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import {
  buildFileEntry,
  chunkMarkdown,
  hashText,
  listMemoryFiles,
  type MemoryChunk,
  type MemoryFileEntry,
  parseEmbedding,
  vectorToBlob,
  type DebugFn,
} from "../internal.js";
import type {
  EmbeddingProvider,
  OpenAiEmbeddingClient,
  GeminiEmbeddingClient,
} from "../embeddings/embeddings.js";
import {
  runOpenAiEmbeddingBatches,
  type OpenAiBatchRequest,
  OPENAI_BATCH_ENDPOINT,
} from "../embeddings/batch-openai.js";
import { runGeminiEmbeddingBatches, type GeminiBatchRequest } from "../embeddings/batch-gemini.js";

const META_KEY = "memory_index_meta_v1";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;

export type IndexerConfig = {
  memoryDir: string;
  chunking: { tokens: number; overlap: number };
  cache: { enabled: boolean; maxEntries: number };
  batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  ftsEnabled: boolean;
  debug?: DebugFn;
};

export type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
};

export type IndexStats = {
  filesProcessed: number;
  chunksCreated: number;
  staleRemoved: number;
};

/**
 * MemoryIndexer handles file indexing, chunking, and embedding management
 */
export class MemoryIndexer {
  private readonly config: IndexerConfig;
  private readonly db: DatabaseSync;
  private readonly provider: EmbeddingProvider;
  private readonly providerKey: string;
  private readonly openAi?: OpenAiEmbeddingClient;
  private readonly gemini?: GeminiEmbeddingClient;

  // Vector/FTS state (shared with parent)
  private vectorState: {
    available: boolean;
    dims?: number;
  };
  private ftsAvailable: boolean;

  constructor(
    db: DatabaseSync,
    provider: EmbeddingProvider,
    config: IndexerConfig,
    options?: {
      openAi?: OpenAiEmbeddingClient;
      gemini?: GeminiEmbeddingClient;
      vectorState?: { available: boolean; dims?: number };
      ftsAvailable?: boolean;
    }
  ) {
    this.db = db;
    this.provider = provider;
    this.config = config;
    this.openAi = options?.openAi;
    this.gemini = options?.gemini;
    this.vectorState = options?.vectorState ?? { available: false };
    this.ftsAvailable = options?.ftsAvailable ?? false;
    this.providerKey = this.computeProviderKey();
  }

  /**
   * Update vector/FTS availability (called by parent when extensions load)
   */
  setVectorState(state: { available: boolean; dims?: number }): void {
    this.vectorState = state;
  }

  setFtsAvailable(available: boolean): void {
    this.ftsAvailable = available;
  }

  getVectorDims(): number | undefined {
    return this.vectorState.dims;
  }

  /**
   * Compute a unique key for the current provider configuration
   */
  private computeProviderKey(): string {
    const parts: string[] = [this.provider.id, this.provider.model];
    if (this.openAi) {
      parts.push(this.openAi.baseUrl);
    }
    if (this.gemini) {
      parts.push(this.gemini.baseUrl);
    }
    return hashText(parts.join(":"));
  }

  /**
   * Read index metadata from database
   */
  readMeta(): MemoryIndexMeta | null {
    try {
      const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
        | { value: string }
        | undefined;
      if (!row?.value) return null;
      return JSON.parse(row.value) as MemoryIndexMeta;
    } catch {
      return null;
    }
  }

  /**
   * Write index metadata to database
   */
  writeMeta(meta: MemoryIndexMeta): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run(META_KEY, JSON.stringify(meta));
  }

  /**
   * Check if the index is stale by comparing file mtimes
   */
  async isStale(): Promise<boolean> {
    try {
      const files = await listMemoryFiles(this.config.memoryDir);

      const stored = this.db
        .prepare(`SELECT path, mtime FROM files WHERE source = ?`)
        .all("memory") as Array<{ path: string; mtime: number }>;

      if (files.length !== stored.length) {
        this.config.debug?.(`Stale: file count changed (${stored.length} -> ${files.length})`);
        return true;
      }

      const storedMap = new Map(stored.map((f) => [f.path, f.mtime]));

      for (const absPath of files) {
        const relPath = path.relative(this.config.memoryDir, absPath).replace(/\\/g, "/");
        const storedMtime = storedMap.get(relPath);

        if (storedMtime === undefined) {
          this.config.debug?.(`Stale: new file ${relPath}`);
          return true;
        }

        const stat = await fs.stat(absPath);
        const currentMtime = Math.floor(stat.mtimeMs);
        if (currentMtime !== storedMtime) {
          this.config.debug?.(`Stale: mtime changed for ${relPath}`);
          return true;
        }
      }

      return false;
    } catch (err) {
      this.config.debug?.(`Stale check failed: ${String(err)}`);
      return true;
    }
  }

  /**
   * Check if a full reindex is needed based on configuration changes
   */
  needsFullReindex(force?: boolean): boolean {
    const meta = this.readMeta();
    return (
      force === true ||
      !meta ||
      meta.model !== this.provider.model ||
      meta.provider !== this.provider.id ||
      meta.providerKey !== this.providerKey ||
      meta.chunkTokens !== this.config.chunking.tokens ||
      meta.chunkOverlap !== this.config.chunking.overlap ||
      (this.vectorState.available && !meta?.vectorDims)
    );
  }

  /**
   * Index all memory files, returns stats
   */
  async indexAll(force?: boolean): Promise<IndexStats> {
    const needsFullReindex = this.needsFullReindex(force);
    const files = await listMemoryFiles(this.config.memoryDir);
    const activePaths = new Set<string>();
    let filesProcessed = 0;
    let chunksCreated = 0;

    for (const absPath of files) {
      const entry = await buildFileEntry(absPath, this.config.memoryDir);
      activePaths.add(entry.path);

      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "memory") as { hash: string } | undefined;

      if (!needsFullReindex && record?.hash === entry.hash) {
        continue;
      }

      const chunkCount = await this.indexFile(entry);
      filesProcessed++;
      chunksCreated += chunkCount;
    }

    // Delete stale entries
    const staleRemoved = this.removeStaleEntries(activePaths);

    // Write meta
    this.writeMeta({
      model: this.provider.model,
      provider: this.provider.id,
      providerKey: this.providerKey,
      chunkTokens: this.config.chunking.tokens,
      chunkOverlap: this.config.chunking.overlap,
      vectorDims: this.vectorState.dims,
    });

    // Prune embedding cache
    this.pruneEmbeddingCacheIfNeeded();

    return { filesProcessed, chunksCreated, staleRemoved };
  }

  /**
   * Index a single file
   */
  async indexFile(entry: MemoryFileEntry): Promise<number> {
    const content = await fs.readFile(entry.absPath, "utf-8");
    const chunks = chunkMarkdown(content, this.config.chunking);

    const embeddings = await this.embedChunks(chunks);

    // Update files table
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)`
      )
      .run(entry.path, "memory", entry.hash, Math.floor(entry.mtimeMs), entry.size);

    // Delete old chunks
    this.deleteChunksForFile(entry.path);

    // Insert new chunks
    const now = Date.now();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      this.insertChunk(entry.path, chunk, embedding, now);
    }

    return chunks.length;
  }

  /**
   * Delete all chunks for a file
   */
  private deleteChunksForFile(filePath: string): void {
    try {
      this.db
        .prepare(
          `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`
        )
        .run(filePath, "memory");
    } catch {
      // Vector table may not exist
    }
    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(filePath, "memory");
    if (this.config.ftsEnabled && this.ftsAvailable) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(filePath, "memory", this.provider.model);
      } catch {
        // FTS table may not exist
      }
    }
  }

  /**
   * Insert a chunk into the database
   */
  private insertChunk(
    filePath: string,
    chunk: MemoryChunk,
    embedding: number[],
    timestamp: number
  ): void {
    const chunkId = randomUUID();

    this.db
      .prepare(
        `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        chunkId,
        filePath,
        "memory",
        chunk.startLine,
        chunk.endLine,
        chunk.hash,
        this.provider.model,
        chunk.text,
        JSON.stringify(embedding),
        timestamp
      );

    // Insert into vector table if available
    if (this.vectorState.available && embedding.length > 0) {
      if (!this.vectorState.dims) {
        this.vectorState.dims = embedding.length;
        this.ensureVectorTable(embedding.length);
      }
      try {
        this.db
          .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
          .run(chunkId, vectorToBlob(embedding));
      } catch {
        // Vector insertion may fail
      }
    }

    // Insert into FTS table if available
    if (this.config.ftsEnabled && this.ftsAvailable) {
      try {
        this.db
          .prepare(
            `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            chunk.text,
            chunkId,
            filePath,
            "memory",
            this.provider.model,
            chunk.startLine,
            chunk.endLine
          );
      } catch {
        // FTS insertion may fail
      }
    }
  }

  /**
   * Remove stale file entries that no longer exist
   */
  private removeStaleEntries(activePaths: Set<string>): number {
    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("memory") as Array<{ path: string }>;

    let removed = 0;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) continue;

      this.db
        .prepare(`DELETE FROM files WHERE path = ? AND source = ?`)
        .run(stale.path, "memory");
      this.deleteChunksForFile(stale.path);
      removed++;
    }

    return removed;
  }

  /**
   * Create vector table with the given dimensions
   */
  ensureVectorTable(dimensions: number): void {
    if (!this.vectorState.available) return;
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[${dimensions}]
        )`
      );
    } catch (err) {
      this.config.debug?.(`vector table creation failed: ${String(err)}`);
    }
  }

  /**
   * Get embeddings for chunks, using cache when available
   */
  async embedChunks(chunks: MemoryChunk[]): Promise<number[][]> {
    if (chunks.length === 0) return [];

    const hashes = chunks.map((c) => c.hash);
    const cached = this.loadEmbeddingCache(hashes);
    const missing: Array<{ index: number; chunk: MemoryChunk }> = [];

    for (let i = 0; i < chunks.length; i++) {
      if (!cached.has(hashes[i])) {
        missing.push({ index: i, chunk: chunks[i] });
      }
    }

    if (missing.length > 0) {
      const texts = missing.map((m) => m.chunk.text);
      const newEmbeddings = await this.embedBatchWithRetry(texts);

      for (let i = 0; i < missing.length; i++) {
        const hash = missing[i].chunk.hash;
        const embedding = newEmbeddings[i] ?? [];
        cached.set(hash, embedding);
        this.upsertEmbeddingCache(hash, embedding);
      }
    }

    return hashes.map((h) => cached.get(h) ?? []);
  }

  /**
   * Embed texts with retry logic
   */
  private async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Try batch API first if enabled
    if (this.config.batch.enabled) {
      try {
        return await this.embedWithBatchApi(texts);
      } catch (err) {
        this.config.debug?.(`batch embedding failed, falling back to direct: ${String(err)}`);
      }
    }

    // Fall back to direct embedding
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < EMBEDDING_RETRY_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.provider.embedBatch(texts);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < EMBEDDING_RETRY_MAX_ATTEMPTS - 1) {
          const delay = Math.min(
            EMBEDDING_RETRY_MAX_DELAY_MS,
            EMBEDDING_RETRY_BASE_DELAY_MS * Math.pow(2, attempt)
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

  /**
   * Use batch API for large embedding jobs
   */
  private async embedWithBatchApi(texts: string[]): Promise<number[][]> {
    if (this.openAi) {
      const requests: OpenAiBatchRequest[] = texts.map((text, i) => ({
        custom_id: `chunk-${i}`,
        method: "POST",
        url: OPENAI_BATCH_ENDPOINT,
        body: { model: this.openAi!.model, input: text },
      }));

      const results = await runOpenAiEmbeddingBatches({
        openAi: this.openAi,
        source: "minimem",
        requests,
        wait: this.config.batch.wait,
        pollIntervalMs: this.config.batch.pollIntervalMs,
        timeoutMs: this.config.batch.timeoutMs,
        concurrency: this.config.batch.concurrency,
        debug: this.config.debug,
      });

      return texts.map((_, i) => results.get(`chunk-${i}`) ?? []);
    }

    if (this.gemini) {
      const requests: GeminiBatchRequest[] = texts.map((text, i) => ({
        custom_id: `chunk-${i}`,
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
      }));

      const results = await runGeminiEmbeddingBatches({
        gemini: this.gemini,
        source: "minimem",
        requests,
        wait: this.config.batch.wait,
        pollIntervalMs: this.config.batch.pollIntervalMs,
        timeoutMs: this.config.batch.timeoutMs,
        concurrency: this.config.batch.concurrency,
        debug: this.config.debug,
      });

      return texts.map((_, i) => results.get(`chunk-${i}`) ?? []);
    }

    throw new Error("Batch API not available for local embeddings");
  }

  /**
   * Load embeddings from cache
   */
  private loadEmbeddingCache(hashes: string[]): Map<string, number[]> {
    const result = new Map<string, number[]>();
    if (!this.config.cache.enabled || hashes.length === 0) return result;

    const placeholders = hashes.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}
         WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`
      )
      .all(this.provider.id, this.provider.model, this.providerKey, ...hashes) as Array<{
      hash: string;
      embedding: string;
    }>;

    const now = Date.now();
    for (const row of rows) {
      result.set(row.hash, parseEmbedding(row.embedding));
      // Touch for LRU
      this.db
        .prepare(
          `UPDATE ${EMBEDDING_CACHE_TABLE} SET updated_at = ?
           WHERE provider = ? AND model = ? AND provider_key = ? AND hash = ?`
        )
        .run(now, this.provider.id, this.provider.model, this.providerKey, row.hash);
    }

    return result;
  }

  /**
   * Save embedding to cache
   */
  private upsertEmbeddingCache(hash: string, embedding: number[]): void {
    if (!this.config.cache.enabled) return;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${EMBEDDING_CACHE_TABLE}
         (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        this.provider.id,
        this.provider.model,
        this.providerKey,
        hash,
        JSON.stringify(embedding),
        embedding.length,
        now
      );
  }

  /**
   * Prune old cache entries if over limit
   */
  private pruneEmbeddingCacheIfNeeded(): void {
    if (!this.config.cache.enabled) return;
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM ${EMBEDDING_CACHE_TABLE}`)
      .get() as { count: number };
    if (row.count <= this.config.cache.maxEntries) return;

    const excess = row.count - this.config.cache.maxEntries;
    this.db
      .prepare(
        `DELETE FROM ${EMBEDDING_CACHE_TABLE}
         WHERE rowid IN (
           SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}
           ORDER BY updated_at ASC
           LIMIT ?
         )`
      )
      .run(excess);
  }
}
