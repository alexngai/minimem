# CLAUDE.md

This file provides context for AI agents working on the minimem codebase.

## Project Overview

**minimem** is a file-based memory system with vector + full-text search for AI
agents. Memories are plain Markdown files; minimem indexes them into a local
SQLite file (`sqlite-vec` for vectors, FTS5 for keywords) and serves hybrid
search via a CLI and an MCP server (Claude Desktop, Claude Code, Cursor, etc.).

## Architecture

```
src/
├── minimem.ts        # Main Minimem class - core search/sync/append/knowledge logic
├── internal.ts        # chunkMarkdown(), hashText(), listMemoryFiles()
├── session.ts          # Frontmatter parsing/serialization (incl. knowledge fields)
├── index.ts            # Public package exports
├── core/               # MemoryIndexer / MemorySearcher (indexer.ts, searcher.ts)
├── cli/
│   ├── index.ts        # Entry point, command registration
│   ├── config.ts       # Config loading, directory resolution
│   ├── embedding-setup.ts  # Interactive embedding-provider setup on init
│   ├── sync/           # Multi-machine sync: registry, watcher, conflicts, daemon
│   └── commands/       # search, init, store, append, upsert, sync, push-pull,
│                        #   status, conflicts, daemon, mcp, config
├── db/                 # schema.ts (SQLite schema, current SCHEMA_VERSION 4),
│                        #   open-db.ts, sqlite-vec.ts (vector extension loading)
├── embeddings/         # embeddings.ts (provider factory), batch-openai.ts, batch-gemini.ts
├── search/             # hybrid.ts (RRF/weighted fusion, BM25), search.ts
│                        #   (knowledge-filtered search), graph.ts (BFS traversal)
├── store/              # Multi-store linking: manifest.ts, materialize.ts,
│                        #   store-graph.ts (StoreGraph orchestrates linked stores)
└── server/             # mcp.ts (MCP protocol), tools.ts (tool definitions)
```

## Development Commands

```bash
npm run build             # tsup build + postbuild (fixes node:sqlite import)
npm run dev                # Watch mode
npm run test               # Unit tests (vitest)
npm run test:integration   # E2E integration test (node:test)
npm run test:cli           # CLI command tests (node:test)
npm run test:knowledge     # Knowledge frontmatter/graph tests (node:test)
npm run test:all           # All of the above
npm run eval               # Run retrieval eval CLI (evals/swarmkit/cli.ts)
npm run eval:ci            # Offline retrieval-eval regression gate (smoke tests)
```

Integration, CLI, and knowledge tests use Node's native `node:test` runner
(not vitest) via `tsx --test`; only `npm run test` uses vitest.

**Mock embeddings:** tests use deterministic embeddings based on keyword
presence (no API calls needed) — see `createDeterministicEmbedding()` in test
files.

## Important Patterns

### Memory Path Validation
Only `MEMORY.md` and `memory/*.md` files are indexed. `validateMemoryPath()` (in
`src/internal.ts`) enforces this.

### Embedding Cache
Embeddings are cached by content hash in SQLite. Same content = same
embedding, even across files.

### Hybrid Search
Default fusion is **RRF** (reciprocal rank fusion) — combines vector and BM25
result lists by rank position, needing no score normalization. RRF is the best
(or tied-best) fusion across the BEIR datasets and embedding models tested,
and it's scale-invariant, unlike weighted-sum which is sensitive to each
model's cosine-score distribution. See
[docs/RETRIEVAL-EVAL-RESULTS.md](docs/RETRIEVAL-EVAL-RESULTS.md). Set
`hybrid.fusion: "weighted"` for score-weighted sum (`hybrid.vectorWeight` /
`hybrid.textWeight`, default 0.7/0.3); `vectorWeight: 0` → pure BM25,
`textWeight: 0` → pure vector.

### Multi-Directory Search
```bash
minimem search "query" --dir ~/a --dir ~/b --global
```
Results are merged and sorted by score.

### Init Lifecycle
`minimem init` does three things in order:
1. **Scaffold** — creates `MEMORY.md`, `config.json`, `.gitignore`, `memory/` dir
2. **Materialize linked stores** — if this directory is registered in the store
   manifest with links, materializes them (clones remotes into
   `~/.cache/minimem/stores/`)
3. **Initial sync** — creates the SQLite DB and indexes existing memory files
   (non-fatal if no API key is set)

### Store Materialization
Stores are materialized eagerly in two places: `init` (all linked stores after
scaffolding) and `store:add` (immediately after registration). Strategies:
**local** (path exists on disk → use directly) or **remote** (clone/fetch git
remote into `~/.cache/minimem/stores/<name>/`).

## Common Tasks

### Adding a new CLI command
1. Create `src/cli/commands/newcmd.ts`, export a handler function.
2. Export it from `src/cli/commands/index.ts`.
3. Register it in `src/cli/index.ts` (`program.command(...)`).
4. Add tests in `src/cli/__tests__/commands.test.ts`.

### Adding a new embedding provider
1. Add provider type to `EmbeddingProviderOptions` in `src/embeddings/embeddings.ts`.
2. Implement in `createEmbeddingProvider()`'s switch statement.
3. Add `src/embeddings/batch-{provider}.ts` if batch embedding is needed.
4. Update `auto` provider detection logic.

### Modifying the database schema
1. Bump `SCHEMA_VERSION` and update `createSchema()` in `src/db/schema.ts`
   (currently version 4).
2. Migration strategy is currently: recreate on schema version change.
3. Update relevant queries in `src/minimem.ts`.
4. Knowledge-related columns are updated via `indexKnowledgeMetadata()` in
   `src/minimem.ts`.

## Gotchas

1. **`node:sqlite` is experimental** — requires Node 22+, warns on every run.
2. **sqlite-vec may not load** — falls back to FTS-only search if the
   extension fails.
3. **CLI bundle strips the `node:` prefix** — esbuild does this; the
   `postbuild` script (`scripts/postbuild.js`) fixes it back.
4. **Commander.js is CJS** — must stay external in the CLI bundle, not inlined.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI embeddings |
| `GOOGLE_API_KEY` | Gemini embeddings |
| `GEMINI_API_KEY` | Alternative Gemini key |
| `MEMORY_DIR` | Default memory directory |

## MCP Integration

The MCP server (`src/server/mcp.ts`) exposes 5 tools over stdio:

| Tool | Purpose |
|------|---------|
| `memory_search` | General semantic search across all memory files |
| `memory_get_details` | Retrieve full content of a specific memory file |
| `knowledge_search` | Search knowledge notes with domain/entity/confidence/type filters |
| `knowledge_graph` | Traverse knowledge graph relationships from a note |
| `knowledge_path` | Find shortest path between two knowledge notes via graph links |

The 3 `knowledge_*` tools are additive — they only return results when
knowledge-formatted notes (see below) are present; otherwise they return empty
results.

Config location for Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`
(macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows).

## Claude Code Plugin

`claude-plugin/` is a ready-to-use Claude Code plugin (`.claude-plugin/plugin.json`
manifest, `.mcp.json` running `npx minimem mcp`, a `memory` skill, and
`/minimem:remember` / `/minimem:recall` commands). Test it with:

```bash
claude --plugin-dir ./claude-plugin
```

## Knowledge Frontmatter Convention

minimem can index structured knowledge notes produced by external systems
(e.g. an agent's own note-taking pipeline). This is a **file-format
convention only** — minimem defines its own types (`KnowledgeSource`,
`KnowledgeLink`, `MemoryFrontmatter` in `src/session.ts`) and has zero
dependency on any external knowledge system.

All fields below are optional; if absent, the file is a regular memory note.

```yaml
---
id: k-abc123                     # Unique knowledge node ID
type: observation                # observation | entity | domain-summary
domain: [database, devops]       # Domain tags
entities: [prisma, postgres]     # Referenced entities
confidence: 0.85                 # Confidence score (0.0-1.0)
source:
  origin: extracted              # extracted | agent-authored
  trajectories: [t-001, t-002]
  agentId: agent-v1
links:
  - target: k-other
    relation: related-to         # related-to | depends-on | supports | etc.
    layer: semantic              # semantic | temporal | causal | entity
created: 2025-01-15T10:00:00Z
updated: 2025-01-15T12:00:00Z
supersedes: k-old
tags: [migration, patterns]
---
```

**How it works:** on index, frontmatter is parsed via `parseFrontmatter()`; if
`type` is present, the chunk row gets `knowledge_type`/`knowledge_id`/`domains`/
`entities`/`confidence` populated, and any `links` are upserted into the
`knowledge_links` table. `knowledgeSearch()` filters on `domain`, `entities`,
`minConfidence`, `knowledgeType` (via SQL `json_each()`), falling back to
regular search with no filters. `src/search/graph.ts` traverses
`knowledge_links` (outgoing/incoming edges, BFS neighbor discovery, shortest
path). Re-indexing a changed file deletes and re-inserts its `knowledge_links`
rows. All knowledge columns are nullable, so regular memory files are
unaffected.

## Code Style

- TypeScript, strict mode, ESM only (no CommonJS)
- Async/await for all I/O
- Types exported alongside implementations
- Integration/CLI/knowledge tests use Node's native test runner; unit tests use vitest
