import { describe, expect, it } from "vitest";

import { selectResults, type SelectCandidate } from "../select.js";

const c = (
  id: string,
  score: number,
  extra: Partial<SelectCandidate> = {},
): SelectCandidate => ({ id, score, ...extra });

describe("selectResults", () => {
  it("defaults to plain score-ordered truncation", () => {
    const out = selectResults([c("a", 0.9), c("b", 0.8), c("c", 0.7)], { limit: 2 });
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("returns nothing for limit 0 or an empty pool", () => {
    expect(selectResults([c("a", 1)], { limit: 0 })).toEqual([]);
    expect(selectResults([], { limit: 5 })).toEqual([]);
  });

  describe("diversity", () => {
    // The failure this exists for: three near-identical passages outrank the one
    // candidate carrying the second fact the query asked for.
    const dupes = [
      c("dup1", 0.90, { snippet: "the stipend amount is 2600 usd per month" }),
      c("dup2", 0.89, { snippet: "the stipend amount is 2600 usd monthly" }),
      c("dup3", 0.88, { snippet: "stipend amount 2600 usd per month confirmed" }),
      c("other", 0.60, { snippet: "the review meeting is scheduled for may 13" }),
    ];

    it("without diversity, redundant passages crowd out the distinct one", () => {
      const out = selectResults(dupes, { limit: 3 });
      expect(out.map((r) => r.id)).toEqual(["dup1", "dup2", "dup3"]);
      expect(out.some((r) => r.id === "other")).toBe(false);
    });

    it("with diversity, the distinct passage is surfaced", () => {
      const out = selectResults(dupes, { limit: 3, diversity: 0.5 });
      expect(out.map((r) => r.id)).toContain("other");
      expect(out[0].id).toBe("dup1"); // top relevance still leads
    });

    it("diversity 0 is exactly the default path", () => {
      const a = selectResults(dupes, { limit: 3, diversity: 0 }).map((r) => r.id);
      const b = selectResults(dupes, { limit: 3 }).map((r) => r.id);
      expect(a).toEqual(b);
    });
  });

  describe("supersede", () => {
    const pool = [
      c("old", 0.9, { knowledgeId: "k-1" }),
      c("new", 0.7, { knowledgeId: "k-2", supersedes: "k-1" }),
    ];

    it("drops a candidate superseded by another in the pool", () => {
      const out = selectResults(pool, { limit: 2, supersede: true });
      expect(out.map((r) => r.id)).toEqual(["new"]);
    });

    it("is off by default, so both versions survive", () => {
      const out = selectResults(pool, { limit: 2 });
      expect(out.map((r) => r.id)).toEqual(["old", "new"]);
    });

    it("never empties the pool", () => {
      // Superseding note is not itself a candidate; dropping would leave nothing.
      const only = [c("old", 0.9, { knowledgeId: "k-1", supersedes: "k-0" })];
      const out = selectResults([...only, c("x", 0.1, { supersedes: "k-1" })], {
        limit: 1,
        supersede: true,
      });
      expect(out.length).toBe(1);
    });
  });

  describe("quotas", () => {
    const mixed = [
      c("o1", 0.99, { knowledgeType: "observation" }),
      c("o2", 0.98, { knowledgeType: "observation" }),
      c("o3", 0.97, { knowledgeType: "observation" }),
      c("s1", 0.40, { knowledgeType: "domain-summary" }),
    ];

    it("reserves slots so a lower-ranked layer is not crowded out", () => {
      const out = selectResults(mixed, { limit: 3, quotas: { "domain-summary": 1 } });
      expect(out.map((r) => r.id)).toContain("s1");
      expect(out.length).toBe(3);
    });

    it("returns unfilled quota slots to the general pool", () => {
      const out = selectResults(mixed, { limit: 3, quotas: { "entity": 2 } });
      expect(out.length).toBe(3);
      expect(out.map((r) => r.id)).toEqual(["o1", "o2", "o3"]);
    });
  });

  describe("recency", () => {
    it("promotes a newer note when relevance is close", () => {
      const pool = [
        c("old", 0.80, { createdAt: 1_000 }),
        c("new", 0.78, { createdAt: 9_000 }),
      ];
      expect(selectResults(pool, { limit: 1 })[0].id).toBe("old");
      expect(selectResults(pool, { limit: 1, recency: 0.5 })[0].id).toBe("new");
    });

    it("does not let a marginal new note beat a much stronger old one", () => {
      const pool = [
        c("strong-old", 0.95, { createdAt: 1_000 }),
        c("weak-new", 0.10, { createdAt: 9_000 }),
      ];
      expect(selectResults(pool, { limit: 1, recency: 0.3 })[0].id).toBe("strong-old");
    });
  });
});
