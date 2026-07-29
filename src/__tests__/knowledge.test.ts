/**
 * Tests for knowledge graph traversal (requires node:sqlite)
 *
 * Run with: npm run test:knowledge
 * Frontmatter parsing tests are in knowledge-frontmatter.test.ts (vitest)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  getLinksFrom,
  getLinksTo,
  getNeighbors,
  getPathBetween,
} from "../search/graph.js";
import { Minimem } from "../minimem.js";
import { serializeFrontmatter, type MemoryFrontmatter } from "../session.js";
import { createMockFetch } from "./helpers.js";

describe("Knowledge graph", () => {
  let db: DatabaseSync;

  before(() => {
    db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE knowledge_links (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        layer TEXT,
        weight REAL DEFAULT 0.5,
        source_path TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (from_id, to_id, relation)
      );
      CREATE INDEX idx_links_from ON knowledge_links(from_id);
      CREATE INDEX idx_links_to ON knowledge_links(to_id);
      CREATE INDEX idx_links_layer ON knowledge_links(layer);
    `);
  });

  after(() => {
    db.close();
  });

  function insertLink(
    fromId: string,
    toId: string,
    relation: string,
    layer?: string,
    weight = 0.5,
  ) {
    db.prepare(
      `INSERT INTO knowledge_links (from_id, to_id, relation, layer, weight) VALUES (?, ?, ?, ?, ?)`,
    ).run(fromId, toId, relation, layer ?? null, weight);
  }

  function clearLinks() {
    db.exec("DELETE FROM knowledge_links");
  }

  it("getLinksFrom returns outgoing edges", () => {
    clearLinks();
    insertLink("A", "B", "related-to", "semantic");
    insertLink("A", "C", "depends-on", "causal");
    insertLink("B", "C", "supports");

    const links = getLinksFrom(db, "A");
    assert.strictEqual(links.length, 2);
    assert.deepStrictEqual(links.map((l) => l.toId).sort(), ["B", "C"]);
  });

  it("getLinksTo returns incoming edges", () => {
    clearLinks();
    insertLink("A", "C", "related-to");
    insertLink("B", "C", "depends-on");

    const links = getLinksTo(db, "C");
    assert.strictEqual(links.length, 2);
    assert.deepStrictEqual(links.map((l) => l.fromId).sort(), ["A", "B"]);
  });

  it("getLinksFrom filters by relation and layer", () => {
    clearLinks();
    insertLink("A", "B", "related-to", "semantic");
    insertLink("A", "C", "depends-on", "causal");

    const byRelation = getLinksFrom(db, "A", { relation: "related-to" });
    assert.strictEqual(byRelation.length, 1);
    assert.strictEqual(byRelation[0].toId, "B");

    const byLayer = getLinksFrom(db, "A", { layer: "causal" });
    assert.strictEqual(byLayer.length, 1);
    assert.strictEqual(byLayer[0].toId, "C");
  });

  it("getNeighbors with depth=1 returns direct neighbors", () => {
    clearLinks();
    insertLink("A", "B", "related-to");
    insertLink("B", "C", "depends-on");
    insertLink("C", "D", "supports");

    const neighbors = getNeighbors(db, "A", 1);
    assert.strictEqual(neighbors.length, 1);
    assert.strictEqual(neighbors[0].id, "B");
    assert.strictEqual(neighbors[0].depth, 1);
  });

  it("getNeighbors with depth=2 returns transitive neighbors", () => {
    clearLinks();
    insertLink("A", "B", "related-to");
    insertLink("B", "C", "depends-on");
    insertLink("C", "D", "supports");

    const neighbors = getNeighbors(db, "A", 2);
    assert.strictEqual(neighbors.length, 2);

    const ids = neighbors.map((n) => n.id);
    assert.ok(ids.includes("B"));
    assert.ok(ids.includes("C"));
  });

  it("getPathBetween finds shortest path", () => {
    clearLinks();
    insertLink("A", "B", "related-to");
    insertLink("B", "C", "depends-on");
    insertLink("C", "D", "supports");

    const path = getPathBetween(db, "A", "C");
    assert.strictEqual(path.length, 2);
    assert.strictEqual(path[0].fromId, "A");
    assert.strictEqual(path[0].toId, "B");
    assert.strictEqual(path[1].fromId, "B");
    assert.strictEqual(path[1].toId, "C");
  });

  it("getPathBetween returns empty for disconnected nodes", () => {
    clearLinks();
    insertLink("A", "B", "related-to");

    const path = getPathBetween(db, "A", "C");
    assert.deepStrictEqual(path, []);
  });

  it("getPathBetween handles same node", () => {
    clearLinks();
    const path = getPathBetween(db, "A", "A");
    assert.deepStrictEqual(path, []);
  });
});

describe("Auto entity-graph (sync-time co-entity edges)", () => {
  let originalFetch: typeof fetch;

  // Four observation notes: k-a/k-b share entity "prisma", k-c/k-d share "postgres".
  const NOTES: Array<{ id: string; entities: string[]; body: string }> = [
    { id: "k-a", entities: ["prisma"], body: "Alpha migration note about the prisma schema." },
    { id: "k-b", entities: ["prisma"], body: "Beta rollback note about the prisma client." },
    { id: "k-c", entities: ["postgres"], body: "Gamma tuning note about the postgres planner." },
    { id: "k-d", entities: ["postgres"], body: "Delta backup note about the postgres cluster." },
  ];

  async function writeNotes(dir: string): Promise<void> {
    const notesDir = path.join(dir, "memory");
    await fs.mkdir(notesDir, { recursive: true });
    await fs.writeFile(path.join(dir, "MEMORY.md"), "# Memory\n\nIndex of knowledge notes.\n", "utf8");
    for (const note of NOTES) {
      const fm: MemoryFrontmatter = {
        id: note.id,
        type: "observation",
        entities: note.entities,
        confidence: 0.8,
      };
      await fs.writeFile(
        path.join(notesDir, `${note.id}.md`),
        `${serializeFrontmatter(fm)}\n\n${note.body}\n`,
        "utf8",
      );
    }
  }

  async function buildStore(prefix: string, graph?: { autoEntityLinks?: boolean }): Promise<{
    mm: Minimem;
    dir: string;
  }> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    await writeNotes(dir);
    const mm = await Minimem.create({
      memoryDir: dir,
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      watch: { enabled: false },
      query: { minScore: 0 },
      ...(graph ? { graph } : {}),
    });
    await mm.sync({ force: true });
    return { mm, dir };
  }

  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch() as unknown as typeof fetch;
    process.env.OPENAI_API_KEY = "test-api-key-for-knowledge-tests";
  });

  after(() => {
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
  });

  it("creates co-entity/entity edges (source_path='auto:entity') for shared-entity notes", async () => {
    const { mm, dir } = await buildStore("minimem-autograph-on-", { autoEntityLinks: true });
    try {
      // prisma pair: k-a -> k-b (a < b string compare).
      const prismaEdges = mm.getLinks("k-a", "from");
      const prismaEdge = prismaEdges.find((l) => l.toId === "k-b");
      assert.ok(prismaEdge, "expected an auto edge k-a -> k-b");
      assert.strictEqual(prismaEdge.relation, "co-entity");
      assert.strictEqual(prismaEdge.layer, "entity");
      assert.strictEqual(prismaEdge.sourcePath, "auto:entity");
      assert.strictEqual(prismaEdge.weight, 0.5);

      // postgres pair: k-c -> k-d.
      const postgresEdge = mm.getLinks("k-c", "from").find((l) => l.toId === "k-d");
      assert.ok(postgresEdge, "expected an auto edge k-c -> k-d");
      assert.strictEqual(postgresEdge.sourcePath, "auto:entity");

      // Cross-entity notes must NOT be connected.
      const neighborsOfA = mm.getGraphNeighbors("k-a", 2).map((n) => n.id);
      assert.ok(!neighborsOfA.includes("k-c"), "prisma and postgres notes must not be linked");
      assert.ok(!neighborsOfA.includes("k-d"), "prisma and postgres notes must not be linked");
    } finally {
      await mm.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("graphExpand surfaces a co-entity neighbor that plain search does not", async () => {
    const { mm, dir } = await buildStore("minimem-autograph-expand-", { autoEntityLinks: true });
    try {
      // "alpha" appears only in k-a's body, so it seeds k-a alone.
      const plain = await mm.search("alpha", { maxResults: 1, minScore: 0 });
      const expanded = await mm.search("alpha", { maxResults: 1, minScore: 0, graphExpand: 1 });

      const plainHasB = plain.some((r) => r.path.endsWith("k-b.md"));
      const expandedHasB = expanded.some((r) => r.path.endsWith("k-b.md"));

      assert.ok(plain.some((r) => r.path.endsWith("k-a.md")), "plain search should seed k-a");
      assert.ok(!plainHasB, "plain search should not surface the co-entity neighbor k-b");
      assert.ok(expandedHasB, "graphExpand should surface the co-entity neighbor k-b");
    } finally {
      await mm.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("creates no auto edges when autoEntityLinks is off (default)", async () => {
    const { mm, dir } = await buildStore("minimem-autograph-off-");
    try {
      for (const note of NOTES) {
        const from = mm.getLinks(note.id, "from");
        const to = mm.getLinks(note.id, "to");
        const autoEdges = [...from, ...to].filter((l) => l.sourcePath === "auto:entity");
        assert.strictEqual(autoEdges.length, 0, `expected no auto edges for ${note.id}`);
      }
      // graphExpand is a no-op with no edges: same result set as plain search.
      const plain = await mm.search("alpha", { maxResults: 1, minScore: 0 });
      const expanded = await mm.search("alpha", { maxResults: 1, minScore: 0, graphExpand: 1 });
      assert.deepStrictEqual(
        expanded.map((r) => r.path),
        plain.map((r) => r.path),
      );
    } finally {
      await mm.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
