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
│   ├── schema.ts       # SQLite schema creation
│   └── sqlite-vec.ts   # Vector extension loading
├── embeddings/         # Embedding providers
│   ├── embeddings.ts   # Provider factory and interfaces
│   ├── batch-openai.ts # OpenAI batch embedding
│   └── batch-gemini.ts # Gemini batch embedding
├── search/             # Search implementation
│   └── hybrid.ts       # Hybrid vector+FTS search, BM25
└── server/             # MCP server
    ├── mcp.ts          # MCP protocol implementation
    └── tools.ts        # Tool definitions for LLM integration
```

## Key Files

| File | Purpose |
|------|---------|
| `src/minimem.ts` | Core class with search, sync, append methods |
| `src/internal.ts` | `chunkMarkdown()`, `hashText()`, `listMemoryFiles()` |
| `src/cli/commands/search.ts` | Multi-directory search implementation |
| `src/embeddings/embeddings.ts` | `createEmbeddingProvider()` factory |
| `src/search/hybrid.ts` | `mergeHybridResults()`, BM25 scoring |
| `src/server/mcp.ts` | MCP server for Claude Desktop integration |

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
- `src/cli/__tests__/commands.test.ts` - CLI command tests
- `src/embeddings/__tests__/` - Embedding provider tests
- `src/search/__tests__/` - Hybrid search tests
- `src/server/__tests__/` - MCP server tests

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

1. Update `createSchema()` in `src/db/schema.ts`
2. Consider migration strategy (currently: recreate on schema change)
3. Update relevant queries in `src/minimem.ts`

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

The MCP server exposes one tool: `memory_search`. It runs over stdio and is compatible with Claude Desktop and Cursor.

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

## Code Style

- TypeScript with strict mode
- ESM modules (no CommonJS)
- Async/await for all I/O
- Types exported alongside implementations
- Tests use Node.js native test runner (not vitest) for integration tests
