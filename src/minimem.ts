import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import chokidar, { type FSWatcher } from "chokidar";

import {
  buildFileEntry,
  chunkMarkdown,
  ensureDir,
  hashText,
  listMemoryFiles,
  logError,
  type MemoryChunk,
  type MemoryFileEntry,
  parseEmbedding,
} from "./internal.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./search/hybrid.js";
import { searchKeyword, searchVector } from "./search/search.js";
import { ensureMemoryIndexSchema } from "./db/schema.js";
import { loadSqliteVecExtension } from "./db/sqlite-vec.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderOptions,
  type OpenAiEmbeddingClient,
  type GeminiEmbeddingClient,
} from "./embeddings/embeddings.js";
import { runOpenAiEmbeddingBatches, type OpenAiBatchRequest, OPENAI_BATCH_ENDPOINT } from "./embeddings/batch-openai.js";
import { runGeminiEmbeddingBatches, type GeminiBatchRequest } from "./embeddings/batch-gemini.js";

const META_KEY = "memory_index_meta_v1";
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const EMBEDDING_BATCH_MAX_TOKENS = 8000;
const EMBEDDING_APPROX_CHARS_PER_TOKEN = 1;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8000;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;

const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

export type MinimemConfig = {
  /** Directory containing memory files (MEMORY.md, memory/*.md) */
  memoryDir: string;
  /** Path to SQLite database. Defaults to memoryDir/.minimem/index.db */
  dbPath?: string;
  /** Embedding provider options */
  embedding: EmbeddingProviderOptions;
  /** Chunking configuration */
  chunking?: {
    /** Tokens per chunk (default: 256) */
    tokens?: number;
    /** Overlap tokens between chunks (default: 32) */
    overlap?: number;
  };
  /** Embedding cache configuration */
  cache?: {
    /** Enable embedding cache (default: true) */
    enabled?: boolean;
    /** Max cache entries before LRU pruning (default: 10000) */
    maxEntries?: number;
  };
  /** Hybrid search configuration */
  hybrid?: {
    /** Enable hybrid search (default: true) */
    enabled?: boolean;
    /** Weight for vector search (default: 0.7) */
    vectorWeight?: number;
    /** Weight for keyword search (default: 0.3) */
    textWeight?: number;
    /** Candidate multiplier for search (default: 2.0) */
    candidateMultiplier?: number;
  };
  /** Query configuration */
  query?: {
    /** Max results (default: 10) */
    maxResults?: number;
    /** Min score threshold (default: 0.3) */
    minScore?: number;
  };
  /** File watching configuration */
  watch?: {
    /** Enable file watching (default: true) */
    enabled?: boolean;
    /** Debounce delay in ms (default: 1000) */
    debounceMs?: number;
  };
  /** Batch embedding configuration */
  batch?: {
    /** Enable batch embedding API (default: false) */
    enabled?: boolean;
    /** Wait for batch completion (default: true) */
    wait?: boolean;
    /** Concurrent batch requests (default: 2) */
    concurrency?: number;
    /** Poll interval in ms (default: 2000) */
    pollIntervalMs?: number;
    /** Timeout in ms (default: 60 minutes) */
    timeoutMs?: number;
  };
  /** sqlite-vec extension path (optional) */
  vectorExtensionPath?: string;
  /** Debug logging function */
  debug?: (message: string, data?: Record<string, unknown>) => void;
};

export type MinimemSearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
};

type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
};

export class Minimem {
  private readonly memoryDir: string;
  private readonly dbPath: string;
  private readonly chunking: { tokens: number; overlap: number };
  private readonly cache: { enabled: boolean; maxEntries: number };
  private readonly hybrid: {
    enabled: boolean;
    vectorWeight: number;
    textWeight: number;
    candidateMultiplier: number;
  };
  private readonly queryConfig: { maxResults: number; minScore: number };
  private readonly watchConfig: { enabled: boolean; debounceMs: number };
  private readonly batchConfig: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  private readonly vectorExtensionPath?: string;
  private readonly debug?: (message: string, data?: Record<string, unknown>) => void;

  private provider!: EmbeddingProvider;
  private openAi?: OpenAiEmbeddingClient;
  private gemini?: GeminiEmbeddingClient;
  private providerKey: string = "";
  private providerFallbackReason?: string;
  private db!: DatabaseSync;

  private readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  private readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  };

  private vectorReady: Promise<boolean> | null = null;
  private watcher: FSWatcher | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  private closed = false;
  private dirty = true;
  private syncing: Promise<void> | null = null;
  private syncLock = false;
  private embeddingOptions: EmbeddingProviderOptions;

  private constructor(config: MinimemConfig) {
    this.memoryDir = path.resolve(config.memoryDir);
    this.dbPath = config.dbPath ?? path.join(this.memoryDir, ".minimem", "index.db");
    this.chunking = {
      tokens: config.chunking?.tokens ?? 256,
      overlap: config.chunking?.overlap ?? 32,
    };
    this.cache = {
      enabled: config.cache?.enabled ?? true,
      maxEntries: config.cache?.maxEntries ?? 10000,
    };
    this.hybrid = {
      enabled: config.hybrid?.enabled ?? true,
      vectorWeight: config.hybrid?.vectorWeight ?? 0.7,
      textWeight: config.hybrid?.textWeight ?? 0.3,
      candidateMultiplier: config.hybrid?.candidateMultiplier ?? 2.0,
    };
    this.queryConfig = {
      maxResults: config.query?.maxResults ?? 10,
      minScore: config.query?.minScore ?? 0.3,
    };
    this.watchConfig = {
      enabled: config.watch?.enabled ?? true,
      debounceMs: config.watch?.debounceMs ?? 1000,
    };
    this.batchConfig = {
      enabled: config.batch?.enabled ?? false,
      wait: config.batch?.wait ?? true,
      concurrency: config.batch?.concurrency ?? 2,
      pollIntervalMs: config.batch?.pollIntervalMs ?? 2000,
      timeoutMs: config.batch?.timeoutMs ?? 60 * 60 * 1000,
    };
    this.vectorExtensionPath = config.vectorExtensionPath;
    this.debug = config.debug;
    this.embeddingOptions = config.embedding;

    this.vector = {
      enabled: true,
      available: null,
      extensionPath: this.vectorExtensionPath,
    };
    this.fts = { enabled: this.hybrid.enabled, available: false };
  }

  static async create(config: MinimemConfig): Promise<Minimem> {
    const instance = new Minimem(config);
    await instance.initialize();
    return instance;
  }

  private async initialize(): Promise<void> {
    // Create embedding provider
    const providerResult = await createEmbeddingProvider(this.embeddingOptions);
    this.provider = providerResult.provider;
    this.openAi = providerResult.openAi;
    this.gemini = providerResult.gemini;
    this.providerKey = this.computeProviderKey();
    this.providerFallbackReason = providerResult.fallbackReason;

    // Log warning if in BM25-only fallback mode
    if (this.provider.id === "none") {
      this.debug?.("Running in BM25-only mode (no embedding API available)");
    }

    // Open database
    this.db = this.openDatabase();
    this.ensureSchema();

    // Check for existing vector dims
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }

    // Start file watcher
    if (this.watchConfig.enabled) {
      this.ensureWatcher();
    }
  }

  private openDatabase(): DatabaseSync {
    const dbDir = path.dirname(this.dbPath);
    ensureDir(dbDir);
    return new DatabaseSync(this.dbPath);
  }

  private ensureSchema(): void {
    const result = ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
    });
    this.fts.available = result.ftsAvailable;
    if (result.ftsError) {
      this.fts.loadError = result.ftsError;
    }
  }

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

  private readMeta(): MemoryIndexMeta | null {
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

  private writeMeta(meta: MemoryIndexMeta): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run(META_KEY, JSON.stringify(meta));
  }

  private ensureWatcher(): void {
    if (this.watcher) return;
    const memorySubDir = path.join(this.memoryDir, "memory");
    const memoryFile = path.join(this.memoryDir, "MEMORY.md");

    this.watcher = chokidar.watch([memoryFile, memorySubDir], {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    const scheduleSync = () => {
      this.dirty = true;
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => {
        void this.sync({ reason: "watch" }).catch((err) => {
          this.debug?.(`memory sync failed (watch): ${String(err)}`);
        });
      }, this.watchConfig.debounceMs);
    };

    this.watcher.on("add", scheduleSync);
    this.watcher.on("change", scheduleSync);
    this.watcher.on("unlink", scheduleSync);
  }

  /**
   * Check if the index is stale by comparing file mtimes against stored values.
   * This is a lightweight check (stat calls only, no file reads).
   */
  private async isStale(): Promise<boolean> {
    try {
      const files = await listMemoryFiles(this.memoryDir);

      // Get stored file records
      const stored = this.db
        .prepare(`SELECT path, mtime FROM files WHERE source = ?`)
        .all("memory") as Array<{ path: string; mtime: number }>;

      // Quick check: different file count means stale
      if (files.length !== stored.length) {
        this.debug?.(`Stale: file count changed (${stored.length} -> ${files.length})`);
        return true;
      }

      // Build lookup map of stored mtimes
      const storedMap = new Map(stored.map((f) => [f.path, f.mtime]));

      // Check each file's mtime against stored value
      for (const absPath of files) {
        const relPath = path.relative(this.memoryDir, absPath).replace(/\\/g, "/");
        const storedMtime = storedMap.get(relPath);

        // File not in index = stale
        if (storedMtime === undefined) {
          this.debug?.(`Stale: new file ${relPath}`);
          return true;
        }

        // Check mtime
        const stat = await fs.stat(absPath);
        const currentMtime = Math.floor(stat.mtimeMs);
        if (currentMtime !== storedMtime) {
          this.debug?.(`Stale: mtime changed for ${relPath}`);
          return true;
        }
      }

      return false;
    } catch (err) {
      // On error, assume stale to be safe
      this.debug?.(`Stale check failed: ${String(err)}`);
      return true;
    }
  }

  async search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<MinimemSearchResult[]> {
    // Check staleness: use dirty flag if watcher is on, otherwise check mtimes
    if (this.dirty || (!this.watchConfig.enabled && (await this.isStale()))) {
      await this.sync({ reason: "search" });
    }

    const cleaned = query.trim();
    if (!cleaned) return [];

    const minScore = opts?.minScore ?? this.queryConfig.minScore;
    const maxResults = opts?.maxResults ?? this.queryConfig.maxResults;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * this.hybrid.candidateMultiplier)),
    );

    const sourceFilter = { sql: "", params: [] as string[] };

    const keywordResults = this.hybrid.enabled && this.fts.available
      ? await searchKeyword({
          db: this.db,
          ftsTable: FTS_TABLE,
          providerModel: this.provider.model,
          query: cleaned,
          limit: candidates,
          snippetMaxChars: SNIPPET_MAX_CHARS,
          sourceFilter,
          buildFtsQuery,
          bm25RankToScore,
        }).catch(() => [])
      : [];

    const queryVec = await this.embedQueryWithTimeout(cleaned);
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await searchVector({
          db: this.db,
          vectorTable: VECTOR_TABLE,
          providerModel: this.provider.model,
          queryVec,
          limit: candidates,
          snippetMaxChars: SNIPPET_MAX_CHARS,
          ensureVectorReady: (dims) => this.ensureVectorReady(dims),
          sourceFilterVec: sourceFilter,
          sourceFilterChunks: sourceFilter,
        }).catch(() => [])
      : [];

    if (!this.hybrid.enabled) {
      return vectorResults
        .filter((entry) => entry.score >= minScore)
        .slice(0, maxResults)
        .map((r) => ({
          path: r.path,
          startLine: r.startLine,
          endLine: r.endLine,
          score: r.score,
          snippet: r.snippet,
        }));
    }

    const merged = mergeHybridResults({
      vector: vectorResults.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
      })),
      keyword: keywordResults.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
      })),
      vectorWeight: this.hybrid.vectorWeight,
      textWeight: this.hybrid.textWeight,
    });

    return merged
      .filter((entry) => entry.score >= minScore)
      .slice(0, maxResults)
      .map((r) => ({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        snippet: r.snippet,
      }));
  }

  async sync(opts?: { reason?: string; force?: boolean }): Promise<void> {
    // If a sync is already running, wait for it instead of starting another
    if (this.syncing) {
      await this.syncing;
      return;
    }

    // Use a synchronous flag to prevent the race window between
    // checking this.syncing and assigning to it
    if (this.syncLock) {
      return;
    }
    this.syncLock = true;

    this.syncing = this.runSync(opts);
    try {
      await this.syncing;
    } finally {
      this.syncing = null;
      this.syncLock = false;
    }
  }

  private async runSync(opts?: { reason?: string; force?: boolean }): Promise<void> {
    this.debug?.(`memory sync starting`, { reason: opts?.reason });

    await this.ensureVectorReady();
    const meta = this.readMeta();
    const needsFullReindex =
      opts?.force ||
      !meta ||
      meta.model !== this.provider.model ||
      meta.provider !== this.provider.id ||
      meta.providerKey !== this.providerKey ||
      meta.chunkTokens !== this.chunking.tokens ||
      meta.chunkOverlap !== this.chunking.overlap ||
      (this.vector.available && !meta?.vectorDims);

    const files = await listMemoryFiles(this.memoryDir);
    const activePaths = new Set<string>();

    for (const absPath of files) {
      const entry = await buildFileEntry(absPath, this.memoryDir);
      activePaths.add(entry.path);

      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "memory") as { hash: string } | undefined;

      if (!needsFullReindex && record?.hash === entry.hash) {
        continue;
      }

      await this.indexFile(entry);
    }

    // Delete stale entries
    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("memory") as Array<{ path: string }>;

    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) continue;
      this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(stale.path, "memory");
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(stale.path, "memory");
      } catch (err) {
        logError("deleteStaleVectorEntries", err, this.debug);
      }
      this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(stale.path, "memory");
      if (this.fts.enabled && this.fts.available) {
        try {
          this.db
            .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
            .run(stale.path, "memory", this.provider.model);
        } catch (err) {
          logError("deleteStaleFtsEntries", err, this.debug);
        }
      }
    }

    // Write meta
    this.writeMeta({
      model: this.provider.model,
      provider: this.provider.id,
      providerKey: this.providerKey,
      chunkTokens: this.chunking.tokens,
      chunkOverlap: this.chunking.overlap,
      vectorDims: this.vector.dims,
    });

    // Prune embedding cache
    this.pruneEmbeddingCacheIfNeeded();

    this.dirty = false;
    this.debug?.(`memory sync complete`, { files: files.length });
  }

  private async indexFile(entry: MemoryFileEntry): Promise<void> {
    const content = await fs.readFile(entry.absPath, "utf-8");
    const chunks = chunkMarkdown(content, this.chunking);

    // Get embeddings
    const embeddings = await this.embedChunks(chunks);

    // Update files table
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(entry.path, "memory", entry.hash, Math.floor(entry.mtimeMs), entry.size);

    // Delete old chunks for this file
    try {
      this.db
        .prepare(
          `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
        )
        .run(entry.path, "memory");
    } catch (err) {
      logError("deleteOldVectorChunks", err, this.debug);
    }
    this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(entry.path, "memory");
    if (this.fts.enabled && this.fts.available) {
      try {
        this.db
          .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
          .run(entry.path, "memory", this.provider.model);
      } catch (err) {
        logError("deleteOldFtsChunks", err, this.debug);
      }
    }

    // Insert new chunks
    const now = Date.now();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      const chunkId = randomUUID();

      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          chunkId,
          entry.path,
          "memory",
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          this.provider.model,
          chunk.text,
          JSON.stringify(embedding),
          now,
        );

      // Insert into vector table if available
      if (this.vector.available && embedding.length > 0) {
        if (!this.vector.dims) {
          this.vector.dims = embedding.length;
          this.ensureVectorTable(embedding.length);
        }
        try {
          this.db
            .prepare(`INSERT INTO ${VECTOR_TABLE} (id, embedding) VALUES (?, ?)`)
            .run(chunkId, vectorToBlob(embedding));
        } catch (err) {
          logError("insertVectorChunk", err, this.debug);
        }
      }

      // Insert into FTS table if available
      if (this.fts.enabled && this.fts.available) {
        try {
          this.db
            .prepare(
              `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              chunk.text,
              chunkId,
              entry.path,
              "memory",
              this.provider.model,
              chunk.startLine,
              chunk.endLine,
            );
        } catch (err) {
          logError("insertFtsChunk", err, this.debug);
        }
      }
    }
  }

  private async embedChunks(chunks: MemoryChunk[]): Promise<number[][]> {
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

  private async embedBatchWithRetry(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    // Try batch API first if enabled
    if (this.batchConfig.enabled) {
      try {
        return await this.embedWithBatchApi(texts);
      } catch (err) {
        this.debug?.(`batch embedding failed, falling back to direct: ${String(err)}`);
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
            EMBEDDING_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw lastError;
  }

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
        wait: this.batchConfig.wait,
        pollIntervalMs: this.batchConfig.pollIntervalMs,
        timeoutMs: this.batchConfig.timeoutMs,
        concurrency: this.batchConfig.concurrency,
        debug: this.debug,
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
        wait: this.batchConfig.wait,
        pollIntervalMs: this.batchConfig.pollIntervalMs,
        timeoutMs: this.batchConfig.timeoutMs,
        concurrency: this.batchConfig.concurrency,
        debug: this.debug,
      });

      return texts.map((_, i) => results.get(`chunk-${i}`) ?? []);
    }

    throw new Error("Batch API not available for local embeddings");
  }

  private async embedQueryWithTimeout(text: string): Promise<number[]> {
    const timeout =
      this.provider.id === "local" ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeout);

    try {
      const result = await Promise.race([
        this.provider.embedQuery(text),
        new Promise<number[]>((_, reject) => {
          ac.signal.addEventListener("abort", () =>
            reject(new Error("embedding query timeout")),
          );
        }),
      ]);
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private loadEmbeddingCache(hashes: string[]): Map<string, number[]> {
    const result = new Map<string, number[]>();
    if (!this.cache.enabled || hashes.length === 0) return result;

    const placeholders = hashes.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}
         WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
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
           WHERE provider = ? AND model = ? AND provider_key = ? AND hash = ?`,
        )
        .run(now, this.provider.id, this.provider.model, this.providerKey, row.hash);
    }

    return result;
  }

  private upsertEmbeddingCache(hash: string, embedding: number[]): void {
    if (!this.cache.enabled) return;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT OR REPLACE INTO ${EMBEDDING_CACHE_TABLE}
         (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        this.provider.id,
        this.provider.model,
        this.providerKey,
        hash,
        JSON.stringify(embedding),
        embedding.length,
        now,
      );
  }

  private pruneEmbeddingCacheIfNeeded(): void {
    if (!this.cache.enabled) return;
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM ${EMBEDDING_CACHE_TABLE}`)
      .get() as { count: number };
    if (row.count <= this.cache.maxEntries) return;

    const excess = row.count - this.cache.maxEntries;
    this.db
      .prepare(
        `DELETE FROM ${EMBEDDING_CACHE_TABLE}
         WHERE rowid IN (
           SELECT rowid FROM ${EMBEDDING_CACHE_TABLE}
           ORDER BY updated_at ASC
           LIMIT ?
         )`,
      )
      .run(excess);
  }

  private async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (this.vector.available === true) return true;
    if (this.vector.available === false) return false;

    if (!this.vectorReady) {
      this.vectorReady = this.loadVectorExtension();
    }

    const ready = await this.vectorReady;
    if (ready && dimensions && !this.vector.dims) {
      this.vector.dims = dimensions;
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  private async loadVectorExtension(): Promise<boolean> {
    const result = await loadSqliteVecExtension({
      db: this.db,
      extensionPath: this.vectorExtensionPath,
    });

    this.vector.available = result.ok;
    if (result.error) {
      this.vector.loadError = result.error;
      this.debug?.(`sqlite-vec load failed: ${result.error}`);
    }
    if (result.extensionPath) {
      this.vector.extensionPath = result.extensionPath;
    }

    return result.ok;
  }

  private ensureVectorTable(dimensions: number): void {
    if (!this.vector.available) return;
    try {
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[${dimensions}]
        )`,
      );
    } catch (err) {
      this.debug?.(`vector table creation failed: ${String(err)}`);
    }
  }

  async readFile(relativePath: string): Promise<string | null> {
    const absPath = path.join(this.memoryDir, relativePath);
    try {
      return await fs.readFile(absPath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Read specific lines from a memory file
   */
  async readLines(
    relativePath: string,
    opts?: { from?: number; lines?: number },
  ): Promise<{ content: string; startLine: number; endLine: number } | null> {
    const content = await this.readFile(relativePath);
    if (content === null) return null;

    const allLines = content.split("\n");
    const from = Math.max(1, opts?.from ?? 1);
    const lines = opts?.lines ?? allLines.length;

    const startIdx = from - 1;
    const endIdx = Math.min(startIdx + lines, allLines.length);
    const selectedLines = allLines.slice(startIdx, endIdx);

    return {
      content: selectedLines.join("\n"),
      startLine: from,
      endLine: startIdx + selectedLines.length,
    };
  }

  /**
   * Write content to a memory file (creates or overwrites)
   */
  async writeFile(relativePath: string, content: string): Promise<void> {
    this.validateMemoryPath(relativePath);
    const absPath = path.join(this.memoryDir, relativePath);
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(absPath, content, "utf-8");
    this.dirty = true;
    this.debug?.(`memory write: ${relativePath}`);
  }

  /**
   * Append content to a memory file (creates if doesn't exist)
   */
  async appendFile(relativePath: string, content: string): Promise<void> {
    this.validateMemoryPath(relativePath);
    const absPath = path.join(this.memoryDir, relativePath);
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });

    // Ensure newline separation
    let toAppend = content;
    try {
      const existing = await fs.readFile(absPath, "utf-8");
      if (existing.length > 0 && !existing.endsWith("\n")) {
        toAppend = "\n" + content;
      }
    } catch {
      // File doesn't exist, will be created
    }

    await fs.appendFile(absPath, toAppend, "utf-8");
    this.dirty = true;
    this.debug?.(`memory append: ${relativePath}`);
  }

  /**
   * Append content to today's daily log (memory/YYYY-MM-DD.md)
   */
  async appendToday(content: string): Promise<string> {
    const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
    const relativePath = `memory/${today}.md`;
    await this.appendFile(relativePath, content);
    return relativePath;
  }

  /**
   * List all memory files
   */
  async listFiles(): Promise<string[]> {
    const files = await listMemoryFiles(this.memoryDir);
    return files.map((f) => path.relative(this.memoryDir, f).replace(/\\/g, "/"));
  }

  /**
   * Validate that a path is within allowed memory locations
   */
  private validateMemoryPath(relativePath: string): void {
    const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");

    // Allow MEMORY.md at root
    if (normalized === "MEMORY.md" || normalized === "memory.md") {
      return;
    }

    // Allow anything under memory/
    if (normalized.startsWith("memory/") && normalized.endsWith(".md")) {
      // Prevent path traversal
      if (normalized.includes("..")) {
        throw new Error(`Invalid memory path: ${relativePath} (path traversal not allowed)`);
      }
      return;
    }

    throw new Error(
      `Invalid memory path: ${relativePath}. Must be MEMORY.md or memory/*.md`,
    );
  }

  async status(): Promise<{
    memoryDir: string;
    dbPath: string;
    provider: string;
    model: string;
    vectorAvailable: boolean;
    ftsAvailable: boolean;
    bm25Only: boolean;
    fallbackReason?: string;
    fileCount: number;
    chunkCount: number;
    cacheCount: number;
  }> {
    const fileRow = this.db.prepare(`SELECT COUNT(*) as count FROM files`).get() as { count: number };
    const chunkRow = this.db.prepare(`SELECT COUNT(*) as count FROM chunks`).get() as { count: number };
    const cacheRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM ${EMBEDDING_CACHE_TABLE}`)
      .get() as { count: number };

    return {
      memoryDir: this.memoryDir,
      dbPath: this.dbPath,
      provider: this.provider.id,
      model: this.provider.model,
      vectorAvailable: this.vector.available === true,
      ftsAvailable: this.fts.available,
      bm25Only: this.provider.id === "none",
      fallbackReason: this.providerFallbackReason,
      fileCount: fileRow.count,
      chunkCount: chunkRow.count,
      cacheCount: cacheRow.count,
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;

    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }

    if (this.watcher) {
      void this.watcher.close();
      this.watcher = null;
    }

    try {
      this.db.close();
    } catch (err) {
      logError("dbClose", err, this.debug);
    }
  }
}
