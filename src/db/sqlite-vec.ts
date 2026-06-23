import type { DatabaseSync } from "node:sqlite";

export async function loadSqliteVecExtension(params: {
  db: DatabaseSync;
  extensionPath?: string;
}): Promise<{ ok: boolean; extensionPath?: string; error?: string }> {
  try {
    const sqliteVec = await import("sqlite-vec");
    const resolvedPath = params.extensionPath?.trim() ? params.extensionPath.trim() : undefined;
    const extensionPath = resolvedPath ?? sqliteVec.getLoadablePath();

    // node:sqlite requires enableLoadExtension() before loadExtension();
    // bun:sqlite has no such method (extension capability comes from the
    // underlying libsqlite3 build / setCustomSQLite), so only call it if present.
    const toggle = params.db as { enableLoadExtension?: (on: boolean) => void };
    if (typeof toggle.enableLoadExtension === "function") {
      toggle.enableLoadExtension(true);
    }
    if (resolvedPath) {
      params.db.loadExtension(extensionPath);
    } else {
      sqliteVec.load(params.db);
    }

    return { ok: true, extensionPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
