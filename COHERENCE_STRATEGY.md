# Minimem Coherence Strategy

A roadmap for streamlining the codebase and creating a unified, predictable user experience.

---

## Vision

Minimem should feel like **one tool** with consistent behavior, not a collection of loosely connected commands. Users should be able to predict how any command works based on their experience with other commands.

### Core Principles

1. **Single Source of Truth** - Each concept has one canonical implementation
2. **Predictable Behavior** - Same flags work the same way everywhere
3. **Fail Loudly** - Errors should be visible and actionable
4. **Minimal Surface Area** - Remove unused code, consolidate duplicates
5. **Test Everything That Matters** - Critical paths must have coverage

---

## Phase 1: Foundation (Critical Fixes)

**Goal**: Fix bugs and establish patterns that other work will build on.

### 1.1 Centralize Directory Resolution

**Problem**: `resolveMemoryDir` is implemented differently in multiple places.

**Solution**: Create a single, authoritative implementation in `src/cli/shared.ts`:

```typescript
// src/cli/shared.ts
export type DirOptions = {
  dir?: string | string[];
  global?: boolean;
};

export function resolveMemoryDir(options: DirOptions): string {
  // Single directory resolution
  const dir = Array.isArray(options.dir) ? options.dir[0] : options.dir;

  if (dir) return path.resolve(dir);
  if (process.env.MEMORY_DIR) return path.resolve(process.env.MEMORY_DIR);
  if (options.global) return path.join(os.homedir(), ".minimem");
  return process.cwd();
}

export function resolveMemoryDirs(options: DirOptions): string[] {
  // Multi-directory resolution (for search, mcp)
  const dirs: string[] = [];

  if (options.dir) {
    const dirList = Array.isArray(options.dir) ? options.dir : [options.dir];
    dirs.push(...dirList.map(d => path.resolve(d)));
  }

  if (!options.dir && process.env.MEMORY_DIR) {
    dirs.push(path.resolve(process.env.MEMORY_DIR));
  }

  if (options.global) {
    dirs.push(path.join(os.homedir(), ".minimem"));
  }

  if (dirs.length === 0) {
    dirs.push(process.cwd());
  }

  return [...new Set(dirs)]; // Deduplicate
}
```

**Files to update**:
- `src/cli/commands/upsert.ts` - Remove local `resolveMemoryDir`
- `src/cli/commands/append.ts` - Import from shared
- `src/cli/commands/search.ts` - Use `resolveMemoryDirs`
- `src/cli/commands/mcp.ts` - Use `resolveMemoryDirs`
- All other command files

### 1.2 Fix Type Exports

**Problem**: `search.ts` imports `SearchResult` but `minimem.ts` exports `MinimemSearchResult`.

**Solution**:
1. Add `SearchResult` as an alias in `src/index.ts`:
   ```typescript
   export type { MinimemSearchResult as SearchResult } from "./minimem.js";
   ```
2. Or update all imports to use `MinimemSearchResult`

### 1.3 Fix Version Handling

**Problem**: Version hardcoded as `0.0.2` in CLI but `0.0.3` in package.json.

**Solution**: Read from package.json at build time:

```typescript
// src/cli/version.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
export const VERSION = pkg.version;
```

### 1.4 Fix BM25 Scoring

**Problem**: SQLite FTS5 BM25 ranks are negative (more negative = better match), but `bm25RankToScore` clamps to 0.

**Solution**: Update `src/search/hybrid.ts`:

```typescript
export function bm25RankToScore(rank: number): number {
  // BM25 ranks from FTS5 are negative (more negative = better)
  // Convert to 0-1 score where higher is better
  if (!Number.isFinite(rank)) return 0;
  const absRank = Math.abs(rank);
  return 1 / (1 + absRank);
}
```

### 1.5 Add Error Logging

**Problem**: Silent try/catch blocks hide errors.

**Solution**: Create error handling utilities:

```typescript
// src/internal.ts
export function logError(context: string, error: unknown, debug?: (msg: string) => void): void {
  const message = error instanceof Error ? error.message : String(error);
  if (debug) {
    debug(`[${context}] ${message}`);
  }
}

// Usage in minimem.ts
try {
  this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE id = ?`).run(chunkId);
} catch (error) {
  logError("deleteVectorEntry", error, this.debug);
}
```

---

## Phase 2: Unify Command Interface

**Goal**: Make all commands feel consistent.

### 2.1 Standardize Option Names

| Option | Meaning | Commands |
|--------|---------|----------|
| `-d, --dir` | Memory directory (single or multiple) | All |
| `-g, --global` | Include/use ~/.minimem | All |
| `-p, --provider` | Embedding provider | search, sync, status, append, upsert, mcp |
| `-n, --max` | Max results | search |
| `-s, --min-score` | Min score | search |
| `-f, --force` | Force operation | init, sync, push, pull |
| `--json` | JSON output | search, status, config, sync:conflicts, sync:log |
| `--dry-run` | Preview without changes | push, pull, sync:cleanup |

**Action**: Audit all commands and ensure consistent naming.

### 2.2 Standardize Multi-Directory Support

**Decision Point**: Should all commands support multiple directories?

**Recommendation**:
- **Multi-dir commands**: `search`, `mcp` (read-only, cross-directory operations)
- **Single-dir commands**: `init`, `sync`, `status`, `append`, `upsert`, `config`, all sync:* commands

**Rationale**: Write operations should target a specific directory to avoid ambiguity.

Update help text to make this clear:
```
search <query>    Search across multiple memory directories
  -d, --dir <path...>   Memory directories (can specify multiple)

sync              Re-index memory files in a single directory
  -d, --dir <path>      Memory directory (single)
```

### 2.3 Simplify `upsert` File Path Resolution

**Problem**: Current logic is confusing and inconsistent.

**Solution**: Make it explicit and predictable:

```typescript
function resolveFilePath(file: string, memoryDir: string): string {
  // Rule 1: Absolute paths are used as-is
  if (path.isAbsolute(file)) {
    return file;
  }

  // Rule 2: All relative paths are relative to memoryDir
  // Users must include "memory/" prefix if they want files there
  return path.join(memoryDir, file);
}
```

Update help text:
```
upsert <file> [content]   Create or update a memory file

  File paths are relative to the memory directory:
    minimem upsert MEMORY.md "content"        → {memoryDir}/MEMORY.md
    minimem upsert memory/notes.md "content"  → {memoryDir}/memory/notes.md
    minimem upsert /abs/path.md "content"     → /abs/path.md
```

### 2.4 Consistent Error Messages

Create a standard error format:

```typescript
// src/cli/errors.ts
export function exitWithError(message: string, suggestion?: string): never {
  console.error(`Error: ${message}`);
  if (suggestion) {
    console.error(`  Suggestion: ${suggestion}`);
  }
  process.exit(1);
}

export function warnWithNote(message: string): void {
  console.log(`Note: ${message}`);
}

// Usage
exitWithError(
  `${formatPath(memoryDir)} is not initialized.`,
  `Run: minimem init ${options.dir || ""}`
);
```

---

## Phase 3: Simplify Architecture

**Goal**: Reduce complexity and improve maintainability.

### 3.1 Evaluate Sync System Scope

The sync system (`src/cli/sync/`) represents ~40% of the codebase complexity:
- 12 source files
- Registry management
- State tracking
- Conflict resolution
- Daemon process
- Git operations

**Questions to answer**:
1. Is git-based sync the right abstraction for "memory for AI agents"?
2. Should sync be a separate package/plugin?
3. Are there simpler alternatives (e.g., Dropbox, iCloud, rsync)?

**Recommendation**: Consider making sync an optional add-on:
```
npm install minimem              # Core: search, index, MCP
npm install @minimem/sync        # Optional: git-based sync
```

### 3.2 Split Minimem Class

The main `Minimem` class handles too many concerns:

```
Current Minimem class responsibilities:
├── Database management (open, close, schema)
├── File operations (list, read, write, watch)
├── Embedding generation (provider, cache, batch)
├── Search (vector, keyword, hybrid merge)
├── Indexing (sync, staleness detection)
└── Session tracking (frontmatter parsing)
```

**Proposed structure**:

```typescript
// src/core/database.ts
export class MemoryDatabase {
  constructor(dbPath: string);
  ensureSchema(): void;
  close(): void;
  // Low-level DB operations
}

// src/core/indexer.ts
export class MemoryIndexer {
  constructor(db: MemoryDatabase, embedder: EmbeddingProvider);
  indexFile(path: string, content: string): Promise<void>;
  removeFile(path: string): void;
  isStale(): boolean;
}

// src/core/searcher.ts
export class MemorySearcher {
  constructor(db: MemoryDatabase, embedder: EmbeddingProvider);
  search(query: string, options: SearchOptions): Promise<SearchResult[]>;
}

// src/minimem.ts - Facade that composes the above
export class Minimem {
  private db: MemoryDatabase;
  private indexer: MemoryIndexer;
  private searcher: MemorySearcher;

  // High-level API unchanged
  async search(query: string): Promise<SearchResult[]>;
  async sync(): Promise<void>;
}
```

**Benefit**: Easier to test, understand, and maintain each piece.

### 3.3 Remove Unused Exports

From the audit, these appear unused externally:
- `listChunks` from `search/search.ts`
- `normalizeRelPath` from `internal.ts` (only internal use)

**Action**: Remove from `src/index.ts` exports, keep as internal.

### 3.4 Consolidate Duplicate Code

| Duplicate | Locations | Action |
|-----------|-----------|--------|
| `createDeterministicEmbedding` | 2 test files | Extract to `src/__tests__/helpers.ts` |
| `createMockFetch` | Multiple test files | Extract to `src/__tests__/helpers.ts` |
| `vectorToBlob` | minimem.ts, search.ts | Keep in internal.ts, import |
| `resolveMemoryDir` | config.ts, upsert.ts | Use single implementation (Phase 1) |

---

## Phase 4: Improve Test Coverage

**Goal**: Ensure critical paths are tested.

### 4.1 Create Test Utilities Module

```typescript
// src/__tests__/helpers.ts
export function createDeterministicEmbedding(text: string, dims = 384): number[] {
  const keywords = ["memory", "search", "index", "file", "embed"];
  const embedding = new Array(dims).fill(0);

  keywords.forEach((kw, i) => {
    if (text.toLowerCase().includes(kw)) {
      embedding[i * 10] = 0.8;
      embedding[i * 10 + 1] = 0.6;
    }
  });

  // Normalize
  const magnitude = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0)) || 1;
  return embedding.map(v => v / magnitude);
}

export function createMockEmbeddingProvider(dims = 384): EmbeddingProvider {
  return {
    embedQuery: async (text) => createDeterministicEmbedding(text, dims),
    embedBatch: async (texts) => texts.map(t => createDeterministicEmbedding(t, dims)),
    dimensions: dims,
    model: "mock",
    provider: "mock",
  };
}

export function createTempMemoryDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "minimem-test-"));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
```

### 4.2 Add Missing Test Categories

**Error path tests** (`src/__tests__/errors.test.ts`):
```typescript
describe("error handling", () => {
  it("handles embedding API timeout gracefully");
  it("handles database corruption");
  it("handles permission denied on memory directory");
  it("handles disk full during sync");
  it("handles invalid config file");
});
```

**Edge case tests** (`src/__tests__/edge-cases.test.ts`):
```typescript
describe("edge cases", () => {
  it("handles empty memory files");
  it("handles files with only frontmatter");
  it("handles very large files (>1MB)");
  it("handles unicode content (emoji, RTL)");
  it("handles files with Windows line endings");
  it("prevents indexing both MEMORY.md and memory.md");
});
```

**CLI integration tests** (`src/cli/__tests__/integration.test.ts`):
```typescript
describe("CLI integration", () => {
  it("init → append → search workflow");
  it("multi-directory search merges results correctly");
  it("respects MEMORY_DIR environment variable");
  it("--global flag works for all commands");
});
```

### 4.3 Add Performance Benchmarks

```typescript
// src/__tests__/benchmarks.test.ts
describe("performance", () => {
  it("indexes 100 files in under 10 seconds", async () => {
    // Create 100 test files
    // Time the sync
    // Assert < 10s
  });

  it("searches 1000 chunks in under 500ms", async () => {
    // Populate DB with 1000 chunks
    // Time 10 searches
    // Assert average < 500ms
  });
});
```

---

## Phase 5: Documentation and Polish

### 5.1 Fix Cross-Platform Issues

**postbuild script**: Replace macOS-specific `sed` with Node.js:

```javascript
// scripts/postbuild.js
import { readFileSync, writeFileSync } from "node:fs";

const filePath = "dist/cli/index.js";
let content = readFileSync(filePath, "utf-8");
content = content.replace(/from "sqlite"/g, 'from "node:sqlite"');
writeFileSync(filePath, content);
```

Update `package.json`:
```json
"postbuild": "node scripts/postbuild.js"
```

### 5.2 Add Schema Versioning

```typescript
// src/db/schema.ts
export const SCHEMA_VERSION = 2;

export function createSchema(db: DatabaseSync): void {
  // Check existing version
  const existing = getSchemaVersion(db);

  if (existing === SCHEMA_VERSION) return;

  if (existing > 0 && existing < SCHEMA_VERSION) {
    // Run migrations
    migrate(db, existing, SCHEMA_VERSION);
  } else {
    // Fresh install
    createTables(db);
    setSchemaVersion(db, SCHEMA_VERSION);
  }
}
```

### 5.3 Improve Error Messages for Common Issues

```typescript
// src/cli/diagnostics.ts
export function diagnoseSearchFailure(error: Error, config: CliConfig): string {
  if (error.message.includes("OPENAI_API_KEY")) {
    return `No OpenAI API key found.

Set it via environment variable:
  export OPENAI_API_KEY=sk-...

Or configure a different provider:
  minimem config --set embedding.provider=gemini
  minimem config --set embedding.provider=none  # BM25-only search`;
  }

  // ... other diagnostics
}
```

---

## Implementation Order

| Phase | Priority | Effort | Dependencies |
|-------|----------|--------|--------------|
| 1.1 Centralize directory resolution | High | Small | None |
| 1.2 Fix type exports | High | Tiny | None |
| 1.3 Fix version handling | Medium | Tiny | None |
| 1.4 Fix BM25 scoring | High | Small | None |
| 1.5 Add error logging | High | Small | None |
| 2.1 Standardize options | Medium | Medium | 1.1 |
| 2.2 Standardize multi-dir | Medium | Small | 1.1 |
| 2.3 Simplify upsert paths | Medium | Small | 1.1 |
| 2.4 Consistent errors | Medium | Medium | None |
| 3.1 Evaluate sync scope | Low | Discussion | None |
| 3.2 Split Minimem class | Low | Large | Tests |
| 3.3 Remove unused exports | Low | Tiny | None |
| 3.4 Consolidate duplicates | Low | Small | None |
| 4.1 Test utilities | Medium | Small | None |
| 4.2 Missing test categories | Medium | Medium | 4.1 |
| 4.3 Performance benchmarks | Low | Medium | 4.1 |
| 5.1 Cross-platform fixes | Medium | Tiny | None |
| 5.2 Schema versioning | Low | Medium | None |
| 5.3 Error diagnostics | Low | Medium | None |

---

## Success Metrics

After implementing this strategy, the codebase should exhibit:

1. **Consistency**: Same flag works identically across all commands
2. **Predictability**: Users can guess command behavior from patterns
3. **Testability**: >80% coverage on critical paths
4. **Debuggability**: Errors include context and suggestions
5. **Maintainability**: Clear module boundaries, no duplicate code

---

## Appendix: Command Matrix

| Command | Single Dir | Multi Dir | `--global` | `--provider` | `--json` |
|---------|------------|-----------|------------|--------------|----------|
| init | Yes | No | Yes | No | No |
| search | No | Yes | Yes | Yes | Yes |
| sync | Yes | No | Yes | Yes | No |
| status | Yes | No | Yes | Yes | Yes |
| append | Yes | No | Yes | Yes | No |
| upsert | Yes | No | Yes | Yes | No |
| mcp | No | Yes | Yes | Yes | No |
| config | Yes | No | Yes | No | Yes |
| push | Yes | No | Yes | No | No |
| pull | Yes | No | Yes | No | No |
| sync:* | Yes | No | Yes | No | Varies |
| daemon* | N/A | N/A | N/A | N/A | No |
