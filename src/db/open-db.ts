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
    return new Database(dbPath) as unknown as DatabaseSync;
  }

  const mod = (await import(["node", "sqlite"].join(":"))) as unknown as {
    DatabaseSync: new (
      path: string,
      options?: { allowExtension?: boolean },
    ) => DatabaseSync;
  };
  return new mod.DatabaseSync(dbPath, { allowExtension: true });
}
