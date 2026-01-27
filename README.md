# minimem

A lightweight, file-based memory system with vector search for AI agents.

Turn your filesystem into a searchable knowledge base. Write memories in Markdown, search them semantically.

## Features

- **File-based storage** - Memories are plain Markdown files you can edit, version with git, and sync anywhere
- **Semantic search** - Find relevant memories using natural language queries powered by embeddings
- **Hybrid search** - Combines vector similarity with full-text search (BM25) for better results
- **Multiple embedding providers** - OpenAI, Google Gemini, or local models via llama.cpp
- **MCP server** - Integrate with Claude Desktop, Cursor, and other MCP-compatible tools
- **CLI tool** - Initialize, search, sync, and manage memories from the command line
- **Multi-directory search** - Search across multiple memory banks in a single query

## Installation

```bash
npm install minimem
```

Or install globally for CLI usage:

```bash
npm install -g minimem
```

Requires Node.js 22+ (uses experimental `node:sqlite`).

## Quick Start

### CLI Usage

```bash
# Initialize a memory directory
minimem init ~/memories

# Set your embedding API key
export OPENAI_API_KEY=your-key
# or: export GOOGLE_API_KEY=your-key

# Add some memories
minimem append "Decided to use PostgreSQL for the main database" --dir ~/memories

# Search your memories
minimem search "database decisions" --dir ~/memories

# Create or update a memory file
minimem upsert "memory/architecture.md" "# Architecture Notes..." --dir ~/memories
```

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

| Command | Description |
|---------|-------------|
| `minimem init [dir]` | Initialize a memory directory |
| `minimem search <query>` | Semantic search through memories |
| `minimem sync` | Force re-index memory files |
| `minimem status` | Show index stats and provider info |
| `minimem append <text>` | Append to today's daily log |
| `minimem upsert <file> [content]` | Create or update a memory file |
| `minimem mcp` | Run as MCP server (stdio) |

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
└── .minimem/           # Internal data (gitignored)
    ├── config.json     # Configuration
    └── index.db        # SQLite database with vectors
```

## Configuration

Configuration is stored in `.minimem/config.json`:

```json
{
  "embedding": {
    "provider": "auto",
    "model": "text-embedding-3-small"
  },
  "hybrid": {
    "enabled": true,
    "vectorWeight": 0.7,
    "textWeight": 0.3
  },
  "query": {
    "maxResults": 10,
    "minScore": 0.3
  }
}
```

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

### Available MCP Tool

The MCP server exposes a `memory_search` tool:

```typescript
{
  name: "memory_search",
  description: "Search through memory files using semantic search",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      maxResults: { type: "number", description: "Max results (default: 10)" },
      minScore: { type: "number", description: "Min score 0-1 (default: 0.3)" },
      directories: {
        type: "array",
        items: { type: "string" },
        description: "Filter to specific directories (searches all if omitted)"
      }
    },
    required: ["query"]
  }
}
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
    vectorWeight: 0.7,
    textWeight: 0.3
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
│  │  ~500 chars per chunk                │                    │
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
│  │  Weighted merge of results           │                    │
│  └─────────────────────────────────────┘                    │
└─────────────────────────────────────────────────────────────┘
```

### Indexing Process

1. **File Discovery**: Scans for `MEMORY.md` and `memory/*.md` files
2. **Chunking**: Splits content by Markdown headings and paragraphs (~500 chars each)
3. **Hashing**: Each chunk gets a content hash to detect changes
4. **Embedding**: New/changed chunks are sent to the embedding provider
5. **Storage**: Chunks and vectors stored in SQLite with sqlite-vec extension
6. **Caching**: Embeddings cached by content hash to avoid re-computation

### Search Process

1. **Query Embedding**: Convert search query to vector using same embedding model
2. **Vector Search**: Find similar chunks using cosine similarity (sqlite-vec)
3. **Text Search**: Find matching chunks using FTS5 full-text search (BM25)
4. **Hybrid Merge**: Combine results with configurable weights (default 70% vector, 30% text)
5. **Ranking**: Sort by combined score, apply min-score filter

### Why Hybrid Search?

Pure vector search excels at semantic similarity but can miss exact matches. Pure text search finds exact terms but misses synonyms. Hybrid search combines both:

- **Vector (70%)**: Finds conceptually related content ("database" matches "PostgreSQL")
- **Text (30%)**: Boosts exact keyword matches ("PostgreSQL" query ranks PostgreSQL mentions higher)

### Storage Format

SQLite database with three main tables:

```sql
-- File metadata and modification tracking
CREATE TABLE memory_files (
  path TEXT PRIMARY KEY,
  mtime INTEGER,
  hash TEXT
);

-- Content chunks with embeddings
CREATE TABLE memory_chunks (
  id INTEGER PRIMARY KEY,
  path TEXT,
  content TEXT,
  hash TEXT,
  start_line INTEGER,
  end_line INTEGER,
  heading TEXT,
  embedding BLOB  -- F32 vector
);

-- Full-text search index
CREATE VIRTUAL TABLE memory_fts USING fts5(content, path);

-- Vector similarity index (when sqlite-vec available)
CREATE VIRTUAL TABLE memory_vec USING vec0(embedding float[128]);
```

### Embedding Cache

Embeddings are cached by content hash in a separate table:

```sql
CREATE TABLE embedding_cache (
  hash TEXT PRIMARY KEY,
  embedding BLOB,
  model TEXT,
  created_at INTEGER
);
```

This means:
- Identical text always produces the same embedding (deterministic)
- Moving/copying chunks doesn't require re-embedding
- Switching files with same content is instant

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm run test:all      # All tests
npm run test:unit     # Unit tests (vitest)
npm run test:cli      # CLI command tests
npm run test:integration  # E2E integration tests

# Development mode
npm run dev
```

## License

MIT
