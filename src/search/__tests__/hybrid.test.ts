import { describe, expect, it } from "vitest";

import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "../hybrid.js";

describe("buildFtsQuery", () => {
  it("tokenizes and OR-joins by default", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" OR "world"');
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" OR "baz" OR "1"');
  });

  it("returns null for empty/whitespace input", () => {
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery("")).toBeNull();
  });

  it("strips quotes from tokens", () => {
    expect(buildFtsQuery('hello "world')).toBe('"hello" OR "world"');
  });

  it("handles single token", () => {
    expect(buildFtsQuery("hello")).toBe('"hello"');
  });

  it("handles special characters", () => {
    expect(buildFtsQuery("hello@world.com")).toBe('"hello" OR "world" OR "com"');
  });

  it("AND-joins when mode is 'and'", () => {
    expect(buildFtsQuery("hello world", "and")).toBe('"hello" AND "world"');
    expect(buildFtsQuery("FOO_bar baz-1", "and")).toBe('"FOO_bar" AND "baz" AND "1"');
  });

  it("explicit 'or' matches the default", () => {
    expect(buildFtsQuery("hello world", "or")).toBe('"hello" OR "world"');
    expect(buildFtsQuery("solo", "or")).toBe('"solo"');
    expect(buildFtsQuery("hello world", "or")).toBe(buildFtsQuery("hello world"));
  });
});

describe("bm25RankToScore", () => {
  it("returns 0 for rank 0 (no relevance signal)", () => {
    expect(bm25RankToScore(0)).toBeCloseTo(0);
  });

  it("returns 0.5 for rank 1 or -1", () => {
    // Both positive and negative 1 give same result (absolute value): 1/(1+1)
    expect(bm25RankToScore(1)).toBeCloseTo(0.5);
    expect(bm25RankToScore(-1)).toBeCloseTo(0.5);
  });

  it("is monotonically increasing with match strength (|rank|)", () => {
    // Stronger match (larger |rank|) = higher score, so it sorts best-first.
    expect(bm25RankToScore(10)).toBeGreaterThan(bm25RankToScore(1));
    expect(bm25RankToScore(100)).toBeGreaterThan(bm25RankToScore(10));
  });

  it("treats negative ranks same as positive (uses absolute value)", () => {
    // FTS5 BM25 ranks are negative, so -10 should give same score as 10
    expect(bm25RankToScore(-10)).toBeCloseTo(bm25RankToScore(10));
    expect(bm25RankToScore(-100)).toBeCloseTo(bm25RankToScore(100));
    // -100 → abs = 100 → score = 100/101 ≈ 0.9901
    expect(bm25RankToScore(-100)).toBeCloseTo(100 / 101);
  });

  it("handles infinity by returning 0", () => {
    expect(bm25RankToScore(Infinity)).toBe(0);
    expect(bm25RankToScore(-Infinity)).toBe(0);
  });

  it("handles NaN by returning 0", () => {
    expect(bm25RankToScore(NaN)).toBe(0);
  });
});

describe("mergeHybridResults", () => {
  it("unions by id and combines weighted scores", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.9,
        },
      ],
      keyword: [
        {
          id: "b",
          path: "memory/b.md",
          startLine: 3,
          endLine: 4,
          source: "memory",
          snippet: "kw-b",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(2);
    const a = merged.find((r) => r.path === "memory/a.md");
    const b = merged.find((r) => r.path === "memory/b.md");
    expect(a?.score).toBeCloseTo(0.7 * 0.9);
    expect(b?.score).toBeCloseTo(0.3 * 1.0);
  });

  it("prefers keyword snippet when ids overlap", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.5,
      textWeight: 0.5,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.2,
        },
      ],
      keyword: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 1.0,
        },
      ],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0]?.snippet).toBe("kw-a");
    expect(merged[0]?.score).toBeCloseTo(0.5 * 0.2 + 0.5 * 1.0);
  });

  it("sorts by score descending", () => {
    const merged = mergeHybridResults({
      vectorWeight: 1.0,
      textWeight: 0.0,
      vector: [
        {
          id: "low",
          path: "memory/low.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "low",
          vectorScore: 0.3,
        },
        {
          id: "high",
          path: "memory/high.md",
          startLine: 1,
          endLine: 1,
          source: "memory",
          snippet: "high",
          vectorScore: 0.9,
        },
      ],
      keyword: [],
    });

    expect(merged[0]?.path).toBe("memory/high.md");
    expect(merged[1]?.path).toBe("memory/low.md");
  });

  it("handles empty inputs", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [],
      keyword: [],
    });

    expect(merged).toHaveLength(0);
  });

  it("handles vector-only results with normalized weights", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "vec-a",
          vectorScore: 0.8,
        },
      ],
      keyword: [],
    });

    expect(merged).toHaveLength(1);
    // When keyword side is empty, vector weight normalizes to 1.0
    expect(merged[0]?.score).toBeCloseTo(0.8);
  });

  it("handles keyword-only results with normalized weights", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      vector: [],
      keyword: [
        {
          id: "a",
          path: "memory/a.md",
          startLine: 1,
          endLine: 2,
          source: "memory",
          snippet: "kw-a",
          textScore: 0.9,
        },
      ],
    });

    expect(merged).toHaveLength(1);
    // When vector side is empty, text weight normalizes to 1.0
    expect(merged[0]?.score).toBeCloseTo(0.9);
  });

  it("preserves all metadata fields", () => {
    const merged = mergeHybridResults({
      vectorWeight: 1.0,
      textWeight: 0.0,
      vector: [
        {
          id: "test",
          path: "memory/test.md",
          startLine: 5,
          endLine: 10,
          source: "sessions",
          snippet: "test snippet",
          vectorScore: 0.5,
        },
      ],
      keyword: [],
    });

    expect(merged[0]).toMatchObject({
      path: "memory/test.md",
      startLine: 5,
      endLine: 10,
      source: "sessions",
      snippet: "test snippet",
    });
  });
});

describe("mergeHybridResults — RRF fusion", () => {
  it("fuses by rank and ranks items in both lists highest", () => {
    const merged = mergeHybridResults({
      vectorWeight: 0.7,
      textWeight: 0.3,
      fusion: "rrf",
      vector: [
        { id: "a", path: "memory/a.md", startLine: 1, endLine: 1, source: "memory", snippet: "a", vectorScore: 0.9 },
        { id: "b", path: "memory/b.md", startLine: 1, endLine: 1, source: "memory", snippet: "b", vectorScore: 0.5 },
      ],
      keyword: [
        { id: "b", path: "memory/b.md", startLine: 1, endLine: 1, source: "memory", snippet: "b", textScore: 0.8 },
        { id: "c", path: "memory/c.md", startLine: 1, endLine: 1, source: "memory", snippet: "c", textScore: 0.4 },
      ],
    });

    // b appears in both lists -> highest; a (vec rank 0) > c (kw rank 1)
    expect(merged.map((r) => r.path)).toEqual(["memory/b.md", "memory/a.md", "memory/c.md"]);
    // scores are max-normalized: the top (in both lists) is 1.0, others below it
    const b = merged.find((r) => r.path === "memory/b.md");
    const a = merged.find((r) => r.path === "memory/a.md");
    const c = merged.find((r) => r.path === "memory/c.md");
    expect(b?.score).toBeCloseTo(1);
    expect(a!.score).toBeGreaterThan(c!.score);
    expect(c!.score).toBeGreaterThan(0);
  });

  it("ignores raw magnitudes — pure rank ordering", () => {
    const merged = mergeHybridResults({
      vectorWeight: 1,
      textWeight: 0,
      fusion: "rrf",
      vector: [
        { id: "first", path: "memory/first.md", startLine: 1, endLine: 1, source: "memory", snippet: "f", vectorScore: 0.501 },
        { id: "second", path: "memory/second.md", startLine: 1, endLine: 1, source: "memory", snippet: "s", vectorScore: 0.5 },
      ],
      keyword: [],
    });

    expect(merged.map((r) => r.path)).toEqual(["memory/first.md", "memory/second.md"]);
    // max-normalized: top is 1.0, the lower-ranked item is below it
    expect(merged[0]?.score).toBeCloseTo(1);
    expect(merged[1]!.score).toBeLessThan(merged[0]!.score);
  });

  it("respects custom rrfK", () => {
    const merged = mergeHybridResults({
      vectorWeight: 1,
      textWeight: 0,
      fusion: "rrf",
      rrfK: 0,
      vector: [
        { id: "a", path: "memory/a.md", startLine: 1, endLine: 1, source: "memory", snippet: "a", vectorScore: 0.3 },
      ],
      keyword: [],
    });

    expect(merged[0]?.score).toBeCloseTo(1); // 1 / (0 + 0 + 1)
  });
});
