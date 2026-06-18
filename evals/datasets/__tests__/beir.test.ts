/**
 * Tests for the BEIR dataset parser (offline — no network required).
 *
 * These tests exercise the pure parsing functions against a tiny committed
 * fixture under evals/datasets/__fixtures__/mini/.
 *
 * Run with:
 *   npx vitest run evals/datasets
 */

import { describe, it, expect } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseCorpus, parseQueries, parseQrels, parseBeirDir } from "../beir.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, "..", "__fixtures__", "mini");

describe("parseCorpus", () => {
  it("loads 3 documents from the mini fixture", async () => {
    const corpus = await parseCorpus(path.join(FIXTURE_DIR, "corpus.jsonl"));
    expect(corpus.size).toBe(3);
  });

  it("maps _id to title and text", async () => {
    const corpus = await parseCorpus(path.join(FIXTURE_DIR, "corpus.jsonl"));
    const doc = corpus.get("doc1");
    expect(doc).toBeDefined();
    expect(doc!.title).toBe("Neural networks for NLP");
    expect(doc!.text).toContain("transformer");
  });

  it("includes all expected doc ids", async () => {
    const corpus = await parseCorpus(path.join(FIXTURE_DIR, "corpus.jsonl"));
    expect(corpus.has("doc1")).toBe(true);
    expect(corpus.has("doc2")).toBe(true);
    expect(corpus.has("doc3")).toBe(true);
  });
});

describe("parseQueries", () => {
  it("loads 2 queries from the mini fixture", async () => {
    const queries = await parseQueries(path.join(FIXTURE_DIR, "queries.jsonl"));
    expect(queries.size).toBe(2);
  });

  it("maps query _id to text", async () => {
    const queries = await parseQueries(path.join(FIXTURE_DIR, "queries.jsonl"));
    expect(queries.get("q1")).toBe("How do transformers work in NLP?");
    expect(queries.get("q2")).toBe("What is BM25 used for?");
  });
});

describe("parseQrels", () => {
  it("loads qrels from the mini fixture (skips header)", async () => {
    const qrels = await parseQrels(path.join(FIXTURE_DIR, "qrels", "test.tsv"));
    // 2 unique query ids
    expect(qrels.size).toBe(2);
  });

  it("returns correct relevance scores for q1", async () => {
    const qrels = await parseQrels(path.join(FIXTURE_DIR, "qrels", "test.tsv"));
    const q1Rels = qrels.get("q1");
    expect(q1Rels).toBeDefined();
    expect(q1Rels!.get("doc1")).toBe(2);
    expect(q1Rels!.get("doc3")).toBe(1);
    // doc2 not relevant to q1
    expect(q1Rels!.has("doc2")).toBe(false);
  });

  it("returns correct relevance score for q2", async () => {
    const qrels = await parseQrels(path.join(FIXTURE_DIR, "qrels", "test.tsv"));
    const q2Rels = qrels.get("q2");
    expect(q2Rels).toBeDefined();
    expect(q2Rels!.get("doc2")).toBe(2);
  });
});

describe("parseBeirDir", () => {
  it("returns corpus, queries, and qrels together", async () => {
    const ds = await parseBeirDir(FIXTURE_DIR, "test");
    expect(ds.corpus.size).toBe(3);
    expect(ds.queries.size).toBe(2);
    expect(ds.qrels.size).toBe(2);
  });

  it("corpus entries have title and text fields", async () => {
    const ds = await parseBeirDir(FIXTURE_DIR, "test");
    for (const [, doc] of ds.corpus) {
      expect(typeof doc.title).toBe("string");
      expect(typeof doc.text).toBe("string");
    }
  });

  it("all qrel query ids exist in queries map", async () => {
    const ds = await parseBeirDir(FIXTURE_DIR, "test");
    for (const queryId of ds.qrels.keys()) {
      expect(ds.queries.has(queryId)).toBe(true);
    }
  });

  it("all qrel doc ids exist in corpus map", async () => {
    const ds = await parseBeirDir(FIXTURE_DIR, "test");
    for (const docMap of ds.qrels.values()) {
      for (const docId of docMap.keys()) {
        expect(ds.corpus.has(docId)).toBe(true);
      }
    }
  });

  it("known relevance lookup: q1→doc1 = 2", async () => {
    const ds = await parseBeirDir(FIXTURE_DIR, "test");
    expect(ds.qrels.get("q1")?.get("doc1")).toBe(2);
  });

  it("known relevance lookup: q1→doc3 = 1", async () => {
    const ds = await parseBeirDir(FIXTURE_DIR, "test");
    expect(ds.qrels.get("q1")?.get("doc3")).toBe(1);
  });

  it("known relevance lookup: q2→doc2 = 2", async () => {
    const ds = await parseBeirDir(FIXTURE_DIR, "test");
    expect(ds.qrels.get("q2")?.get("doc2")).toBe(2);
  });
});
