/**
 * Tests for index concurrency pragmas (requires node:sqlite)
 *
 * Run with: npm run test:db
 *
 * The SQLite file is a *derived* index that several processes may open at once — the
 * CLI, one or more MCP servers, and concurrent agents sharing a store. These guard the
 * pragmas that make that safe: without them the default rollback journal takes a
 * whole-database write lock (readers block during a sync) and a contended open fails
 * immediately with SQLITE_BUSY.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openSqliteDatabase } from "../open-db.js";

describe("index concurrency pragmas", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-concurrency-"));
    dbPath = path.join(dir, "index.db");
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("opens the index in WAL mode with a busy timeout", async () => {
    const db = await openSqliteDatabase(dbPath);
    try {
      const mode = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
      const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      assert.equal(mode.journal_mode, "wal");
      assert.ok(busy.timeout > 0, `expected a positive busy_timeout, got ${busy.timeout}`);
    } finally {
      db.close();
    }
  });

  it("honors MINIMEM_BUSY_TIMEOUT_MS", async () => {
    const previous = process.env.MINIMEM_BUSY_TIMEOUT_MS;
    process.env.MINIMEM_BUSY_TIMEOUT_MS = "1234";
    const db = await openSqliteDatabase(dbPath);
    try {
      const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout: number };
      assert.equal(busy.timeout, 1234);
    } finally {
      db.close();
      if (previous === undefined) delete process.env.MINIMEM_BUSY_TIMEOUT_MS;
      else process.env.MINIMEM_BUSY_TIMEOUT_MS = previous;
    }
  });

  it("lets a second connection read while a write transaction is open", async () => {
    const writer = await openSqliteDatabase(dbPath);
    const reader = await openSqliteDatabase(dbPath);
    try {
      writer.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
      writer.exec("INSERT INTO t (v) VALUES ('seed')");

      writer.exec("BEGIN IMMEDIATE");
      writer.exec("INSERT INTO t (v) VALUES ('uncommitted')");

      // Under a rollback journal this blocks or throws SQLITE_BUSY; under WAL the
      // reader proceeds and sees the pre-transaction snapshot.
      const during = reader.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
      assert.equal(during.n, 1);

      writer.exec("COMMIT");
      const after = reader.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
      assert.equal(after.n, 2);
    } finally {
      writer.close();
      reader.close();
    }
  });
});
