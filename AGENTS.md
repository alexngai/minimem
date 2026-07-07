# Agent Instructions

**minimem** is a file-based memory system for AI agents: memories are plain
Markdown files, indexed into a local SQLite file (vector + FTS5 hybrid search)
and served to agents via a CLI and an MCP server (Claude Desktop, Claude Code,
Cursor). See [CLAUDE.md](CLAUDE.md) for the full contributor guide:
architecture map, key files, patterns, and common tasks like adding CLI
commands or embedding providers.

Quick reference:

```sh
npm run build      # Build library and CLI (tsup + postbuild)
npm run test       # Unit tests (vitest)
npm run test:all   # Unit + integration + CLI + knowledge tests (node:test)
npm run eval:ci    # Offline retrieval-eval regression gate
```

Requires Node.js 22+ (uses `node:sqlite`).

Top conventions: TypeScript strict mode, ESM only, async/await for I/O, types
exported alongside implementations.
