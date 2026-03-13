# CLAUDE.md

This file provides context for AI agents working on the minimem codebase.

## Project Overview

**minimem** is a file-based memory system with vector search for AI agents. It lets users store memories as Markdown files and search them semantically using embeddings.

**Key value props:**
- Plain Markdown files (git-friendly, human-readable)
- Semantic search via embeddings (OpenAI, Gemini, or local)
- Hybrid search combining vectors + full-text (BM25)
- MCP server for Claude Desktop/Cursor integration
- CLI for command-line usage

## Architecture

```
src/
├── minimem.ts          # Main Minimem class - core logic
├── internal.ts         # Utilities: chunking, hashing, file listing
├── index.ts            # Public exports
├── cli/                # CLI implementation
│   ├── index.ts        # Entry point, command registration
│   ├── config.ts       # Config loading, directory resolution
│   └── commands/       # Individual command implementations
├── db/                 # Database layer
│   ├── schema.ts       # SQLite schema creation (v4)
│   └── sqlite-vec.ts   # Vector extension loading
├── embeddings/         # Embedding providers
│   ├── embeddings.ts   # Provider factory and interfaces
│   ├── batch-openai.ts # OpenAI batch embedding
│   └── batch-gemini.ts # Gemini batch embedding
├── search/             # Search implementation
│   ├── hybrid.ts       # Hybrid vector+FTS search, BM25
│   ├── search.ts       # Knowledge-filtered search helpers
│   └── graph.ts        # Knowledge graph traversal (BFS)
└── server/             # MCP server
    ├── mcp.ts          # MCP protocol implementation
    └── tools.ts        # Tool definitions for LLM integration
```

## Key Files

| File | Purpose |
|------|---------|
| `src/minimem.ts` | Core class with search, sync, append, knowledge methods |
| `src/internal.ts` | `chunkMarkdown()`, `hashText()`, `listMemoryFiles()` |
| `src/session.ts` | Frontmatter parsing/serialization (incl. knowledge fields) |
| `src/cli/commands/search.ts` | Multi-directory search implementation |
| `src/cli/commands/init.ts` | Init command: scaffolds dir, materializes stores, runs initial sync |
| `src/cli/commands/store.ts` | Store commands: add, remove, link, unlink (materializes on add) |
| `src/store/manifest.ts` | Store manifest: registration, linking, resolution |
| `src/store/materialize.ts` | Store materialization: local symlink or remote git clone |
| `src/embeddings/embeddings.ts` | `createEmbeddingProvider()` factory |
| `src/search/hybrid.ts` | `mergeHybridResults()`, BM25 scoring |
| `src/search/search.ts` | `buildKnowledgeFilterSql()` for metadata filtering |
| `src/search/graph.ts` | `getLinksFrom()`, `getLinksTo()`, `getNeighbors()`, `getPathBetween()` |
| `src/server/mcp.ts` | MCP server for Claude Desktop integration |
| `src/server/tools.ts` | MCP tool definitions (memory + knowledge) |

## Development Commands

```bash
npm run build          # Build library and CLI
npm run dev            # Watch mode
npm run test           # Unit tests (vitest)
npm run test:cli       # CLI command tests
npm run test:integration  # E2E integration tests
npm run test:all       # All tests
```

## Testing

Tests are in `__tests__/` directories alongside source:

- `src/__tests__/minimem.integration.test.ts` - Full E2E with mock embeddings
- `src/__tests__/knowledge.test.ts` - Knowledge frontmatter parsing + graph traversal
- `src/cli/__tests__/commands.test.ts` - CLI command tests
- `src/embeddings/__tests__/` - Embedding provider tests
- `src/search/__tests__/` - Hybrid search tests
- `src/server/__tests__/` - MCP server + knowledge tool tests

**Mock embeddings:** Tests use deterministic embeddings based on keyword presence (no API calls needed). See `createDeterministicEmbedding()` in test files.

## Build System

- **tsup** for bundling (ESM only, Node 22+)
- Library: `dist/index.js` with types
- CLI: `dist/cli/index.js` (bundled with shebang)
- **postbuild** script fixes `node:sqlite` import (esbuild strips `node:` prefix)

## Important Patterns

### Memory Path Validation
Only `MEMORY.md` and `memory/*.md` files are indexed. The `validateMemoryPath()` method enforces this.

### Embedding Cache
Embeddings are cached by content hash in SQLite. Same content = same embedding, even across files.

### Hybrid Search
Default weights: 70% vector similarity, 30% BM25 text search. Configurable via `hybrid.vectorWeight` and `hybrid.textWeight`.

### Multi-Directory Search
The search command can query multiple directories:
```bash
minimem search "query" --dir ~/a --dir ~/b --global
```
Results are merged and sorted by score.

### Init Lifecycle
`minimem init` does three things in order:
1. **Scaffold** — creates `MEMORY.md`, `config.json`, `.gitignore`, `memory/` dir
2. **Materialize linked stores** — if this directory is registered in the store manifest with links, materializes them (clones remotes into `~/.cache/minimem/stores/`)
3. **Initial sync** — creates the SQLite DB and indexes existing memory files (non-fatal if no API key is set)

### Store Materialization
Stores are materialized eagerly in two places:
- **`init`** — materializes all linked stores after scaffolding
- **`store:add`** — materializes the store immediately after registration (clones remote if local path doesn't exist)

Materialization strategies:
- **Local** — store path exists on disk → use directly
- **Remote** — clone/fetch git remote into `~/.cache/minimem/stores/<name>/`

## Common Tasks

### Adding a new CLI command

1. Create `src/cli/commands/newcmd.ts`:
```typescript
export type NewCmdOptions = { dir?: string; global?: boolean; };

export async function newcmd(options: NewCmdOptions): Promise<void> {
  const memoryDir = resolveMemoryDir({ dir: options.dir, global: options.global });
  // ... implementation
}
```

2. Export from `src/cli/commands/index.ts`

3. Register in `src/cli/index.ts`:
```typescript
program
  .command("newcmd")
  .description("Description")
  .option("-d, --dir <path>", "Memory directory")
  .action(newcmd);
```

4. Add tests in `src/cli/__tests__/commands.test.ts`

### Adding a new embedding provider

1. Add provider type to `EmbeddingProviderOptions` in `src/embeddings/embeddings.ts`
2. Implement in `createEmbeddingProvider()` switch statement
3. Add batch function in `src/embeddings/batch-{provider}.ts` if needed
4. Update `auto` provider detection logic

### Modifying the database schema

1. Update `createSchema()` in `src/db/schema.ts` (currently at SCHEMA_VERSION 4)
2. Consider migration strategy (currently: recreate on schema change)
3. Update relevant queries in `src/minimem.ts`
4. If adding knowledge-related columns, update `indexKnowledgeMetadata()` in `src/minimem.ts`

## Gotchas

1. **node:sqlite is experimental** - Requires Node 22+, shows warning on every run
2. **sqlite-vec may not load** - Falls back to FTS-only search if extension fails
3. **CLI bundle strips node: prefix** - postbuild script fixes this
4. **Commander.js is CJS** - Must be external in CLI bundle, not inlined

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI embeddings |
| `GOOGLE_API_KEY` | Gemini embeddings |
| `GEMINI_API_KEY` | Alternative Gemini key |
| `MEMORY_DIR` | Default memory directory |

## File Structure Convention

```
project/
├── MEMORY.md           # Main memory (required for init)
├── memory/             # Additional memories
│   ├── YYYY-MM-DD.md   # Daily logs (from append)
│   └── *.md            # Topic files
└── .minimem/
    ├── config.json     # User config
    ├── index.db        # SQLite with vectors
    └── .gitignore      # Ignores index.db
```

## MCP Integration

The MCP server exposes 5 tools over stdio, compatible with Claude Desktop and Cursor:

| Tool | Purpose |
|------|---------|
| `memory_search` | General semantic search across all memory files |
| `memory_get_details` | Retrieve full content of a specific memory file |
| `knowledge_search` | Search knowledge notes with domain/entity/confidence/type filters |
| `knowledge_graph` | Traverse knowledge graph relationships from a note |
| `knowledge_path` | Find shortest path between two knowledge notes via graph links |

The 3 `knowledge_*` tools are additive — they only return results when knowledge-formatted notes (with the frontmatter convention below) are present. Without knowledge notes, they return empty results.

Config location for Claude Desktop:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

## Claude Code Plugin

The `claude-plugin/` directory contains a ready-to-use Claude Code plugin:

```
claude-plugin/
├── .claude-plugin/
│   └── plugin.json      # Plugin manifest
├── .mcp.json            # MCP server definition (uses npx minimem mcp)
├── skills/
│   └── memory/
│       └── SKILL.md     # Auto-invoked memory skill
└── commands/
    ├── remember.md      # /minimem:remember command
    └── recall.md        # /minimem:recall command
```

### Testing the Plugin

```bash
claude --plugin-dir ./claude-plugin
```

### Plugin Commands

- `/minimem:remember <text>` - Store information in memory
- `/minimem:recall <query>` - Search for stored memories

## Knowledge Frontmatter Convention

minimem can index structured knowledge notes produced by external systems (e.g., cognitive-core). This is a **file-format convention only** — minimem does not import or depend on any external package.

When a memory file's YAML frontmatter contains knowledge-specific fields, minimem parses them and populates metadata columns in the `chunks` table and edges in the `knowledge_links` table.

### Supported fields

All fields are optional. If absent, the file is treated as a regular memory note.

```yaml
---
id: k-abc123                     # Unique knowledge node ID
type: observation                # observation | entity | domain-summary
domain: [database, devops]       # Domain tags
entities: [prisma, postgres]     # Referenced entities
confidence: 0.85                 # Confidence score (0.0–1.0)
source:                          # Provenance metadata
  origin: extracted              # extracted | agent-authored
  trajectories: [t-001, t-002]  # Source trajectory IDs
  agentId: agent-v1             # Authoring agent
links:                           # Graph edges to other knowledge nodes
  - target: k-other
    relation: related-to         # related-to | depends-on | supports | etc.
    layer: semantic              # semantic | temporal | causal | entity
  - target: k-dep
    relation: depends-on
created: 2025-01-15T10:00:00Z
updated: 2025-01-15T12:00:00Z
supersedes: k-old                # ID of note this replaces
tags: [migration, patterns]
---
# Note Title

Body content in Markdown.
```

### How it works

1. **Indexing** (`indexFile()`): When a file is indexed, frontmatter is parsed via `parseFrontmatter()`. If `type` is present, the chunk row gets `knowledge_type`, `knowledge_id`, `domains` (JSON), `entities` (JSON), and `confidence` populated. If `links` is present, rows are upserted into `knowledge_links`.

2. **Filtered search** (`knowledgeSearch()`): Accepts `domain`, `entities`, `minConfidence`, and `knowledgeType` filters. Uses `json_each()` SQL for array column matching. Falls back to regular search when no filters are provided.

3. **Graph traversal** (`src/search/graph.ts`): Operates on the `knowledge_links` table. Supports outgoing/incoming edge queries, BFS neighbor discovery (configurable depth), and shortest-path finding.

4. **Re-indexing**: When a file changes, old `knowledge_links` for that file are deleted before new ones are inserted, keeping the graph consistent.

### Independence guarantee

- minimem defines its own types (`KnowledgeSource`, `KnowledgeLink`, `MemoryFrontmatter`) locally in `src/session.ts`
- Zero imports from cognitive-core or any external knowledge system
- All knowledge columns are nullable — regular memory files index without them
- The `knowledge_links` table only gets rows when frontmatter contains `links`
- All knowledge MCP tools (`knowledge_search`, `knowledge_graph`, `knowledge_path`) are additive alongside existing tools

### Database schema (v4)

Knowledge-related additions to the schema:

```sql
-- Added columns on chunks table (all nullable)
knowledge_type TEXT      -- 'observation', 'entity', 'domain-summary'
knowledge_id TEXT        -- Note ID from frontmatter
domains TEXT             -- JSON array of domain strings
entities TEXT            -- JSON array of entity strings
confidence REAL          -- 0.0–1.0

-- New table for graph edges
CREATE TABLE knowledge_links (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  layer TEXT,                     -- semantic, temporal, causal, entity
  weight REAL DEFAULT 0.5,
  source_path TEXT,
  created_at INTEGER DEFAULT (unixepoch()),
  PRIMARY KEY (from_id, to_id, relation)
);
```

## Code Style

- TypeScript with strict mode
- ESM modules (no CommonJS)
- Async/await for all I/O
- Types exported alongside implementations
- Tests use Node.js native test runner (not vitest) for integration tests
