<div align="center">
    <picture>
        <img alt="minimem banner" src="https://raw.githubusercontent.com/alexngai/minimem/main/media/banner.png">
    </picture>
</div>

# minimem

**Agent memory that's just Markdown and one SQLite file. No server, no vector database, no infrastructure.**

Give any AI agent long-term memory in about 30 seconds. Your memories are plain
Markdown files you own and can `git` — minimem indexes them into a single local
SQLite file and serves hybrid semantic search to Claude Code, Codex, Cursor, or
your own code over MCP.

```bash
npm install -g minimem && minimem init ~/memories
```

That's the whole setup. No Docker, no Postgres, no Pinecone, no daemon to babysit.

## Why minimem

- **Zero infrastructure** - The entire index is one SQLite file (`sqlite-vec` for vectors, FTS5 for keywords). Nothing to host, nothing to run.
- **Your memory, in plain files** - Memories are Markdown you can read, edit, diff, and version with git. No proprietary store, no lock-in.
- **Local-first & portable** - Commit the Markdown, `.gitignore` the index, and rebuild it on any machine with `minimem sync`.
- **Strong hybrid retrieval** - Vector similarity fused with BM25 via reciprocal rank fusion (RRF) — the best-scoring config across the BEIR datasets we tested ([results](docs/RETRIEVAL-EVAL-RESULTS.md)).
- **Bring your own embeddings** - OpenAI, Gemini, or a fully local model via `llama.cpp` (no API key required). Guided setup picks one for you on `init`.
- **Drops into your agent** - First-class MCP server for Claude Code, Codex, Cursor, and Claude Desktop, plus a Claude Code plugin — see [integrations](#mcp-server-integration).

## Benchmarks

Long-term-memory QA benchmark results for an agent memory pipeline (extract → retrieve → answer), answer model gpt-5.5:

| benchmark | score | retrieval | notes |
|---|---:|---|---|
| [LongMemEval_S](https://github.com/xiaowu0162/LongMemEval) | **93.0%** | full pipeline | 500-question run, official judge; **minimem retrieval alone = ~84%**, the live-tool pipeline adds ~9pp (assistant-turn recovery). ~1.9pp behind Mastra (94.87%) |
| [LOCOMO](https://github.com/snap-research/locomo) | **79.3%** | **minimem** | 10 multi-session conversations; mem0 LLM-judge (vendor convention, not author-official F1) |
| [BEAM](https://github.com/mohammadtavakoli78/BEAM) | **72.7%** | **minimem** | ICLR 2026 long-horizon memory, 500K-token conversations |

The retrieval finding that earns the LOCOMO/BEAM numbers: **minimem's focused hybrid
retrieval beats a dump-everything KB baseline by +13pp at 500K tokens and +43pp on LOCOMO,
and the gap widens with scale** (the KB's context dump truncates; minimem retrieves the
right notes regardless of store size). On LongMemEval, minimem retrieval alone reaches ~84%;
the full pipeline's remaining ~9pp is almost entirely the live-tool arm recovering
assistant-turn statements that user-centric extraction under-captures. Scores are
same-family-judge, not leaderboard-exact. Full methodology, the clean substrate-vs-graph
decomposition, and honest per-benchmark caveats: [evals/beam/RESULTS.md](evals/beam/RESULTS.md).

## Installation

Install globally for the CLI + MCP server (recommended for most users):

```bash
npm install -g minimem
```

Or add it as a library dependency:

```bash
npm install minimem
```

Requires Node.js 22+ (uses the built-in `node:sqlite`).

## Quick Start

```bash
# Initialize a memory directory. init detects an embedding API key in your
# environment; if it doesn't find one, it asks how you'd like to search:
#   • a hosted provider (OpenAI/Gemini),
#   • a local model (~320 MB, runs offline, no key), or
#   • keyword-only for now (upgrade anytime).
minimem init ~/memories

# Add some memories
minimem append "Decided to use PostgreSQL for the main database" --dir ~/memories

# Search your memories
minimem search "database decisions" --dir ~/memories

# Create or update a memory file
minimem upsert "memory/architecture.md" "# Architecture Notes..." --dir ~/memories
```

Prefer non-interactive setup? Pass `--provider` (e.g. `minimem init ~/memories
--provider local`) or `--yes` to accept the keyword-only default in scripts/CI.

### Library Usage

```typescript
import { Minimem } from 'minimem';

// Create a Minimem instance
const mem = await Minimem.create({
  memoryDir: './memories',
  embedding: {
    provider: 'openai',
    openai: { apiKey: process.env.OPENAI_API_KEY }
  }
});

// Search memories
const results = await mem.search('database architecture');
for (const result of results) {
  console.log(`[${result.score}] ${result.path}:${result.startLine}`);
  console.log(result.snippet);
}

// Append to today's log
await mem.appendToday('Reviewed the API design document');

// Clean up
mem.close();
```

## CLI Commands

### Core

| Command | Description |
|---------|-------------|
| `minimem init [dir]` | Initialize a memory directory (creates files, DB, and indexes) |
| `minimem search <query>` | Semantic search through memories |
| `minimem sync` | Force re-index memory files |
| `minimem status` | Show index stats and provider info |
| `minimem append <text>` | Append to today's daily log |
| `minimem upsert <file> [content]` | Create or update a memory file |
| `minimem mcp` | Run as MCP server (stdio) |
| `minimem config` | View or modify configuration (`--set key=value`, `--unset key`) |

### Stores (cross-directory search)

| Command | Description |
|---------|-------------|
| `minimem store:add <name> <path>` | Register a store in the global manifest (`--remote <url>` for git-backed stores) |
| `minimem store:remove <name>` | Remove a store from the global manifest |
| `minimem store:list` | List all registered stores and their links |
| `minimem store:link <store> <target>` | Link a store to another for cross-store search |
| `minimem store:unlink <store> <target>` | Remove a link between stores |

### Git sync (multi-machine memory)

Sync memory directories through a central git repository — write on one machine, recall on another.

| Command | Description |
|---------|-------------|
| `minimem sync:init-central <path>` | Initialize a central repository for syncing |
| `minimem sync:init --path <name>/` | Enable sync for a memory directory |
| `minimem push` / `minimem pull` | Push/pull changes to/from the central repository |
| `minimem sync:status` | Show sync status for a directory |
| `minimem sync:list` | List all sync mappings |
| `minimem sync:remove` | Remove sync mapping for a directory |
| `minimem sync:conflicts` | List quarantined conflicts |
| `minimem sync:resolve <timestamp>` | Resolve a quarantined conflict with a merge tool |
| `minimem sync:cleanup` | Clean up old quarantined conflicts |
| `minimem sync:log` | Show sync history |
| `minimem sync:validate` | Validate the registry for collisions and stale mappings |

### Sync daemon (auto-sync)

| Command | Description |
|---------|-------------|
| `minimem daemon` | Start the sync daemon (`--background` to detach) |
| `minimem daemon:stop` | Stop the sync daemon |
| `minimem daemon:status` | Show daemon status |
| `minimem daemon:logs` | Show daemon logs (`--follow` to tail) |

### Common Options

- `-d, --dir <path>` - Memory directory (default: current directory)
- `-g, --global` - Use `~/.minimem` as the memory directory
- `-p, --provider <name>` - Embedding provider: `openai`, `gemini`, `local`, or `auto`

### Search Options

```bash
# Search with options
minimem search "project decisions" \
  --dir ~/memories \
  --max 5 \
  --min-score 0.5 \
  --json

# Search multiple directories
minimem search "api design" \
  --dir ~/work-memories \
  --dir ~/personal-notes \
  --global
```

### Upsert Examples

```bash
# Create/update with inline content
minimem upsert "notes.md" "# My Notes" --dir ~/memories

# Pipe content from stdin
cat document.md | minimem upsert "imported.md" --stdin --dir ~/memories

# Use heredoc for multi-line content
minimem upsert "memory/decisions.md" --stdin --dir ~/memories << 'EOF'
# Architecture Decisions

## Database
We chose PostgreSQL for its reliability and JSON support.

## API
REST with OpenAPI documentation.
EOF
```

## Memory Directory Structure

```
my-memories/
├── MEMORY.md           # Main memory file (indexed)
├── memory/             # Additional memory files
│   ├── 2024-01-15.md   # Daily logs
│   ├── 2024-01-16.md
│   └── projects.md     # Topic-specific notes
├── config.json         # Configuration
├── index.db            # SQLite database with vectors (gitignored)
└── .gitignore          # Ignores index.db
```

Everything lives in the memory directory itself, so it's trivially portable: the Markdown
files and `config.json` can be committed to git, while the derived `index.db` is ignored
and rebuilt on any machine with `minimem sync`.

(Legacy layouts with a `.minimem/` subdirectory are still read transparently.)

## Configuration

Configuration is stored in `config.json` at the memory directory root:

```json
{
  "embedding": {
    "provider": "auto",
    "model": "text-embedding-3-small"
  },
  "hybrid": {
    "enabled": true,
    "fusion": "rrf",
    "ftsQueryMode": "or"
  },
  "query": {
    "maxResults": 10,
    "minScore": 0.3
  }
}
```

The values above are the defaults. Set `"fusion": "weighted"` to use a score-weighted
sum instead of RRF (then `vectorWeight`/`textWeight`, default 0.7/0.3, apply). A global
config at `~/.minimem/config.json` is layered under each directory's local config.

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key for embeddings |
| `GOOGLE_API_KEY` | Google/Gemini API key for embeddings |
| `GEMINI_API_KEY` | Alternative Gemini API key |
| `MEMORY_DIR` | Default memory directory |

### Embedding Providers

**OpenAI** (recommended for quality):
```bash
export OPENAI_API_KEY=sk-...
minimem search "query" --provider openai
```

**Gemini** (good free tier):
```bash
export GOOGLE_API_KEY=...
minimem search "query" --provider gemini
```

**Local** (no API needed, requires setup):
```bash
minimem search "query" --provider local
```

**Auto** (default): Tries OpenAI → Gemini → Local based on available API keys.

## MCP Server Integration

minimem can run as an [MCP server](https://modelcontextprotocol.io/) for integration with Claude Desktop, Cursor, and other tools.

### Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "minimem": {
      "command": "minimem",
      "args": ["mcp", "--global"],
      "env": {
        "OPENAI_API_KEY": "your-key"
      }
    }
  }
}
```

### Multiple Memory Directories

The MCP server supports searching across multiple memory directories:

```json
{
  "mcpServers": {
    "minimem": {
      "command": "minimem",
      "args": ["mcp", "--dir", "/path/to/work", "--dir", "/path/to/personal", "--global"],
      "env": {
        "OPENAI_API_KEY": "your-key"
      }
    }
  }
}
```

When multiple directories are configured:
- The `memory_search` tool searches all directories by default
- Results are merged and ranked by score
- Each result shows which directory it came from
- Use the optional `directories` parameter to filter to specific directories

### Cursor

Add to Cursor's MCP settings:

```json
{
  "mcpServers": {
    "minimem": {
      "command": "minimem",
      "args": ["mcp", "--dir", "/path/to/memories"],
      "env": {
        "OPENAI_API_KEY": "your-key"
      }
    }
  }
}
```

### Codex (CLI & IDE)

The fastest way is the Codex CLI, which writes the config for you:

```bash
codex mcp add minimem --env OPENAI_API_KEY=your-key -- minimem mcp --global
```

Or add the table to `~/.codex/config.toml` directly (note the snake_case
`mcp_servers` — a typo here is silently ignored):

```toml
[mcp_servers.minimem]
command = "minimem"
args = ["mcp", "--global"]

[mcp_servers.minimem.env]
OPENAI_API_KEY = "your-key"
```

Verify it's live with `codex mcp list`. The CLI and IDE extension share this
config, so you only set it up once. To scope memory to a single project, use a
trusted-project `.codex/config.toml` and swap `--global` for
`--dir /path/to/memories`.

To nudge Codex (or any agent) to actually use the memory tools, add a short
block to your project's `AGENTS.md`:

```markdown
## Memory (minimem)

Before starting a task, call `memory_search` to recall relevant prior context.
When you make a decision or learn something durable, write it to `MEMORY.md`
(or `memory/YYYY-MM-DD.md`) so it's indexed for next time.
```

### Available MCP Tools

The MCP server exposes five tools:

| Tool | Purpose |
|------|---------|
| `memory_search` | Semantic search across memory files. Supports `maxResults`, `minScore`, `directories`, `detail` (`"compact"` index or `"full"` snippets), and `type` (filter by observation type: decision, bugfix, feature, discovery, context, note) |
| `memory_get_details` | Fetch full text for chunks returned by a compact `memory_search` — a two-phase workflow that saves tokens |
| `knowledge_search` | Search knowledge notes with domain/entity/confidence/type filters (see [Knowledge Frontmatter](CLAUDE.md#knowledge-frontmatter-convention)) |
| `knowledge_graph` | Traverse knowledge-graph relationships outward from a note |
| `knowledge_path` | Find the shortest path between two knowledge notes via graph links |

The three `knowledge_*` tools are additive: they only return results when
knowledge-formatted notes (YAML frontmatter with `type`, `domain`, `links`, etc.)
are present. Regular memory files work fine without them.

Typical search flow:

```typescript
// 1. Compact search — lightweight index of matches
memory_search({ query: "api design decisions", maxResults: 10 })

// 2. Fetch full text only for the results that matter
memory_get_details({ results: [{ path, startLine, endLine }] })
```

## Library API

### Creating an Instance

```typescript
import { Minimem, type MinimemConfig } from 'minimem';

const config: MinimemConfig = {
  memoryDir: './memories',
  embedding: {
    provider: 'openai',
    openai: {
      apiKey: process.env.OPENAI_API_KEY,
      model: 'text-embedding-3-small'  // or text-embedding-3-large
    }
  },
  hybrid: {
    enabled: true,
    fusion: 'rrf',       // default; or 'weighted' (uses vectorWeight/textWeight)
    ftsQueryMode: 'or'   // default; 'and' requires all query terms to match
  },
  watch: true,  // Auto-sync on file changes
  debug: console.log  // Optional debug logging
};

const mem = await Minimem.create(config);
```

### Search

```typescript
const results = await mem.search('database architecture', {
  maxResults: 10,
  minScore: 0.3
});

// Results include:
// - path: relative file path
// - snippet: matching text chunk
// - score: relevance score (0-1)
// - startLine, endLine: line numbers
// - heading: section heading if available
```

### File Operations

```typescript
// Append to today's daily log (memory/YYYY-MM-DD.md)
await mem.appendToday('Meeting notes: discussed API design');

// Append to specific file
await mem.appendFile('memory/project.md', 'New decision made');

// List all memory files
const files = await mem.listFiles();

// Get status
const status = await mem.status();
console.log(`Files: ${status.fileCount}, Chunks: ${status.chunkCount}`);
```

### Sync Control

```typescript
// Manual sync (usually automatic)
await mem.sync();

// Force full re-index
await mem.sync({ force: true });
```

### Custom Embedding Providers

```typescript
import { createEmbeddingProvider } from 'minimem';

// Create provider with custom settings
const provider = createEmbeddingProvider({
  provider: 'openai',
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: 'text-embedding-3-large',
    dimensions: 1536
  }
});

// Or use Gemini
const geminiProvider = createEmbeddingProvider({
  provider: 'gemini',
  gemini: {
    apiKey: process.env.GOOGLE_API_KEY,
    model: 'text-embedding-004'
  }
});
```

## How It Works

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                         minimem                              │
├─────────────────────────────────────────────────────────────┤
│  Memory Files (.md)                                          │
│  ┌─────────┐ ┌─────────┐ ┌─────────┐                        │
│  │MEMORY.md│ │daily.md │ │notes.md │  ← Plain Markdown      │
│  └────┬────┘ └────┬────┘ └────┬────┘                        │
│       │           │           │                              │
│       └───────────┴───────────┘                              │
│                   │                                          │
│                   ▼                                          │
│  ┌─────────────────────────────────────┐                    │
│  │           Chunking                   │                    │
│  │  Split by headings/paragraphs        │                    │
│  │  ~256 tokens per chunk               │                    │
│  └──────────────────┬──────────────────┘                    │
│                     │                                        │
│                     ▼                                        │
│  ┌─────────────────────────────────────┐                    │
│  │      Embedding Provider              │                    │
│  │  OpenAI / Gemini / Local             │                    │
│  │  text → [0.1, -0.3, 0.8, ...]       │                    │
│  └──────────────────┬──────────────────┘                    │
│                     │                                        │
│                     ▼                                        │
│  ┌─────────────────────────────────────┐                    │
│  │         SQLite Database              │                    │
│  │  ┌─────────┐  ┌─────────────────┐   │                    │
│  │  │  FTS5   │  │  sqlite-vec     │   │                    │
│  │  │ (text)  │  │  (vectors)      │   │                    │
│  │  └─────────┘  └─────────────────┘   │                    │
│  └──────────────────┬──────────────────┘                    │
│                     │                                        │
│                     ▼                                        │
│  ┌─────────────────────────────────────┐                    │
│  │         Hybrid Search                │                    │
│  │  Vector similarity + BM25 ranking    │                    │
│  │  Reciprocal rank fusion (RRF)        │                    │
│  └─────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

### Indexing Process

1. **File Discovery**: Scans for `MEMORY.md` and `memory/*.md` files
2. **Chunking**: Splits content by Markdown headings and paragraphs (~256 tokens each)
3. **Hashing**: Each chunk gets a content hash to detect changes
4. **Embedding**: New/changed chunks are sent to the embedding provider
5. **Storage**: Chunks and vectors stored in SQLite with sqlite-vec extension
6. **Caching**: Embeddings cached by content hash to avoid re-computation

### Search Process

1. **Query Embedding**: Convert search query to vector using same embedding model
2. **Vector Search**: KNN search using the sqlite-vec index (cosine distance)
3. **Text Search**: Find matching chunks using FTS5 full-text search (BM25, OR-mode)
4. **Hybrid Fusion**: Combine both ranked lists with reciprocal rank fusion (RRF)
5. **Ranking**: Sort by fused score (max-normalized), apply min-score filter

### Why Hybrid Search — and Why RRF?

Pure vector search excels at semantic similarity but can miss exact matches. Pure text search finds exact terms but misses synonyms. Hybrid search combines both:

- **Vector**: Finds conceptually related content ("database" matches "PostgreSQL")
- **Text (BM25)**: Boosts exact keyword matches ("PostgreSQL" query ranks PostgreSQL mentions higher)

The default fusion is **RRF (reciprocal rank fusion)**: it merges the two result
lists by rank position instead of mixing raw scores, so it needs no score
normalization and is robust across embedding models. On BEIR retrieval
benchmarks, RRF was the best (or tied-best) configuration on every dataset and
embedding model tested, while score-weighted fusion collapsed when switching
embedding models — see [docs/RETRIEVAL-EVAL-RESULTS.md](docs/RETRIEVAL-EVAL-RESULTS.md)
for the full numbers. A score-weighted sum is available via
`hybrid.fusion: "weighted"`.

### Storage Format

SQLite database (`index.db` in the memory directory) with these main tables:

```sql
-- File metadata and modification tracking
CREATE TABLE files (path, source, hash, mtime, size);

-- Content chunks with embeddings and optional knowledge metadata
CREATE TABLE chunks (
  id, path, source, start_line, end_line, hash, model, text, embedding,
  type,                                      -- observation type (decision, bugfix, ...)
  knowledge_type, knowledge_id,              -- knowledge frontmatter metadata
  domains, entities, confidence,
  updated_at
);

-- Full-text search index (BM25)
CREATE VIRTUAL TABLE chunks_fts USING fts5(text, id, path, ...);

-- Vector KNN index (when sqlite-vec is available; dims are model-dependent)
CREATE VIRTUAL TABLE chunks_vec USING vec0(embedding FLOAT[<dims>]);

-- Knowledge graph edges (from knowledge frontmatter links)
CREATE TABLE knowledge_links (from_id, to_id, relation, layer, weight, ...);
```

### Embedding Cache

Embeddings are cached by provider, model, and content hash:

```sql
CREATE TABLE embedding_cache (
  provider, model, provider_key, hash, embedding, dims, updated_at,
  PRIMARY KEY (provider, model, provider_key, hash)
);
```

This means:
- Identical text always produces the same embedding (deterministic)
- Moving/copying chunks doesn't require re-embedding
- Switching files with same content is instant
- The cache survives schema migrations, so re-indexing is cheap

## Claude Code Plugin

A ready-to-use Claude Code plugin is included in the `claude-plugin/` directory.

### Quick Install

```bash
# Install minimem globally
npm install -g minimem

# Initialize global memory
minimem init --global

# Test the plugin
claude --plugin-dir /path/to/minimem/claude-plugin
```

### Plugin Features

- **MCP Server**: all five memory/knowledge tools (see [Available MCP Tools](#available-mcp-tools))
- **Memory Skill**: Auto-invoked for storing/recalling context
- **Commands**:
  - `/minimem:remember <text>` - Store information
  - `/minimem:recall <query>` - Search memories
- **Session hooks** (opt-in): inject recent memories at session start, log a
  marker at session end. Enable with `minimem config --set hooks.sessionStart=true`
  and `hooks.sessionEnd=true`.

See `claude-plugin/README.md` for detailed documentation.

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm run test:all      # All tests
npm run test          # Unit tests (vitest)
npm run test:cli      # CLI command tests
npm run test:integration  # E2E integration tests

# Development mode
npm run dev
```

## License

MIT
