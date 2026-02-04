# Minimem Codebase Audit Report

This document outlines issues, incoherencies, bugs, and testing gaps identified in the minimem codebase.

## Executive Summary

The minimem codebase is a file-based memory system with vector search capabilities. While the core functionality is reasonably well-structured, there are several areas that need attention:

1. **User Story Incoherencies** - Inconsistent behaviors across related commands
2. **Bugs and Edge Cases** - Several error handling and logic issues
3. **Testing Gaps** - Missing test coverage for important scenarios
4. **Code Quality Issues** - Duplicated code, unused exports, and unclear patterns

---

## 1. User Story Incoherencies

### 1.1 Inconsistent Directory Resolution Logic

**Issue**: The `resolveMemoryDir` function is duplicated with different behaviors in different files.

- `src/cli/config.ts:131-149`: Uses `process.env.MEMORY_DIR` as second priority
- `src/cli/commands/upsert.ts:162-170`: Has its own `resolveMemoryDir` that ignores `MEMORY_DIR` env var

**Impact**: Users may get different behavior depending on which command they run.

**Recommendation**: Use a single `resolveMemoryDir` function from `config.ts` across all commands.

### 1.2 Inconsistent `--dir` Option Types

**Issue**: The `--dir` option accepts different types across commands:

- `search` and `mcp`: Accept `--dir <path...>` (array of paths)
- `sync`, `status`, `append`, `upsert`, `config`: Accept `--dir <path>` (single path)

**Impact**: Confusing user experience - some commands support multiple directories, others don't.

**Recommendation**: Either standardize on single directory for all commands, or document clearly which commands support multiple directories.

### 1.3 `upsert` File Path Resolution Ambiguity

**Issue**: In `src/cli/commands/upsert.ts:175-193`, the `resolveFilePath` function has confusing logic:

```typescript
// If starts with memory/, use relative to memory dir
if (file.startsWith("memory/") || file.startsWith("memory\\")) {
  return path.join(memoryDir, file);
}

// Otherwise, assume it's in the memory/ subdirectory
// Unless it's MEMORY.md or similar root file
if (file === "MEMORY.md" || file.endsWith(".md") && !file.includes("/")) {
  return path.join(memoryDir, file);
}

return path.join(memoryDir, "memory", file);
```

**Problems**:
1. `note.md` goes to `memoryDir/note.md` but `notes/daily.md` goes to `memoryDir/memory/notes/daily.md`
2. Operator precedence issue: `file.endsWith(".md") && !file.includes("/")` should have parentheses
3. Logic doesn't match CLI description "Create or update a memory file"

**Recommendation**: Simplify to explicit path handling - always require paths relative to memoryDir.

### 1.4 Search Command Uses `SearchResult` Type Not Exported from minimem.ts

**Issue**: `src/cli/commands/search.ts:9` imports `SearchResult` type:
```typescript
import { Minimem, type SearchResult } from "../../minimem.js";
```

But `src/minimem.ts` exports `MinimemSearchResult`, not `SearchResult`.

**Impact**: This is either a build error or a type that doesn't exist.

**Recommendation**: Fix the import to use `MinimemSearchResult`.

### 1.5 Version Mismatch

**Issue**: `src/cli/index.ts:25` hardcodes version as `"0.0.2"` but `package.json` has version `"0.0.3"`.

**Recommendation**: Read version from package.json or automate version updates.

---

## 2. Bugs and Edge Cases

### 2.1 `listMemoryFiles` May Include Both MEMORY.md and memory.md

**Issue**: In `src/internal.ts:63-86`:
```typescript
if (await exists(memoryFile)) result.push(memoryFile);
if (await exists(altMemoryFile)) result.push(altMemoryFile);
```

If both `MEMORY.md` and `memory.md` exist, both are added. The deduplication logic only works for symbolic links (realpath), not for different files.

**Impact**: If a user creates both files, they get indexed twice and may cause confusion.

**Recommendation**: Only allow one root memory file - error if both exist.

### 2.2 Silent Failure in Vector/FTS Operations

**Issue**: Throughout `src/minimem.ts`, database operations are wrapped in try/catch with empty catch blocks:

```typescript
try {
  this.db.prepare(`DELETE FROM ${VECTOR_TABLE} WHERE ...`).run(...);
} catch {}
```

Examples at lines: 540-546, 550-554, 589-595, 597-603, 636-641, 645-661.

**Impact**: Errors are silently swallowed, making debugging difficult.

**Recommendation**: At minimum, log errors to the debug function when available.

### 2.3 `bm25RankToScore` Negative Rank Handling

**Issue**: In `src/search/hybrid.ts:34-37`:
```typescript
export function bm25RankToScore(rank: number): number {
  const normalized = Number.isFinite(rank) ? Math.max(0, rank) : 999;
  return 1 / (1 + normalized);
}
```

BM25 ranks from SQLite FTS5 are **negative** (lower is better, with best being close to 0 going negative). The `Math.max(0, rank)` clamps all negative values to 0, making everything have score 1.

**Impact**: BM25 scoring may not work correctly for well-matching results.

**Recommendation**: Use `Math.abs(rank)` or investigate actual BM25 rank values from FTS5.

### 2.4 Race Condition in Sync

**Issue**: In `src/minimem.ts:485-497`:
```typescript
async sync(opts?: { reason?: string; force?: boolean }): Promise<void> {
  if (this.syncing) {
    await this.syncing;
    return;
  }
  this.syncing = this.runSync(opts);
  // ...
}
```

There's a race window between checking `this.syncing` and setting it. Multiple concurrent calls could both see `null` and start parallel syncs.

**Recommendation**: Use a proper mutex or lock mechanism.

### 2.5 Embedding Query Timeout Race

**Issue**: In `src/minimem.ts:771-781`:
```typescript
return Promise.race([
  this.provider.embedQuery(text),
  new Promise<number[]>((_, reject) =>
    setTimeout(() => reject(new Error("embedding query timeout")), timeout),
  ),
]);
```

If the embed query succeeds after the timeout, there's no cleanup - the Promise from `embedQuery` continues running.

**Impact**: Resource leak and potential for stale results.

**Recommendation**: Use `AbortController` or similar cancellation mechanism.

### 2.6 `ensureDir` Swallows All Errors

**Issue**: In `src/internal.ts:21-26`:
```typescript
export function ensureDir(dir: string): string {
  try {
    fsSync.mkdirSync(dir, { recursive: true });
  } catch {}
  return dir;
}
```

All errors are swallowed, including permission errors.

**Impact**: Could fail silently and cause confusing downstream errors.

**Recommendation**: Only catch `EEXIST` errors.

### 2.7 YAML Parser Limitations

**Issue**: The simple YAML parser in `src/session.ts:75-117` has several limitations:
- Only supports 2-level nesting
- Doesn't handle multi-line strings
- Doesn't handle list items with `-` syntax
- Doesn't preserve comments

**Impact**: Complex frontmatter may be parsed incorrectly or lost.

**Recommendation**: Use a proper YAML library or clearly document limitations.

### 2.8 Type Coercion in `createEmbeddingProvider`

**Issue**: In `src/embeddings/embeddings.ts:321-324`:
```typescript
if (requestedProvider === "none") {
  return {
    provider: createNoOpEmbeddingProvider(),
    requestedProvider: "none" as "auto", // Type coercion for compatibility
  };
}
```

And line 374:
```typescript
fallbackFrom: "auto" as "openai", // Indicate this is a fallback
```

These type coercions are misleading and indicate a type design issue.

**Recommendation**: Update the `EmbeddingProviderResult` type to properly handle "none" provider.

---

## 3. Testing Gaps

### 3.1 Missing Tests for Error Paths

The following error scenarios lack test coverage:

1. **Embedding API failures** - No tests for retries, timeouts, or rate limiting
2. **Database corruption** - No tests for schema migration or corrupt database
3. **Concurrent operations** - No tests for race conditions in sync
4. **File system errors** - No tests for permission denied, disk full, etc.
5. **Network failures** - No tests for partial batch responses

### 3.2 Missing Tests for CLI Commands

Some commands lack test coverage:

1. `sync:init-central` - No tests
2. `push` and `pull` - Limited tests
3. `daemon` commands - Basic daemon tests exist but no integration tests
4. `sync:validate` - No tests for edge cases

### 3.3 Missing Tests for Edge Cases

1. **Empty files** - No tests for indexing empty .md files
2. **Very large files** - No tests for files exceeding chunk limits
3. **Unicode content** - No tests for emoji, RTL text, etc.
4. **Symbolic links** - No tests for symlinked memory files
5. **Case sensitivity** - No tests for `MEMORY.md` vs `memory.md` on case-insensitive filesystems

### 3.4 Missing Integration Tests

1. **Multi-directory search** - CLI tests exist but no MCP server tests
2. **Sync system end-to-end** - Complex sync scenarios not tested
3. **Watch mode** - File watcher not tested with rapid changes
4. **Provider fallback** - Fallback chain not fully tested

### 3.5 No Performance Tests

No tests for:
- Large memory stores (1000+ files)
- Search latency benchmarks
- Embedding batch performance
- Database size growth

---

## 4. Code Quality Issues

### 4.1 Duplicated Code

1. **`createDeterministicEmbedding`** - Duplicated in `minimem.integration.test.ts` and `commands.test.ts`
2. **`createMockFetch`** - Duplicated in multiple test files
3. **Directory resolution logic** - Duplicated across command files
4. **`vectorToBlob`** - Defined in both `minimem.ts:46` and `search/search.ts:5`

### 4.2 Inconsistent Error Messages

Error messages vary in format:
- Some use `Error:` prefix
- Some use `Note:` or `Warning:`
- Some include suggestions, others don't
- Exit codes are inconsistent (some use 1, others don't exit)

### 4.3 Unused Exports

The following appear to be exported but not used externally:
- `listChunks` from `search/search.ts`
- `normalizeRelPath` from `internal.ts` (only used internally)

### 4.4 Missing JSDoc Comments

Many public functions lack documentation:
- `searchVector` and `searchKeyword` in `search/search.ts`
- Most CLI command functions
- Configuration types could use more description

### 4.5 postbuild Script Fragility

**Issue**: `package.json` postbuild script:
```json
"postbuild": "sed -i '' 's/from \"sqlite\"/from \"node:sqlite\"/g' dist/cli/index.js"
```

This only works on macOS (`-i ''`). On Linux, the syntax is different (`-i`).

**Recommendation**: Use a Node.js script for cross-platform compatibility.

---

## 5. Architecture Concerns

### 5.1 No Schema Versioning/Migration

The database schema has no version tracking or migration system. If schema changes are needed, users would need to delete their index.db.

### 5.2 Sync System Complexity

The sync system (`src/cli/sync/`) adds significant complexity:
- Registry management
- State tracking
- Conflict resolution
- Daemon process
- Git operations

This may be over-engineered for the stated use case of "file-based memory for AI agents."

### 5.3 Mixed Concerns in minimem.ts

The main `Minimem` class handles:
- Database management
- File operations
- Embedding generation
- Search
- Caching
- File watching

Consider separating into smaller, focused classes.

---

## 6. Recommendations Summary

### High Priority

1. **Fix `SearchResult` import** in search.ts
2. **Fix version mismatch** between CLI and package.json
3. **Review BM25 scoring** - current implementation may be broken
4. **Add error logging** instead of silent catches
5. **Standardize directory resolution** across all commands

### Medium Priority

1. **Add comprehensive error path tests**
2. **Extract shared test utilities** into a common module
3. **Fix postbuild script** for cross-platform
4. **Improve type definitions** for embedding providers
5. **Add schema versioning**

### Low Priority

1. **Reduce code duplication**
2. **Add JSDoc comments**
3. **Consider simplifying sync system**
4. **Add performance benchmarks**
5. **Consider using proper YAML parser**

---

## Appendix: Files Reviewed

- `src/minimem.ts` - Core class
- `src/internal.ts` - Utilities
- `src/index.ts` - Exports
- `src/session.ts` - Session tracking
- `src/cli/index.ts` - CLI entry point
- `src/cli/config.ts` - Configuration
- `src/cli/commands/search.ts` - Search command
- `src/cli/commands/init.ts` - Init command
- `src/cli/commands/append.ts` - Append command
- `src/cli/commands/upsert.ts` - Upsert command
- `src/embeddings/embeddings.ts` - Embedding providers
- `src/search/hybrid.ts` - Hybrid search
- `src/search/search.ts` - Search implementation
- `src/server/tools.ts` - Tool definitions
- `src/__tests__/minimem.integration.test.ts` - Integration tests
- `src/cli/__tests__/commands.test.ts` - CLI tests
- `src/search/__tests__/hybrid.test.ts` - Hybrid search tests
- `package.json` - Package configuration
