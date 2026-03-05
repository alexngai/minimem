/**
 * Tests for knowledge frontmatter parsing
 * (Split from knowledge.test.ts to run under vitest — no node:sqlite dependency)
 */

import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  serializeFrontmatter,
  type MemoryFrontmatter,
} from "../session.js";

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
