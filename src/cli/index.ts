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
import { config } from "./commands/config.js";
import { syncInit, syncInitCentral, syncList, syncRemove } from "./commands/sync-init.js";
import { pushCommand, pullCommand, syncStatusCommand } from "./commands/push-pull.js";
import { conflictsCommand, resolveCommand, cleanupCommand, logCommand } from "./commands/conflicts.js";
import { daemonCommand, daemonStopCommand, daemonStatusCommand, daemonLogsCommand } from "./commands/daemon.js";
import { storeList, storeAdd, storeRemove, storeLink, storeUnlink } from "./commands/store.js";
import { validateRegistry, formatValidationResult } from "./sync/validation.js";
import { VERSION } from "./version.js";
import { exitWithError } from "./config.js";

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
  .option("-p, --provider <name>", "Embedding provider (openai, gemini, local, none, auto); skips prompt")
  .option("-y, --yes", "Accept defaults without prompting (non-interactive)")
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
  .option("--no-links", "Disable linked store resolution")
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
  .option("-s, --session <id>", "Session ID to associate with this memory")
  .option("--session-source <name>", "Session source (claude-code, vscode, etc.)")
  .action(append);

// minimem upsert <file> [content]
program
  .command("upsert <file> [content]")
  .description("Create or update a memory file (file path relative to memory dir)")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("-p, --provider <name>", "Embedding provider (openai, gemini, local, auto)")
  .option("--stdin", "Read content from stdin")
  .option("-s, --session <id>", "Session ID to associate with this memory")
  .option("--session-source <name>", "Session source (claude-code, vscode, etc.)")
  .action(upsert);

// minimem mcp
program
  .command("mcp")
  .description("Run as MCP server over stdio (for Claude Desktop, Cursor, etc.)")
  .option("-d, --dir <path...>", "Memory directories (can specify multiple)")
  .option("-g, --global", "Include ~/.minimem")
  .option("-p, --provider <name>", "Embedding provider (openai, gemini, local, auto)")
  .action(mcp);

// minimem config
program
  .command("config")
  .description("View or modify configuration")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("--xdg-global", "Modify ~/.config/minimem/config.json (for sync settings)")
  .option("--json", "Output as JSON")
  .option("--set <key=value>", "Set a config value (e.g., embedding.provider=openai)")
  .option("--unset <key>", "Remove a config value")
  .action(config);

// minimem sync:init-central <path>
program
  .command("sync:init-central <path>")
  .description("Initialize a central repository for syncing memories")
  .option("-f, --force", "Force creation even if directory exists")
  .action(syncInitCentral);

// minimem sync:init
program
  .command("sync:init")
  .description("Initialize sync for a memory directory")
  .option("-d, --local <path>", "Memory directory to sync")
  .option("-g, --global", "Use ~/.minimem")
  .option("-p, --path <path>", "Path in central repo (e.g., myproject/)")
  .action(syncInit);

// minimem sync list
program
  .command("sync:list")
  .description("List all sync mappings")
  .action(syncList);

// minimem sync remove
program
  .command("sync:remove")
  .description("Remove sync mapping for a directory")
  .option("-d, --local <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .action(syncRemove);

// minimem push
program
  .command("push")
  .description("Push local changes to central repository")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("-f, --force", "Force push (overwrite remote on conflicts)")
  .option("--dry-run", "Show what would be pushed without making changes")
  .action(pushCommand);

// minimem pull
program
  .command("pull")
  .description("Pull changes from central repository")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("-f, --force", "Force pull (overwrite local on conflicts)")
  .option("--dry-run", "Show what would be pulled without making changes")
  .action(pullCommand);

// minimem sync:status
program
  .command("sync:status")
  .description("Show sync status for a directory")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .action(syncStatusCommand);

// minimem sync:conflicts
program
  .command("sync:conflicts")
  .description("List quarantined conflicts")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("--json", "Output as JSON")
  .action(conflictsCommand);

// minimem sync:resolve <timestamp>
program
  .command("sync:resolve <timestamp>")
  .description("Resolve a quarantined conflict using merge tool")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("-t, --tool <name>", "Merge tool (code, meld, kdiff3, vimdiff)")
  .action(resolveCommand);

// minimem sync:cleanup
program
  .command("sync:cleanup")
  .description("Clean up old quarantined conflicts")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("--days <number>", "Remove conflicts older than N days (default: 30)")
  .option("--dry-run", "Show what would be removed without removing")
  .action(cleanupCommand);

// minimem sync:log
program
  .command("sync:log")
  .description("Show sync history")
  .option("-d, --dir <path>", "Memory directory")
  .option("-g, --global", "Use ~/.minimem")
  .option("-n, --limit <number>", "Number of entries to show (default: 20)")
  .option("--json", "Output as JSON")
  .action(logCommand);

// minimem daemon
program
  .command("daemon")
  .description("Start the sync daemon")
  .option("-b, --background", "Run in background")
  .option("--foreground", "Run in foreground (internal use)")
  .action(daemonCommand);

// minimem daemon:stop
program
  .command("daemon:stop")
  .description("Stop the sync daemon")
  .action(daemonStopCommand);

// minimem daemon:status
program
  .command("daemon:status")
  .description("Show daemon status")
  .action(daemonStatusCommand);

// minimem daemon:logs
program
  .command("daemon:logs")
  .description("Show daemon logs")
  .option("-n, --lines <number>", "Number of lines to show (default: 50)")
  .option("-f, --follow", "Follow log output")
  .action(daemonLogsCommand);

// minimem sync:validate
program
  .command("sync:validate")
  .description("Validate registry for collisions and stale mappings")
  .option("--json", "Output as JSON")
  .action(async (options: { json?: boolean }) => {
    try {
      const result = await validateRegistry();

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatValidationResult(result));
      }

      if (!result.valid) {
        process.exit(1);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      exitWithError(message);
    }
  });

// minimem store:list
program
  .command("store:list")
  .description("List all registered stores and their links")
  .option("--json", "Output as JSON")
  .action(storeList);

// minimem store:add <name> <path>
program
  .command("store:add <name> <path>")
  .description("Register a store in the global manifest")
  .option("-r, --remote <url>", "Git remote URL for remote materialization")
  .option("--description <text>", "Human-readable description")
  .action(storeAdd);

// minimem store:remove <name>
program
  .command("store:remove <name>")
  .description("Remove a store from the global manifest")
  .action(storeRemove);

// minimem store:link <store> <target>
program
  .command("store:link <store> <target>")
  .description("Link a store to another (searches include linked stores)")
  .action(storeLink);

// minimem store:unlink <store> <target>
program
  .command("store:unlink <store> <target>")
  .description("Remove a link between stores")
  .action(storeUnlink);

// Parse and run
program.parse();
