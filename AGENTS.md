# Agent Instructions

Working on the minimem codebase? See [CLAUDE.md](CLAUDE.md) for the full
contributor guide: architecture map, key files, development commands, testing
conventions, and common tasks like adding CLI commands or embedding providers.

Quick reference:

```sh
npm run build      # Build library and CLI (tsup + postbuild)
npm run test       # Unit tests (vitest)
npm run test:all   # Unit + integration + CLI + knowledge tests
npm run eval:ci    # Offline retrieval-eval regression gate
```

Requires Node.js 22+ (uses `node:sqlite`).
