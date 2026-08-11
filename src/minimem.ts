import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import chokidar, { type FSWatcher } from "chokidar";

import {
  buildFileEntry,
  chunkMarkdown,
  ensureDir,
  extractChunkMetadata,
  hashText,
  listMemoryFiles,
  logError,
  type MemoryChunk,
  type MemoryFileEntry,
  parseEmbedding,
  vectorToBlob,
} from "./internal.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./search/hybrid.js";
import { selectResults } from "./search/select.js";
import {
  applyRedactions,
  isFullyRedacted,
  normalizeRule,
  parseRedactionManifest,
  serializeRedactionRule,
  type RedactionRule,
  type RedactionRuleInput,
} from "./search/redact.js";
import { searchKeyword, searchVector, buildKnowledgeFilterSql } from "./search/search.js";
import { ensureMemoryIndexSchema } from "./db/schema.js";
import { parseFrontmatter, type MemoryFrontmatter, type KnowledgeLink } from "./session.js";
import {
  getLinksFrom,
  getLinksTo,
  getNeighbors,
  getPathBetween,
  type GraphLink,
  type GraphNeighbor,
} from "./search/graph.js";
import { loadSqliteVecExtension } from "./db/sqlite-vec.js";
import { openSqliteDatabase } from "./db/open-db.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderOptions,
  type OpenAiEmbeddingClient,
  type GeminiEmbeddingClient,
} from "./embeddings/embeddings.js";
import { runOpenAiEmbeddingBatches, type OpenAiBatchRequest, OPENAI_BATCH_ENDPOINT } from "./embeddings/batch-openai.js";
import { runGeminiEmbeddingBatches, type GeminiBatchRequest } from "./embeddings/batch-gemini.js";

/**
 * Resolve which subdirectory holds minimem config/data.
 * Priority: MINIMEM_CONFIG_DIR env var > contained (config.json at root) > .swarm/minimem > .minimem
 */
function resolveMinimemSubdir(memoryDir: string): string {
  const envDir = process.env.MINIMEM_CONFIG_DIR;
  if (envDir) return envDir;
  // Contained layout: config.json directly in memoryDir (no subdir)
  if (fsSync.existsSync(path.join(memoryDir, "config.json"))) return ".";
  const swarmDir = path.join(memoryDir, ".swarm", "minimem");
  if (fsSync.existsSync(path.join(swarmDir, "config.json"))) return path.join(".swarm", "minimem");
  return ".minimem";
}

const META_KEY = "memory_index_meta_v1";
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
// Concurrent embedding during sync. Without this, minimem embeds one request at a time
// (per file, awaited), which throttles remote providers to a single in-flight request
// (~1-2 emb/s regardless of how fast the backend is). The sync pre-warm fans the
// cache-miss embeddings out across these many concurrent batch requests, then the
// per-file index pass hits a warm cache. DB writes stay serial (node:sqlite is sync).
const EMBEDDING_SYNC_CONCURRENCY = 8;
const EMBEDDING_SYNC_BATCH_SIZE = 16;
// Embedding retry: tuned to ride out sustained rate-limit (429) storms from remote providers
// (e.g. Bedrock's per-account TPS cap) rather than aborting a whole index build on one transient
// failure. Generous attempts + capped exponential backoff with jitter; honors a server Retry-After.
const EMBEDDING_RETRY_MAX_ATTEMPTS = 8;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 30_000;
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 60_000;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 60_000;

/** A server-provided Retry-After delay (ms) attached to an embedding error by the provider, if any. */
function retryAfterMs(err: unknown): number | undefined {
  const v = (err as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

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
  /** Indexing throughput configuration */
  indexing?: {
    /** Concurrent embedding requests during the sync pre-warm (default: 8). Remote
     *  providers were otherwise embedded one request at a time (~1-2 emb/s); this fans
     *  the cache-miss embeddings out. DB writes stay serial. Set 1 to disable concurrency. */
    embedConcurrency?: number;
    /** Texts per embedding request in the pre-warm (default: 16). */
    embedBatchSize?: number;
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
    /** FTS query mode: "or" (default, any term) or "and" (all terms required).
     *  AND collapses to near-zero recall on multi-term/natural-language queries
     *  (BEIR ArguAna nDCG@10: AND 0.000 vs OR 0.356), so OR is the default. */
    ftsQueryMode?: "and" | "or";
    /** Fusion strategy: "rrf" (default; reciprocal rank fusion, rank-based & scale-free)
     *  or "weighted" (score-weighted sum of vector + BM25). RRF avoids the
     *  cosine-vs-BM25 scale mismatch and scored higher in eval (nDCG@10 0.729 vs 0.719). */
    fusion?: "weighted" | "rrf";
    /** RRF rank constant (default: 60). Only used when fusion === "rrf". */
    rrfK?: number;
  };
  /** Query configuration */
  query?: {
    /** Max results (default: 10) */
    maxResults?: number;
    /** Min score threshold (default: 0.3) */
    minScore?: number;
  };
  /** Knowledge-graph configuration (additive; all behavior off by default). */
  graph?: {
    /** Auto-derive entity co-occurrence edges at sync time (default false). */
    autoEntityLinks?: boolean;
    /** Skip entities appearing in more than this many notes (noise hubs). Default 24. */
    maxEntityFanout?: number;
    /** Cap co-entity edges added per note. Default 16. */
    maxLinksPerNote?: number;
  };
  /**
   * Post-fusion result selection (additive; every option defaults to previous behaviour).
   *
   * Hybrid fusion ranks by relevance alone, so the top-k can be k views of one passage
   * while other facts the query asked for never surface. These knobs trade a little
   * relevance for coverage, currency and layer balance, and exist to be ablated.
   */
  retrieval?: {
    /** Redundancy penalty in [0,1]. 0 (default) = pure relevance order. */
    diversity?: number;
    /** Drop candidates superseded by another candidate in the pool (default false). */
    supersede?: boolean;
    /** Blend normalised recency into the score, [0,1]. 0 (default) = off. */
    recency?: number;
    /** Per-knowledge-type floors, e.g. `{ observation: 20, "domain-summary": 6 }`. */
    quotas?: Record<string, number>;
    /**
     * Apply the store's redaction manifest to every content-returning path (default true).
     * Costs one `stat` per call when no manifest exists. Exists to be switched off for
     * ablation; switching it off in production re-exposes redacted facts.
     */
    redaction?: boolean;
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
  private readonly indexing: { embedConcurrency: number; embedBatchSize: number };
  private readonly hybrid: {
    enabled: boolean;
    vectorWeight: number;
    textWeight: number;
    candidateMultiplier: number;
    ftsQueryMode: "and" | "or";
    fusion: "weighted" | "rrf";
    rrfK: number;
  };
  private readonly queryConfig: { maxResults: number; minScore: number };
  private readonly retrievalConfig: {
    diversity: number;
    supersede: boolean;
    recency: number;
    quotas?: Record<string, number>;
    redaction: boolean;
  };
  /** Redaction rules, reloaded when the manifest's mtime changes. */
  private redactionCache: { mtimeMs: number; rules: RedactionRule[] } | null = null;
  private readonly graphConfig: {
    autoEntityLinks: boolean;
    maxEntityFanout: number;
    maxLinksPerNote: number;
  };
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
    this.dbPath = config.dbPath ?? path.join(this.memoryDir, resolveMinimemSubdir(this.memoryDir), "index.db");
    this.chunking = {
      tokens: config.chunking?.tokens ?? 256,
      overlap: config.chunking?.overlap ?? 32,
    };
    this.cache = {
      enabled: config.cache?.enabled ?? true,
      maxEntries: config.cache?.maxEntries ?? 10000,
    };
    this.indexing = {
      embedConcurrency: Math.max(1, config.indexing?.embedConcurrency ?? EMBEDDING_SYNC_CONCURRENCY),
      embedBatchSize: Math.max(1, config.indexing?.embedBatchSize ?? EMBEDDING_SYNC_BATCH_SIZE),
    };
    this.hybrid = {
      enabled: config.hybrid?.enabled ?? true,
      vectorWeight: config.hybrid?.vectorWeight ?? 0.7,
      textWeight: config.hybrid?.textWeight ?? 0.3,
      candidateMultiplier: config.hybrid?.candidateMultiplier ?? 2.0,
      ftsQueryMode: config.hybrid?.ftsQueryMode ?? "or",
      fusion: config.hybrid?.fusion ?? "rrf",
      rrfK: config.hybrid?.rrfK ?? 60,
    };
    this.queryConfig = {
      maxResults: config.query?.maxResults ?? 10,
      minScore: config.query?.minScore ?? 0.3,
    };
    this.retrievalConfig = {
      diversity: config.retrieval?.diversity ?? 0,
      supersede: config.retrieval?.supersede ?? false,
      recency: config.retrieval?.recency ?? 0,
      ...(config.retrieval?.quotas ? { quotas: config.retrieval.quotas } : {}),
      redaction: config.retrieval?.redaction ?? true,
    };
    this.graphConfig = {
      autoEntityLinks: config.graph?.autoEntityLinks ?? false,
      maxEntityFanout: config.graph?.maxEntityFanout ?? 24,
      maxLinksPerNote: config.graph?.maxLinksPerNote ?? 16,
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
    this.db = await this.openDatabase();
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

  private async openDatabase(): Promise<DatabaseSync> {
    const dbDir = path.dirname(this.dbPath);
    ensureDir(dbDir);
    // Cross-runtime open (node:sqlite / bun:sqlite). allowExtension (Node) and
    // setCustomSQLite (Bun) enable sqlite-vec where possible; otherwise minimem
    // falls back to brute-force JS cosine. See ./db/open-db.ts.
    return openSqliteDatabase(this.dbPath);
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
    opts?: {
      maxResults?: number;
      minScore?: number;
      type?: string;
      skipStaleCheck?: boolean;
      /** Expand seed results by `graphExpand` hops through knowledge_links (default 0 = off). */
      graphExpand?: number;
    },
  ): Promise<MinimemSearchResult[]> {
    const seeds = await this.searchWithFilter(query, opts, { sql: "", params: [] });
    const graphExpand = opts?.graphExpand ?? 0;
    if (graphExpand <= 0) return seeds;
    return this.expandWithGraph(seeds, graphExpand, opts?.maxResults ?? this.queryConfig.maxResults);
  }

  /**
   * Graph-aware expansion: for each seed with a knowledge_id, traverse
   * `knowledge_links` up to `depth` hops and append representative chunks for
   * neighbor notes not already among the seeds. Seeds are returned first (their
   * scores untouched); neighbors get a small score just below the lowest seed.
   * Result is deduped by path and capped at `maxResults` seeds + `maxResults`
   * expansion slots.
   */
  private expandWithGraph(
    seeds: MinimemSearchResult[],
    depth: number,
    maxResults: number,
  ): MinimemSearchResult[] {
    if (seeds.length === 0) return seeds;

    // Resolve each seed's knowledge_id (traversal root). The public result type
    // has no knowledge_id, so look it up by path rather than widen the type.
    const seedKnowledgeIds = new Set<string>();
    const roots: string[] = [];
    for (const seed of seeds) {
      const row = this.db
        .prepare(`SELECT knowledge_id FROM chunks WHERE path = ? AND knowledge_id IS NOT NULL LIMIT 1`)
        .get(seed.path) as { knowledge_id: string } | undefined;
      if (row?.knowledge_id && !seedKnowledgeIds.has(row.knowledge_id)) {
        seedKnowledgeIds.add(row.knowledge_id);
        roots.push(row.knowledge_id);
      }
    }
    if (roots.length === 0) return seeds;

    const lowestSeed = seeds.reduce((min, r) => Math.min(min, r.score), seeds[0].score);
    const neighborScore = lowestSeed > 0 ? lowestSeed * 0.5 : 0.1;

    const budget = maxResults + maxResults; // seeds + equal expansion budget
    const seenPaths = new Set(seeds.map((r) => r.path));
    const addedIds = new Set<string>();
    const expanded: MinimemSearchResult[] = [...seeds];

    for (const rootId of roots) {
      if (expanded.length >= budget) break;
      const neighbors = getNeighbors(this.db, rootId, depth);
      for (const neighbor of neighbors) {
        if (expanded.length >= budget) break;
        if (seedKnowledgeIds.has(neighbor.id) || addedIds.has(neighbor.id)) continue;
        const chunk = this.db
          .prepare(`SELECT path, start_line, end_line, text FROM chunks WHERE knowledge_id = ? LIMIT 1`)
          .get(neighbor.id) as
          | { path: string; start_line: number; end_line: number; text: string }
          | undefined;
        if (!chunk || seenPaths.has(chunk.path)) continue;
        seenPaths.add(chunk.path);
        addedIds.add(neighbor.id);
        expanded.push({
          path: chunk.path,
          startLine: chunk.start_line,
          endLine: chunk.end_line,
          score: neighborScore,
          snippet: chunk.text.slice(0, SNIPPET_MAX_CHARS),
        });
      }
    }

    return expanded;
  }

  /**
   * Core search. `knowledgeFilter` is an optional metadata WHERE (clauses on the
   * chunks alias `c`, from buildKnowledgeFilterSql) pushed directly into the
   * vector and FTS SQL so filtering happens in-query rather than as a post-pass.
   */
  private async searchWithFilter(
    query: string,
    opts: { maxResults?: number; minScore?: number; type?: string; skipStaleCheck?: boolean } | undefined,
    knowledgeFilter: { sql: string; params: (string | number)[] },
  ): Promise<MinimemSearchResult[]> {
    // Check staleness: use dirty flag if watcher is on, otherwise check mtimes.
    // `skipStaleCheck` lets a caller that knows the index is current avoid the
    // O(files) stat sweep per query (e.g. a batch eval over a static corpus);
    // a pending write (this.dirty) still forces a sync.
    const staleCheck = !opts?.skipStaleCheck && !this.watchConfig.enabled;
    if (this.dirty || (staleCheck && (await this.isStale()))) {
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

    // Skip a search arm entirely when its weight is 0, so callers get clean
    // pure-vector (textWeight: 0) or pure-BM25 (vectorWeight: 0) rankings —
    // and BM25-only runs avoid the embedding call.
    const runKeyword =
      this.hybrid.enabled && this.fts.available && this.hybrid.textWeight > 0;
    const runVector = this.hybrid.vectorWeight > 0;

    const keywordResults = runKeyword
      ? await searchKeyword({
          db: this.db,
          ftsTable: FTS_TABLE,
          providerModel: this.provider.model,
          query: cleaned,
          limit: candidates,
          snippetMaxChars: SNIPPET_MAX_CHARS,
          sourceFilter,
          buildFtsQuery: (raw) => buildFtsQuery(raw, this.hybrid.ftsQueryMode),
          bm25RankToScore,
          knowledgeFilter,
        }).catch(() => [])
      : [];

    const queryVec = runVector ? await this.embedQueryWithTimeout(cleaned) : [];
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
          knowledgeFilter,
        }).catch(() => [])
      : [];

    // Apply type filter if specified
    const typeFilterFn = opts?.type
      ? (id: string) => {
          const row = this.db
            .prepare(`SELECT type FROM chunks WHERE id = ?`)
            .get(id) as { type: string | null } | undefined;
          return row?.type === opts.type;
        }
      : undefined;

    if (!this.hybrid.enabled) {
      let results = vectorResults;
      if (typeFilterFn) results = results.filter((r) => typeFilterFn(r.id));
      return results
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

    let filteredVector = vectorResults;
    let filteredKeyword = keywordResults;
    if (typeFilterFn) {
      filteredVector = vectorResults.filter((r) => typeFilterFn(r.id));
      filteredKeyword = keywordResults.filter((r) => typeFilterFn(r.id));
    }

    const merged = mergeHybridResults({
      vector: filteredVector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
      })),
      keyword: filteredKeyword.map((r) => ({
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
      fusion: this.hybrid.fusion,
      rrfK: this.hybrid.rrfK,
    });

    const eligible = merged.filter((entry) => entry.score >= minScore);

    // Fast path: with no selection options set, this is the previous behaviour exactly —
    // score-ordered truncation, and no per-candidate metadata lookup.
    const sel = this.retrievalConfig;
    const selectionOn =
      sel.diversity > 0 || sel.recency > 0 || sel.supersede || (sel.quotas && Object.keys(sel.quotas).length > 0);
    const withMeta = selectionOn
      ? eligible.map((r) => ({ ...r, ...this.selectionMetadata(r.id) }))
      : eligible.map((r) => ({ ...r }));
    const chosen = selectionOn
      ? selectResults(withMeta, {
          limit: maxResults,
          diversity: sel.diversity,
          recency: sel.recency,
          supersede: sel.supersede,
          ...(sel.quotas ? { quotas: sel.quotas } : {}),
        })
      : withMeta.slice(0, maxResults);

    // Redaction is applied to what is *returned*, and a result that redacts down to nothing
    // is dropped rather than returned empty. Dropping would silently shrink the result set,
    // so backfill from the candidates selection left behind.
    //
    // Note the deliberate limit: rules do not affect *ranking*, so a query for a redacted
    // fact still ranks its note highly. That is an existence side channel, not a content
    // leak; closing it would mean redacting before scoring, at a cost the default path
    // should not pay.
    const rules = this.retrievalConfig.redaction ? this.loadRedactionRules() : [];
    if (rules.length === 0) {
      return chosen.map((r) => ({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        snippet: r.snippet,
      }));
    }

    const chosenIds = new Set(chosen.map((r) => r.id));
    const ordered = [...chosen, ...withMeta.filter((r) => !chosenIds.has(r.id))];
    const out: MinimemSearchResult[] = [];
    for (const r of ordered) {
      if (out.length >= maxResults) break;
      const { text } = applyRedactions(r.snippet, rules, { path: r.path });
      if (isFullyRedacted(text)) continue;
      out.push({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        snippet: text,
      });
    }
    return out;
  }

  /** Absolute path of the store's redaction manifest. */
  private redactionManifestPath(): string {
    return path.join(this.memoryDir, ".redactions.jsonl");
  }

  /**
   * Load redaction rules, re-reading only when the manifest changes. Rules live in a file
   * rather than the index because memory files are the source of truth: an index-only
   * redaction is undone by the next sync, which turns a privacy guarantee into a leak that
   * reappears on a schedule.
   */
  private loadRedactionRules(): RedactionRule[] {
    const file = this.redactionManifestPath();
    let mtimeMs: number;
    try {
      mtimeMs = fsSync.statSync(file).mtimeMs;
    } catch {
      this.redactionCache = null;
      return [];
    }
    if (this.redactionCache && this.redactionCache.mtimeMs === mtimeMs) {
      return this.redactionCache.rules;
    }
    try {
      const rules = parseRedactionManifest(fsSync.readFileSync(file, "utf-8"));
      this.redactionCache = { mtimeMs, rules };
      return rules;
    } catch {
      return this.redactionCache?.rules ?? [];
    }
  }

  /**
   * Metadata a selection pass needs but fusion does not carry. Looked up only when a
   * selection option is active, so the default retrieval path is unchanged.
   */
  private selectionMetadata(id: string): {
    knowledgeType?: string | null;
    knowledgeId?: string | null;
    supersedes?: string | null;
    createdAt?: number | null;
  } {
    const row = this.db
      .prepare(
        `SELECT knowledge_type, knowledge_id, supersedes, created_at_ms FROM chunks WHERE id = ?`,
      )
      .get(id) as
      | {
          knowledge_type: string | null;
          knowledge_id: string | null;
          supersedes: string | null;
          created_at_ms: number | null;
        }
      | undefined;
    if (!row) return {};
    return {
      knowledgeType: row.knowledge_type,
      knowledgeId: row.knowledge_id,
      supersedes: row.supersedes,
      createdAt: row.created_at_ms,
    };
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
    const toIndex: MemoryFileEntry[] = [];

    for (const absPath of files) {
      const entry = await buildFileEntry(absPath, this.memoryDir);
      activePaths.add(entry.path);

      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "memory") as { hash: string } | undefined;

      if (!needsFullReindex && record?.hash === entry.hash) {
        continue;
      }

      toIndex.push(entry);
    }

    // Pre-warm embeddings for everything we're about to index, fanned out across many
    // concurrent requests, so the per-file indexFile pass below hits a warm cache instead
    // of blocking on one in-flight embedding at a time. (No-op for the "none" provider or
    // when the cache is disabled — those fall back to per-file embedding.)
    await this.prewarmEmbeddingCache(toIndex);

    for (const entry of toIndex) {
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
      this.db.prepare(`DELETE FROM knowledge_links WHERE source_path = ?`).run(stale.path);
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

    // Auto-derive entity co-occurrence edges (opt-in; leaves frontmatter links untouched).
    if (this.graphConfig.autoEntityLinks) this.rebuildAutoEntityLinks();

    this.dirty = false;
    this.debug?.(`memory sync complete`, { files: files.length });
  }

  /**
   * Rebuild the auto-derived entity co-occurrence graph.
   *
   * Connects knowledge notes that share an entity with a `co-entity`/`entity`
   * edge (weight 0.5, `source_path = 'auto:entity'`). Only auto edges are cleared
   * and rebuilt each run — frontmatter-authored links (any other `source_path`)
   * are never touched. Entities appearing in more than `maxEntityFanout` notes are
   * treated as noise hubs and skipped, and each note gains at most `maxLinksPerNote`
   * auto edges per build.
   */
  private rebuildAutoEntityLinks(): void {
    // Clear prior auto edges so a re-sync rebuilds cleanly.
    this.db.prepare(`DELETE FROM knowledge_links WHERE source_path = ?`).run("auto:entity");

    const rows = this.db
      .prepare(
        `SELECT DISTINCT knowledge_id, entities FROM chunks
         WHERE knowledge_id IS NOT NULL AND entities IS NOT NULL`,
      )
      .all() as Array<{ knowledge_id: string; entities: string }>;

    // Map each entity -> the set of knowledge ids that reference it.
    const idsByEntity = new Map<string, Set<string>>();
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.entities);
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;
      for (const raw of parsed) {
        if (typeof raw !== "string") continue;
        const entity = raw.trim();
        if (!entity) continue;
        let set = idsByEntity.get(entity);
        if (!set) {
          set = new Set<string>();
          idsByEntity.set(entity, set);
        }
        set.add(row.knowledge_id);
      }
    }

    const now = Date.now();
    // Per-id auto-edge counter for this build, to bound fan-out per note.
    const autoEdgeCount = new Map<string, number>();
    const insert = this.db.prepare(
      `INSERT OR IGNORE INTO knowledge_links (from_id, to_id, relation, layer, weight, source_path, created_at)
       VALUES (?, ?, 'co-entity', 'entity', 0.5, 'auto:entity', ?)`,
    );

    for (const [entity, idSet] of idsByEntity) {
      if (idSet.size < 2) continue;
      if (idSet.size > this.graphConfig.maxEntityFanout) {
        this.debug?.(
          `auto-entity: skipping hub entity "${entity}" (${idSet.size} notes > maxEntityFanout ${this.graphConfig.maxEntityFanout})`,
        );
        continue;
      }
      // Sorted ids so we only emit edges (a, b) with a < b (string compare).
      const ids = [...idSet].sort();
      for (let i = 0; i < ids.length; i++) {
        const a = ids[i];
        if ((autoEdgeCount.get(a) ?? 0) >= this.graphConfig.maxLinksPerNote) continue;
        for (let j = i + 1; j < ids.length; j++) {
          const b = ids[j];
          if ((autoEdgeCount.get(a) ?? 0) >= this.graphConfig.maxLinksPerNote) break;
          if ((autoEdgeCount.get(b) ?? 0) >= this.graphConfig.maxLinksPerNote) continue;
          insert.run(a, b, now);
          autoEdgeCount.set(a, (autoEdgeCount.get(a) ?? 0) + 1);
          autoEdgeCount.set(b, (autoEdgeCount.get(b) ?? 0) + 1);
        }
      }
    }
  }

  private async indexFile(entry: MemoryFileEntry): Promise<void> {
    const content = await fs.readFile(entry.absPath, "utf-8");
    const chunks = chunkMarkdown(content, this.chunking);

    // Extract knowledge frontmatter
    const { frontmatter } = parseFrontmatter(content);
    const knowledgeType = frontmatter?.type ?? null;
    const knowledgeId = frontmatter?.id ?? null;
    const domains = frontmatter?.domain ?? null;
    const entities = frontmatter?.entities ?? null;
    const confidence = frontmatter?.confidence ?? null;
    const links = frontmatter?.links ?? null;
    // `supersedes` has been in the frontmatter convention and parsed by session.ts since the
    // knowledge format landed, but was never persisted -- so retrieval had no way to tell a
    // superseded note from the note that replaced it. `created` is the note's stated date,
    // which is what recency should rank on rather than file mtime.
    const supersedes = frontmatter?.supersedes ?? null;
    const createdMs = (() => {
      const raw = frontmatter?.created;
      if (!raw) return null;
      const t = Date.parse(String(raw));
      return Number.isFinite(t) ? t : null;
    })();

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

    // Delete old knowledge links for this file path on re-index
    this.db.prepare(`DELETE FROM knowledge_links WHERE source_path = ?`).run(entry.path);

    // Insert new chunks
    const now = Date.now();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const embedding = embeddings[i] ?? [];
      const chunkId = randomUUID();
      const meta = extractChunkMetadata(chunk.text);

      this.db
        .prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, type, knowledge_type, knowledge_id, domains, entities, confidence, supersedes, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          meta.type ?? null,
          knowledgeType,
          knowledgeId,
          domains ? JSON.stringify(domains) : null,
          entities ? JSON.stringify(entities) : null,
          confidence,
          supersedes,
          createdMs,
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

    // Upsert knowledge links if present
    if (links && knowledgeId) {
      const upsertLink = this.db.prepare(
        `INSERT OR REPLACE INTO knowledge_links (from_id, to_id, relation, layer, weight, source_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const link of links) {
        upsertLink.run(
          knowledgeId,
          link.target,
          link.relation,
          link.layer ?? null,
          0.5,
          entry.path,
          now,
        );
      }
    }
  }

  /**
   * Embed the cache-miss chunks across {@link toIndex} concurrently and populate the
   * embedding cache, so the per-file index pass that follows finds them already cached.
   *
   * The concurrency is only over network embedding requests; every cache write is a
   * synchronous sqlite op (atomic on the single event-loop thread), so there is no
   * concurrent-write hazard. Skipped when there is nothing remote to gain — the "none"
   * provider (BM25-only) or a disabled cache (per-file embedding would re-embed anyway).
   */
  private async prewarmEmbeddingCache(toIndex: MemoryFileEntry[]): Promise<void> {
    if (this.provider.id === "none" || !this.cache.enabled || toIndex.length === 0) return;

    // Collect unique chunk texts by content hash across all files to index (dedups
    // identical chunks so the same content is never embedded twice).
    const textByHash = new Map<string, string>();
    for (const entry of toIndex) {
      const content = await fs.readFile(entry.absPath, "utf-8");
      for (const chunk of chunkMarkdown(content, this.chunking)) {
        if (!textByHash.has(chunk.hash)) textByHash.set(chunk.hash, chunk.text);
      }
    }
    if (textByHash.size === 0) return;

    // Embed only the cache misses.
    const cached = this.loadEmbeddingCache([...textByHash.keys()]);
    const missing = [...textByHash.keys()].filter((h) => !cached.has(h));
    if (missing.length === 0) return;

    // Split into request-sized batches, then drain them with up to embedConcurrency in flight.
    const batches: string[][] = [];
    for (let i = 0; i < missing.length; i += this.indexing.embedBatchSize) {
      batches.push(missing.slice(i, i + this.indexing.embedBatchSize));
    }
    this.debug?.("prewarm embeddings starting", {
      chunks: missing.length,
      batches: batches.length,
      concurrency: this.indexing.embedConcurrency,
    });

    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (let index = cursor++; index < batches.length; index = cursor++) {
        const hashes = batches[index];
        const vectors = await this.embedBatchWithRetry(hashes.map((h) => textByHash.get(h)!));
        for (let j = 0; j < hashes.length; j++) {
          this.upsertEmbeddingCache(hashes[j], vectors[j] ?? []);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.indexing.embedConcurrency, batches.length) }, () => worker()),
    );
    this.debug?.("prewarm embeddings complete", { chunks: missing.length });
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
          await this.embedRetryBackoff(attempt, lastError);
        }
      }
    }
    throw lastError;
  }

  /**
   * Sleep before the next embedding retry: capped exponential backoff with equal-jitter (avoids a
   * synchronized retry herd when many concurrent requests are throttled at once); a server-provided
   * Retry-After wins. Shared by the corpus-batch and per-query embedding paths.
   */
  private async embedRetryBackoff(attempt: number, lastError: Error): Promise<void> {
    const capped = Math.min(
      EMBEDDING_RETRY_MAX_DELAY_MS,
      EMBEDDING_RETRY_BASE_DELAY_MS * Math.pow(2, attempt),
    );
    const jittered = capped / 2 + Math.random() * (capped / 2);
    const delay = Math.max(jittered, retryAfterMs(lastError) ?? 0);
    this.debug?.(`embedding retry`, { attempt: attempt + 1, delayMs: Math.round(delay), error: lastError.message });
    await new Promise((resolve) => setTimeout(resolve, delay));
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
    // Reuse the content-hash embedding cache for queries: identical query text (or a corpus chunk
    // with the same text) embeds once and is shared across arms/runs — resume-friendly and avoids
    // re-embedding every query per arm.
    const hash = hashText(text);
    const cached = this.loadEmbeddingCache([hash]).get(hash);
    if (cached && cached.length > 0) return cached;

    const timeout =
      this.provider.id === "local" ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;

    // Same resilient retry as corpus embedding: ride out transient rate-limit/connection failures
    // instead of failing the whole search (and, in batch callers, the whole run) on one bad fetch.
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < EMBEDDING_RETRY_MAX_ATTEMPTS; attempt++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeout);
      try {
        const result = await Promise.race([
          this.provider.embedQuery(text),
          new Promise<number[]>((_, reject) => {
            ac.signal.addEventListener("abort", () => reject(new Error("embedding query timeout")));
          }),
        ]);
        if (result.length > 0) this.upsertEmbeddingCache(hash, result);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < EMBEDDING_RETRY_MAX_ATTEMPTS - 1) await this.embedRetryBackoff(attempt, lastError);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  private loadEmbeddingCache(hashes: string[]): Map<string, number[]> {
    const result = new Map<string, number[]>();
    if (!this.cache.enabled || hashes.length === 0) return result;

    // Batched deliberately. Querying every hash in one statement spreads the
    // array into `.all()`, which overflows the call stack once the argument
    // count gets large — measured at ~124,380 args on Node 22. A single
    // 10M-token BEAM conversation produces well past that, and it surfaced as
    // `RangeError: Maximum call stack size exceeded` only after 2.5 hours of
    // extraction had already been paid for.
    //
    // (This build's SQLite tolerates >50k host parameters, so the placeholder
    // count is not the binding constraint here — the spread is. Batching fixes
    // both regardless, and keeps the query well inside any SQLITE_MAX_VARIABLE_
    // NUMBER a different build might impose.)
    const BATCH = 400;
    const touch = this.db.prepare(
      `UPDATE ${EMBEDDING_CACHE_TABLE} SET updated_at = ?
       WHERE provider = ? AND model = ? AND provider_key = ? AND hash = ?`,
    );
    const now = Date.now();

    for (let i = 0; i < hashes.length; i += BATCH) {
      const batch = hashes.slice(i, i + BATCH);
      const placeholders = batch.map(() => "?").join(",");
      const rows = this.db
        .prepare(
          `SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE}
           WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`,
        )
        .all(this.provider.id, this.provider.model, this.providerKey, ...batch) as Array<{
        hash: string;
        embedding: string;
      }>;

      for (const row of rows) {
        result.set(row.hash, parseEmbedding(row.embedding));
        // Touch for LRU
        touch.run(now, this.provider.id, this.provider.model, this.providerKey, row.hash);
      }
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
    const raw = await this.readFileRaw(relativePath);
    if (raw === null) return null;
    const rules = this.retrievalConfig.redaction ? this.loadRedactionRules() : [];
    if (rules.length === 0) return raw;
    return applyRedactions(raw, rules, { path: relativePath }).text;
  }

  /**
   * Unredacted read. Private on purpose: indexing reads files directly via `fs`, so the only
   * internal caller is `readLines`, which must slice against original line numbers.
   */
  private async readFileRaw(relativePath: string): Promise<string | null> {
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
    // Slice the raw file: a search result's startLine/endLine index the file as indexed, and
    // block redaction removes lines. Redacting first would shift every offset and return the
    // wrong region. Redaction is applied to the slice below instead.
    const content = await this.readFileRaw(relativePath);
    if (content === null) return null;

    const allLines = content.split("\n");
    const from = Math.max(1, opts?.from ?? 1);
    const lines = opts?.lines ?? allLines.length;

    const startIdx = from - 1;
    const endIdx = Math.min(startIdx + lines, allLines.length);
    const selectedLines = allLines.slice(startIdx, endIdx);

    const rules = this.retrievalConfig.redaction ? this.loadRedactionRules() : [];
    const sliced = selectedLines.join("\n");
    return {
      content:
        rules.length === 0
          ? sliced
          : applyRedactions(sliced, rules, { path: relativePath }).text,
      startLine: from,
      endLine: startIdx + selectedLines.length,
    };
  }

  /**
   * Redact a fact across the store: record a rule that every content-returning path then
   * applies. Deliberately does not rewrite memory files — see the note on `mode` below.
   *
   * The blast-radius guard is not incidental. The precursor to this API purged any literal
   * appearing in under a *third* of notes; it destroyed ~16 points of utility per domain at
   * zero benefit, and tightening that one threshold to 10% was the largest single scoring
   * improvement measured. A redaction matching most of the store is nearly always a
   * too-generic pattern rather than a genuine mass deletion, so it fails loudly.
   */
  async redact(
    input: RedactionRuleInput & {
      /** Refuse if the rule matches more than this share of notes. Default 0.10. */
      maxShare?: number;
      /**
       * Never refuse at or below this many matched notes, whatever the share. Default 3.
       *
       * A share threshold alone is meaningless on a small store — redacting one secret from
       * one note in a three-note store is 33% and entirely legitimate. The 10% figure was
       * derived from episodes holding hundreds of notes. What the guard is actually for is a
       * too-generic pattern sweeping a large store, which needs both a high share *and* a
       * meaningful absolute count.
       */
      minNotes?: number;
      /** Compute and return the plan without recording it. */
      dryRun?: boolean;
      /**
       * "store" (default) records a standing rule that also filters records written LATER.
       * "matched" pins the rule to the notes it matched at record time.
       *
       * The difference is not cosmetic. A store-scoped rule keeps firing forever, so when the
       * matched literal is not unique to the sensitive fact, later legitimate records get
       * redacted too: measured on a governance benchmark as marker density climbing from a
       * median of 11 per context in an episode's first quarter to 27-29 thereafter, costing
       * one domain 9.4 points of utility. It also silently outgrows the blast-radius guard,
       * which is evaluated once here and never re-checked -- a rule matching 1 note of 40 can
       * be matching 30 of 200 later.
       *
       * "store" is right for "never surface this string again"; "matched" is right for
       * "forget what these records said", which is what a deletion request usually means.
       */
      scope?: "store" | "matched";
    },
  ): Promise<{
    rule: RedactionRule;
    /** Memory-relative paths the rule matches. */
    matchedPaths: string[];
    totalNotes: number;
    share: number;
    applied: boolean;
  }> {
    const scope = input.scope ?? "store";
    let rule = normalizeRule({ ...input, at: input.at ?? new Date().toISOString() });
    const maxShare = input.maxShare ?? 0.1;
    const minNotes = input.minNotes ?? 3;
    const dryRun = input.dryRun ?? false;

    const files = await listMemoryFiles(this.memoryDir);
    const matchedPaths: string[] = [];
    for (const abs of files) {
      const rel = path.relative(this.memoryDir, abs);
      let content: string;
      try {
        content = await fs.readFile(abs, "utf-8");
      } catch {
        continue;
      }
      if (applyRedactions(content, [rule], { path: rel }).hits > 0) matchedPaths.push(rel);
    }
    const share = files.length === 0 ? 0 : matchedPaths.length / files.length;

    if (!dryRun && share > maxShare && matchedPaths.length > minNotes) {
      throw new Error(
        `Redaction refused: "${rule.match}" matches ${matchedPaths.length}/${files.length} ` +
          `notes (${(share * 100).toFixed(1)}%), above the ${(maxShare * 100).toFixed(1)}% ` +
          `blast-radius limit. Narrow the pattern, scope it with \`paths\`, or raise ` +
          `\`maxShare\` deliberately. Re-run with \`dryRun\` to inspect the matches.`,
      );
    }

    if (scope === "matched") {
      // Pin the rule to what it matched now. An empty match must NOT fall through to a
      // store-scoped rule: normalizeRule drops an empty `paths`, which would silently widen
      // the rule to the whole store -- the exact opposite of what was asked for.
      if (matchedPaths.length === 0) {
        return { rule, matchedPaths, totalNotes: files.length, share, applied: false };
      }
      rule = normalizeRule({ ...rule, paths: matchedPaths });
    }

    if (!dryRun) {
      const file = this.redactionManifestPath();
      await ensureDir(path.dirname(file));
      await fs.appendFile(file, `${serializeRedactionRule(rule)}\n`, "utf-8");
      this.redactionCache = null;
    }

    return { rule, matchedPaths, totalNotes: files.length, share, applied: !dryRun };
  }

  /** Rules currently in force. */
  listRedactions(): RedactionRule[] {
    return this.loadRedactionRules();
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

  /**
   * Search with knowledge metadata filters (domain, entities, confidence, type).
   * Runs a standard search then post-filters by knowledge columns.
   */
  async knowledgeSearch(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      domain?: string[];
      entities?: string[];
      minConfidence?: number;
      knowledgeType?: string;
    },
  ): Promise<MinimemSearchResult[]> {
    const cleaned = query.trim();
    if (!cleaned) return [];

    const minScore = opts?.minScore ?? this.queryConfig.minScore;
    const maxResults = opts?.maxResults ?? this.queryConfig.maxResults;

    // Build the metadata filter and push it directly into the search SQL.
    // An empty filter (no opts provided) makes this a regular search.
    const knowledgeFilter = buildKnowledgeFilterSql({
      domain: opts?.domain,
      entities: opts?.entities,
      minConfidence: opts?.minConfidence,
      knowledgeType: opts?.knowledgeType,
    });

    return this.searchWithFilter(query, { maxResults, minScore }, knowledgeFilter);
  }

  /**
   * Get knowledge graph links from or to a node.
   */
  getLinks(
    nodeId: string,
    direction: "from" | "to" = "from",
    opts?: { relation?: string; layer?: string },
  ): GraphLink[] {
    if (direction === "from") {
      return getLinksFrom(this.db, nodeId, opts);
    }
    return getLinksTo(this.db, nodeId, opts);
  }

  /**
   * Get neighbor nodes via BFS traversal.
   */
  getGraphNeighbors(
    nodeId: string,
    depth: number = 1,
    opts?: { relation?: string; layer?: string },
  ): GraphNeighbor[] {
    return getNeighbors(this.db, nodeId, depth, opts);
  }

  /**
   * Find shortest path between two knowledge nodes.
   */
  getGraphPath(fromId: string, toId: string, maxDepth: number = 3): GraphLink[] {
    return getPathBetween(this.db, fromId, toId, maxDepth);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const providerClose = this.provider.close?.();

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

    try {
      await providerClose;
    } catch (err) {
      logError("providerClose", err, this.debug);
    }
  }
}
