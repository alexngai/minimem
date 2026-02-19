/**
 * Tests for knowledge-aware features:
 * - Frontmatter parsing of knowledge fields
 * - Knowledge link types
 * - Graph traversal functions
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  parseFrontmatter,
  serializeFrontmatter,
  type MemoryFrontmatter,
} from "../session.js";
import {
  getLinksFrom,
  getLinksTo,
  getNeighbors,
  getPathBetween,
  type GraphLink,
} from "../search/graph.js";

// =========================================================================
// Frontmatter parsing
// =========================================================================

describe("Knowledge frontmatter", () => {
  it("parses full knowledge frontmatter with all fields", () => {
    const content = `---
id: k-abc123
type: observation
domain: [database, devops]
entities: [prisma, postgres]
confidence: 0.85
source:
  origin: extracted
  trajectories: [t-001, t-002]
  agentId: agent-v1
links:
  - target: k-other
    relation: related-to
    layer: semantic
created: 2025-01-15T10:00:00Z
updated: 2025-01-15T12:00:00Z
supersedes: k-old
---
# Observation

Body content here.`;

    const { frontmatter, body } = parseFrontmatter(content);

    expect(frontmatter).toBeDefined();
    expect(frontmatter!.id).toBe("k-abc123");
    expect(frontmatter!.type).toBe("observation");
    expect(frontmatter!.domain).toEqual(["database", "devops"]);
    expect(frontmatter!.entities).toEqual(["prisma", "postgres"]);
    expect(frontmatter!.confidence).toBe(0.85);
    expect(frontmatter!.source?.origin).toBe("extracted");
    expect(frontmatter!.source?.trajectories).toEqual(["t-001", "t-002"]);
    expect(frontmatter!.source?.agentId).toBe("agent-v1");
    expect(frontmatter!.links).toHaveLength(1);
    expect(frontmatter!.links![0].target).toBe("k-other");
    expect(frontmatter!.links![0].relation).toBe("related-to");
    expect(frontmatter!.links![0].layer).toBe("semantic");
    expect(frontmatter!.created).toBe("2025-01-15T10:00:00Z");
    expect(frontmatter!.supersedes).toBe("k-old");
    expect(body).toContain("Body content here.");
  });

  it("parses note with no knowledge fields as standard frontmatter", () => {
    const content = `---
created: 2025-01-15T10:00:00Z
tags: [daily, meeting]
---
Regular memory content.`;

    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter).toBeDefined();
    expect(frontmatter!.created).toBe("2025-01-15T10:00:00Z");
    expect(frontmatter!.tags).toEqual(["daily", "meeting"]);
    // Knowledge fields should be absent
    expect(frontmatter!.id).toBeUndefined();
    expect(frontmatter!.type).toBeUndefined();
    expect(frontmatter!.domain).toBeUndefined();
  });

  it("parses note with links array", () => {
    const content = `---
id: k-linked
type: entity
links:
  - target: k-dep1
    relation: depends-on
  - target: k-dep2
    relation: supports
    layer: causal
---
Entity note.`;

    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter!.links).toHaveLength(2);
    expect(frontmatter!.links![0].target).toBe("k-dep1");
    expect(frontmatter!.links![0].relation).toBe("depends-on");
    expect(frontmatter!.links![0].layer).toBeUndefined();
    expect(frontmatter!.links![1].target).toBe("k-dep2");
    expect(frontmatter!.links![1].relation).toBe("supports");
    expect(frontmatter!.links![1].layer).toBe("causal");
  });

  it("parses note with source object", () => {
    const content = `---
id: k-sourced
type: observation
confidence: 0.7
source:
  origin: agent-authored
  trajectories: [t-100]
  agentId: claude-v3
---
Source test.`;

    const { frontmatter } = parseFrontmatter(content);

    expect(frontmatter!.source).toBeDefined();
    expect(frontmatter!.source!.origin).toBe("agent-authored");
    expect(frontmatter!.source!.trajectories).toEqual(["t-100"]);
    expect(frontmatter!.source!.agentId).toBe("claude-v3");
  });

  it("round-trips via serialize then parse", () => {
    const original: MemoryFrontmatter = {
      id: "k-round-trip",
      type: "domain-summary",
      domain: ["testing"],
      entities: ["vitest"],
      confidence: 0.9,
      created: "2025-02-01T00:00:00Z",
      updated: "2025-02-01T12:00:00Z",
      source: {
        origin: "extracted",
        trajectories: ["t-42"],
      },
      links: [
        { target: "k-other", relation: "related-to", layer: "semantic" },
      ],
    };

    const serialized = serializeFrontmatter(original);
    const { frontmatter } = parseFrontmatter(serialized + "\nBody");

    expect(frontmatter!.id).toBe("k-round-trip");
    expect(frontmatter!.type).toBe("domain-summary");
    expect(frontmatter!.domain).toEqual(["testing"]);
    expect(frontmatter!.confidence).toBe(0.9);
    expect(frontmatter!.source?.origin).toBe("extracted");
    expect(frontmatter!.links).toHaveLength(1);
    expect(frontmatter!.links![0].target).toBe("k-other");
  });
});

// =========================================================================
// Graph traversal
// =========================================================================

describe("Knowledge graph", () => {
  let db: DatabaseSync;

  beforeEach(() => {
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

  afterEach(() => {
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

  it("getLinksFrom returns outgoing edges", () => {
    insertLink("A", "B", "related-to", "semantic");
    insertLink("A", "C", "depends-on", "causal");
    insertLink("B", "C", "supports");

    const links = getLinksFrom(db, "A");
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.toId).sort()).toEqual(["B", "C"]);
  });

  it("getLinksTo returns incoming edges", () => {
    insertLink("A", "C", "related-to");
    insertLink("B", "C", "depends-on");

    const links = getLinksTo(db, "C");
    expect(links).toHaveLength(2);
    expect(links.map((l) => l.fromId).sort()).toEqual(["A", "B"]);
  });

  it("getLinksFrom filters by relation and layer", () => {
    insertLink("A", "B", "related-to", "semantic");
    insertLink("A", "C", "depends-on", "causal");

    const byRelation = getLinksFrom(db, "A", { relation: "related-to" });
    expect(byRelation).toHaveLength(1);
    expect(byRelation[0].toId).toBe("B");

    const byLayer = getLinksFrom(db, "A", { layer: "causal" });
    expect(byLayer).toHaveLength(1);
    expect(byLayer[0].toId).toBe("C");
  });

  it("getNeighbors with depth=1 returns direct neighbors", () => {
    insertLink("A", "B", "related-to");
    insertLink("B", "C", "depends-on");
    insertLink("C", "D", "supports");

    const neighbors = getNeighbors(db, "A", 1);
    expect(neighbors).toHaveLength(1);
    expect(neighbors[0].id).toBe("B");
    expect(neighbors[0].depth).toBe(1);
  });

  it("getNeighbors with depth=2 returns transitive neighbors", () => {
    insertLink("A", "B", "related-to");
    insertLink("B", "C", "depends-on");
    insertLink("C", "D", "supports");

    const neighbors = getNeighbors(db, "A", 2);
    expect(neighbors).toHaveLength(2);

    const ids = neighbors.map((n) => n.id);
    expect(ids).toContain("B");
    expect(ids).toContain("C");
  });

  it("getPathBetween finds shortest path", () => {
    insertLink("A", "B", "related-to");
    insertLink("B", "C", "depends-on");
    insertLink("C", "D", "supports");

    const path = getPathBetween(db, "A", "C");
    expect(path).toHaveLength(2);
    expect(path[0].fromId).toBe("A");
    expect(path[0].toId).toBe("B");
    expect(path[1].fromId).toBe("B");
    expect(path[1].toId).toBe("C");
  });

  it("getPathBetween returns empty for disconnected nodes", () => {
    insertLink("A", "B", "related-to");
    // C is disconnected

    const path = getPathBetween(db, "A", "C");
    expect(path).toEqual([]);
  });

  it("getPathBetween handles same node", () => {
    const path = getPathBetween(db, "A", "A");
    expect(path).toEqual([]);
  });
});
