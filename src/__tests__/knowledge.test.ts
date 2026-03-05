/**
 * Tests for knowledge graph traversal (requires node:sqlite)
 *
 * Run with: npm run test:knowledge
 * Frontmatter parsing tests are in knowledge-frontmatter.test.ts (vitest)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  getLinksFrom,
  getLinksTo,
  getNeighbors,
  getPathBetween,
} from "../search/graph.js";

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
