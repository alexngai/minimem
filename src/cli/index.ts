/**
 * Minimem CLI
 *
 * A file-based memory system with vector search for AI agents.
 */

import { program } from "commander";

import { init } from "./commands/init.js";
import { search } from "./commands/search.js";
import { sync } from "./commands/sync.js";
import { status } from "./commands/status.js";
import { append } from "./commands/append.js";
import { upsert } from "./commands/upsert.js";
import { mcp } from "./commands/mcp.js";

// Read version from package.json at runtime would require fs
// For simplicity, hardcode it (update during releases)
const VERSION = "0.0.2";

program
  .name("minimem")
  .description("File-based memory system with vector search for AI agents")
  .version(VERSION);

// minimem init [dir]
program
  .command("init [dir]")
  .description("Initialize a memory directory")
  .option("-g, --global", "Use ~/.minimem as global memory directory")
  .option("-f, --force", "Reinitialize even if already initialized")
  .action(init);

// minimem search <query>
program
  .command("search <query>")
  .description("Semantic search through memory files")
  .option("-d, --dir <path...>", "Memory directories (can specify multiple)")
  .option("-g, --global", "Include ~/.minimem in search")
  .option("-n, --max <number>", "Maximum results (default: 10)")
  .option("-s, --min-score <number>", "Minimum score threshold 0-1 (default: 0.3)")
  .option("-p, --provider <name>", "Embedding provider (openai, gemini, local, auto)")
  .option("--json", "Output results as JSON")
  .action(search);

// minimem sync
program
  .command("sync")
  .description("Force re-index memory files")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("-f, --force", "Force full re-index")
  .option("-p, --provider <name>", "Embedding provider (openai, gemini, local, auto)")
  .action(sync);

// minimem status
program
  .command("status")
  .description("Show index stats and provider info")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("-p, --provider <name>", "Embedding provider (openai, gemini, local, auto)")
  .option("--json", "Output as JSON")
  .action(status);

// minimem append <text>
program
  .command("append <text>")
  .description("Append text to today's daily log (memory/YYYY-MM-DD.md)")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("-f, --file <path>", "Append to specific file instead of today's log")
  .option("-p, --provider <name>", "Embedding provider (openai, gemini, local, auto)")
  .action(append);

// minimem upsert <file> [content]
program
  .command("upsert <file> [content]")
  .description("Create or update a memory file")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("-p, --provider <name>", "Embedding provider (openai, gemini, local, auto)")
  .option("--stdin", "Read content from stdin")
  .action(upsert);

// minimem mcp
program
  .command("mcp")
  .description("Run as MCP server over stdio (for Claude Desktop, Cursor, etc.)")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("-p, --provider <name>", "Embedding provider (openai, gemini, local, auto)")
  .action(mcp);

// Parse and run
program.parse();
