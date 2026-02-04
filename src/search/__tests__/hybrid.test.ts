import { describe, expect, it } from "vitest";

import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "../hybrid.js";

describe("buildFtsQuery", () => {
  it("tokenizes and AND-joins", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" AND "world"');
    expect(buildFtsQuery("FOO_bar baz-1")).toBe('"FOO_bar" AND "baz" AND "1"');
  });

  it("returns null for empty/whitespace input", () => {
    expect(buildFtsQuery("   ")).toBeNull();
    expect(buildFtsQuery("")).toBeNull();
  });

  it("strips quotes from tokens", () => {
    expect(buildFtsQuery('hello "world')).toBe('"hello" AND "world"');
  });

  it("handles single token", () => {
    expect(buildFtsQuery("hello")).toBe('"hello"');
  });

  it("handles special characters", () => {
    expect(buildFtsQuery("hello@world.com")).toBe('"hello" AND "world" AND "com"');
  });
});

describe("bm25RankToScore", () => {
  it("returns 1 for rank 0", () => {
    expect(bm25RankToScore(0)).toBeCloseTo(1);
  });

  it("returns 0.5 for rank 1 or -1", () => {
    // Both positive and negative 1 give same result (absolute value)
    expect(bm25RankToScore(1)).toBeCloseTo(0.5);
    expect(bm25RankToScore(-1)).toBeCloseTo(0.5);
  });

  it("is monotonically decreasing with absolute value", () => {
    // Higher magnitude = lower score
    expect(bm25RankToScore(10)).toBeLessThan(bm25RankToScore(1));
    expect(bm25RankToScore(100)).toBeLessThan(bm25RankToScore(10));
  });

  it("treats negative ranks same as positive (uses absolute value)", () => {
    // FTS5 BM25 ranks are negative, so -10 should give same score as 10
    expect(bm25RankToScore(-10)).toBeCloseTo(bm25RankToScore(10));
    expect(bm25RankToScore(-100)).toBeCloseTo(bm25RankToScore(100));
    // -100 → abs = 100 → score = 1/101 ≈ 0.0099
    expect(bm25RankToScore(-100)).toBeCloseTo(1 / 101);
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

  it("handles vector-only results", () => {
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
    expect(merged[0]?.score).toBeCloseTo(0.7 * 0.8);
  });

  it("handles keyword-only results", () => {
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
    expect(merged[0]?.score).toBeCloseTo(0.3 * 0.9);
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
