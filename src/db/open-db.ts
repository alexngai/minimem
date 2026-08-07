/**
 * Cross-runtime SQLite opener for minimem.
 *
 *  - Node 22+ -> `node:sqlite` `DatabaseSync` (with `allowExtension` so the
 *    sqlite-vec extension can be loaded for native vector search).
 *  - Bun      -> `bun:sqlite` `Database`. Bun's *bundled* SQLite disables
 *    dynamic extension loading, so to get native sqlite-vec we point Bun at an
 *    extension-enabled `libsqlite3` via `Database.setCustomSQLite()` — taken
 *    from `MINIMEM_SQLITE_LIB` or common system locations. If none is found,
 *    sqlite-vec simply won't load and minimem falls back to brute-force JS
 *    cosine (FTS/BM25 are unaffected and stay full-speed).
 *
 * The module specifier is assembled at runtime so bundlers can't rewrite the
 * prefix-only builtins (`node:sqlite` -> bare `sqlite`, which is invalid).
 */

import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";

/** Common locations of an extension-enabled libsqlite3 (Bun path only). */
const SQLITE_LIB_CANDIDATES = [
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  "/opt/homebrew/lib/libsqlite3.dylib",
  "/usr/lib/x86_64-linux-gnu/libsqlite3.so.0",
  "/usr/lib/aarch64-linux-gnu/libsqlite3.so.0",
  "/usr/lib/libsqlite3.so.0",
];

function findExtensionEnabledSqlite(): string | undefined {
  const env = process.env.MINIMEM_SQLITE_LIB;
  if (env && env.trim().length > 0 && existsSync(env)) return env;
  for (const candidate of SQLITE_LIB_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

interface BunDatabaseCtor {
  new (path: string): unknown;
  setCustomSQLite?: (path: string) => void;
}

/** How long a connection waits on a locked index before erroring. */
const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

/**
 * Concurrency pragmas.
 *
 * minimem's source of truth is the Markdown files; the SQLite file is a *derived*
 * index that several processes may open at once — the CLI, one or more MCP servers,
 * and concurrent agents sharing a store. Without these, the default rollback journal
 * takes a whole-database write lock (readers block during a sync) and a contended
 * open fails immediately with SQLITE_BUSY.
 *
 * - `busy_timeout`: wait-and-retry instead of throwing on a held lock (per connection).
 * - `journal_mode = WAL`: readers run concurrently with a writer (persisted in the file).
 * - `synchronous = NORMAL`: the standard WAL companion — crash-safe, and only risks the
 *   last transaction on power loss, which is fine for a rebuildable index.
 *
 * All best-effort: WAL is unavailable on some network filesystems and read-only
 * databases reject the journal-mode change. On failure we keep SQLite's defaults
 * rather than failing to open.
 */
function applyConcurrencyPragmas(db: { exec: (sql: string) => void }): void {
  const configured = Number(process.env.MINIMEM_BUSY_TIMEOUT_MS);
  const busyTimeoutMs = Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_BUSY_TIMEOUT_MS;
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  } catch {
    // Without it a contended index throws immediately instead of waiting.
  }
  try {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  } catch {
    // Network filesystem or read-only database — stay on the default rollback journal.
  }
}

export async function openSqliteDatabase(dbPath: string): Promise<DatabaseSync> {
  if (isBun) {
    const mod = (await import(["bun", "sqlite"].join(":"))) as unknown as {
      Database: BunDatabaseCtor;
      default?: BunDatabaseCtor;
    };
    const Database = mod.Database ?? mod.default!;
    // Best-effort: enable native sqlite-vec by pointing Bun at an
    // extension-enabled libsqlite3. Harmless if absent or already locked in —
    // minimem then degrades to brute-force cosine.
    const lib = findExtensionEnabledSqlite();
    if (lib && typeof Database.setCustomSQLite === "function") {
      try {
        Database.setCustomSQLite(lib);
      } catch {
        // A Database was already opened, or the lib is unusable — keep default.
      }
    }
    const bunDb = new Database(dbPath) as unknown as DatabaseSync;
    applyConcurrencyPragmas(bunDb);
    return bunDb;
  }

  const mod = (await import(["node", "sqlite"].join(":"))) as unknown as {
    DatabaseSync: new (
      path: string,
      options?: { allowExtension?: boolean },
    ) => DatabaseSync;
  };
  const db = new mod.DatabaseSync(dbPath, { allowExtension: true });
  applyConcurrencyPragmas(db);
  return db;
}
