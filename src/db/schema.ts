import type { DatabaseSync } from "node:sqlite";

/**
 * Current schema version. Increment this when making breaking schema changes.
 *
 * Version history:
 * - 1: Initial schema (meta, files, chunks, embedding_cache, FTS5)
 * - 2: Added source column to files and chunks tables
 */
export const SCHEMA_VERSION = 2;

export function ensureMemoryIndexSchema(params: {
  db: DatabaseSync;
  embeddingCacheTable: string;
  ftsTable: string;
  ftsEnabled: boolean;
}): { ftsAvailable: boolean; ftsError?: string; migrated?: boolean } {
  // Create meta table first (needed for version tracking)
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  // Check schema version and handle migration
  const migrated = migrateIfNeeded(params.db, params.ftsTable);

  params.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
  `);
  params.db.exec(
    `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${params.embeddingCacheTable}(updated_at);`,
  );

  let ftsAvailable = false;
  let ftsError: string | undefined;
  if (params.ftsEnabled) {
    try {
      params.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(\n` +
          `  text,\n` +
          `  id UNINDEXED,\n` +
          `  path UNINDEXED,\n` +
          `  source UNINDEXED,\n` +
          `  model UNINDEXED,\n` +
          `  start_line UNINDEXED,\n` +
          `  end_line UNINDEXED\n` +
          `);`,
      );
      ftsAvailable = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ftsAvailable = false;
      ftsError = message;
    }
  }

  ensureColumn(params.db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(params.db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);

  // Store current schema version
  params.db.prepare(
    `INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)`,
  ).run(String(SCHEMA_VERSION));

  return { ftsAvailable, ...(ftsError ? { ftsError } : {}), ...(migrated ? { migrated } : {}) };
}

/**
 * Check the stored schema version and migrate if needed.
 * For breaking changes, drops data tables so they get recreated fresh.
 * The embedding cache is preserved across migrations when possible.
 *
 * @returns true if a migration was performed, false otherwise.
 */
function migrateIfNeeded(db: DatabaseSync, ftsTable: string): boolean {
  let storedVersion = 0;
  try {
    const row = db.prepare(
      `SELECT value FROM meta WHERE key = 'schema_version'`,
    ).get() as { value: string } | undefined;
    if (row) {
      storedVersion = parseInt(row.value, 10) || 0;
    }
  } catch {
    // meta table may not have the key yet (pre-versioning databases)
    storedVersion = 0;
  }

  if (storedVersion >= SCHEMA_VERSION) return false;

  if (storedVersion > 0 && storedVersion < SCHEMA_VERSION) {
    // Breaking schema change: drop and recreate data tables.
    // Embedding cache is preserved since embeddings are content-addressed
    // and will be reused on re-index.
    db.exec(`DROP TABLE IF EXISTS files`);
    db.exec(`DROP TABLE IF EXISTS chunks`);
    db.exec(`DROP TABLE IF EXISTS ${ftsTable}`);
    // Also drop the vector table if it exists
    try {
      db.exec(`DROP TABLE IF EXISTS chunks_vec`);
    } catch {
      // sqlite-vec table may not exist
    }
  }

  return storedVersion > 0;
}

function ensureColumn(
  db: DatabaseSync,
  table: "files" | "chunks",
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
