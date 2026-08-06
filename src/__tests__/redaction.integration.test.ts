/**
 * End-to-end redaction tests against a real Minimem instance.
 *
 * These exist because the unit tests cannot catch the failure that matters. The previous
 * soft-delete attempt passed everything asked of it and still leaked: it marked notes instead
 * of removing text, and the content reached 99.7% of retrieved contexts while the headline
 * metric read a healthy 71.6. The assertions below are therefore byte-level — the redacted
 * literal must appear in *zero* bytes of what every content-returning path hands back.
 *
 *   npm run test:integration
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert";

import { Minimem } from "../minimem.js";
import { createMockFetch } from "./helpers.js";

const SECRET = "ALPHA-7749";

describe("Redaction E2E", () => {
  let tempDir: string;
  let minimem: Minimem;
  let originalFetch: typeof fetch;

  before(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-redact-"));
    await fs.mkdir(path.join(tempDir, "memory"));

    await fs.writeFile(
      path.join(tempDir, "MEMORY.md"),
      `# Memory\n\n- Project alpha is the main focus\n`,
    );

    // A note where the secret sits next to facts that must survive: this is the whole point
    // of field-level redaction over deleting the note.
    await fs.writeFile(
      path.join(tempDir, "memory", "access.md"),
      `# Access

## Building
- The badge code is ${SECRET} for the west entrance.
- The review meeting is scheduled for May 13.
- Dana is the facilities contact.
`,
    );

    await fs.writeFile(
      path.join(tempDir, "memory", "other.md"),
      `# Other\n\n- Quarterly planning happens in March.\n`,
    );

    // Enough notes that the share-based guard is meaningful: with only a handful, every rule
    // trips a percentage threshold and the guard would test nothing.
    for (let i = 0; i < 6; i++) {
      await fs.writeFile(
        path.join(tempDir, "memory", `filler-${i}.md`),
        `# Filler ${i}\n\n- The team reviewed item ${i}.\n`,
      );
    }

    originalFetch = globalThis.fetch;
    globalThis.fetch = createMockFetch() as unknown as typeof fetch;
    process.env.OPENAI_API_KEY = "test-api-key-for-integration-tests";

    minimem = await Minimem.create({
      memoryDir: tempDir,
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      watch: { enabled: false },
      hybrid: { enabled: true },
      query: { minScore: 0.0 },
    });
    await minimem.sync();
  });

  after(async () => {
    minimem?.close();
    globalThis.fetch = originalFetch;
    delete process.env.OPENAI_API_KEY;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns the secret before any redaction is recorded", async () => {
    const results = await minimem.search("badge code west entrance", { maxResults: 5 });
    assert.ok(
      results.some((r) => r.snippet.includes(SECRET)),
      "precondition failed: the secret must be retrievable before redaction, otherwise a " +
        "later pass would look like a success for the wrong reason",
    );
  });

  it("dryRun reports the plan without recording anything", async () => {
    const plan = await minimem.redact({ match: SECRET, dryRun: true });
    assert.equal(plan.applied, false);
    assert.deepEqual(plan.matchedPaths, [path.join("memory", "access.md")]);
    assert.equal(plan.totalNotes, 9);
    assert.equal(minimem.listRedactions().length, 0);

    const results = await minimem.search("badge code west entrance", { maxResults: 5 });
    assert.ok(
      results.some((r) => r.snippet.includes(SECRET)),
      "dryRun must not change what search returns",
    );
  });

  it("refuses a rule whose blast radius exceeds the limit", async () => {
    // "the" appears in every note; this is the shape of the defect that cost ~16 points of
    // utility per domain before a share limit existed.
    await assert.rejects(
      () => minimem.redact({ match: "the" }),
      /blast-radius/,
      "an over-broad pattern must fail loudly, not quietly redact the store",
    );
    assert.equal(minimem.listRedactions().length, 0);
  });

  it("removes the fact from search results while keeping its neighbours", async () => {
    const plan = await minimem.redact({ match: SECRET, reason: "deletion request" });
    assert.equal(plan.applied, true);

    const results = await minimem.search("badge code west entrance", { maxResults: 10 });
    const all = JSON.stringify(results);
    assert.ok(!all.includes(SECRET), "the secret must not appear in any returned byte");

    const neighbours = await minimem.search("review meeting May", { maxResults: 10 });
    assert.ok(
      JSON.stringify(neighbours).includes("May 13"),
      "co-located facts must survive — deleting them is the failure being fixed",
    );
  });

  it("removes the fact from readFile", async () => {
    const content = await minimem.readFile(path.join("memory", "access.md"));
    assert.ok(content !== null);
    assert.ok(!content.includes(SECRET), "readFile must not return the redacted fact");
    assert.ok(content.includes("Dana"), "unrelated content must survive");
  });

  it("removes the fact from readLines without shifting line numbers", async () => {
    // memory_get_details slices by the line numbers search reported, so the region must still
    // line up after redaction.
    const raw = await fs.readFile(path.join(tempDir, "memory", "access.md"), "utf-8");
    const secretLine = raw.split("\n").findIndex((l) => l.includes(SECRET)) + 1;

    const slice = await minimem.readLines(path.join("memory", "access.md"), {
      from: secretLine,
      lines: 2,
    });
    assert.ok(slice !== null);
    assert.equal(slice.startLine, secretLine);
    assert.ok(!slice.content.includes(SECRET));
    assert.ok(slice.content.includes("May 13"), "the adjacent line must still be in range");
  });

  it("survives a re-sync, unlike an index-only redaction", async () => {
    // The reason rules live in a file: memory files are the source of truth, so anything
    // applied only to the derived index is undone the next time the file is re-read.
    await minimem.sync({ force: true });
    const results = await minimem.search("badge code west entrance", { maxResults: 10 });
    assert.ok(!JSON.stringify(results).includes(SECRET), "redaction must survive re-indexing");
  });

  it("picks up a manifest edited on disk", async () => {
    await fs.appendFile(
      path.join(tempDir, ".redactions.jsonl"),
      `${JSON.stringify({ match: "Quarterly planning", kind: "literal", granularity: "block" })}\n`,
      "utf-8",
    );
    const results = await minimem.search("quarterly planning March", { maxResults: 10 });
    assert.ok(!JSON.stringify(results).includes("Quarterly planning"));
  });

  describe("scope", () => {
    // A store-scoped rule keeps firing on notes written LATER. That is right for "never
    // surface this string again" and wrong for "forget what these records said" -- and it
    // cost one benchmark domain 9.4 points of utility, because a literal that is not unique
    // to the sensitive fact shreds later legitimate records too.
    it("store-scoped rules redact notes written after the rule", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-scope-store-"));
      await fs.mkdir(path.join(dir, "memory"));
      await fs.writeFile(path.join(dir, "MEMORY.md"), "# M\n");
      await fs.writeFile(path.join(dir, "memory", "a.md"), "- The rate is 2600 USD.\n");
      const mm = await Minimem.create({
        memoryDir: dir,
        embedding: { provider: "openai", model: "text-embedding-3-small" },
        watch: { enabled: false },
        query: { minScore: 0.0 },
      });
      try {
        await mm.redact({ match: "2600", minNotes: 100 });
        await fs.writeFile(path.join(dir, "memory", "later.md"), "- Unrelated: 2600 attendees.\n");
        const after = await mm.readFile(path.join("memory", "later.md"));
        assert.ok(!after?.includes("2600"), "store scope should reach the later note");
      } finally {
        mm.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    it("matched-scoped rules leave later notes alone", async () => {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-scope-matched-"));
      await fs.mkdir(path.join(dir, "memory"));
      await fs.writeFile(path.join(dir, "MEMORY.md"), "# M\n");
      await fs.writeFile(path.join(dir, "memory", "a.md"), "- The rate is 2600 USD.\n");
      const mm = await Minimem.create({
        memoryDir: dir,
        embedding: { provider: "openai", model: "text-embedding-3-small" },
        watch: { enabled: false },
        query: { minScore: 0.0 },
      });
      try {
        const plan = await mm.redact({ match: "2600", scope: "matched", minNotes: 100 });
        assert.equal(plan.applied, true);
        assert.deepEqual(plan.rule.paths, [path.join("memory", "a.md")]);

        const original = await mm.readFile(path.join("memory", "a.md"));
        assert.ok(!original?.includes("2600"), "the matched note is still redacted");

        await fs.writeFile(path.join(dir, "memory", "later.md"), "- Unrelated: 2600 attendees.\n");
        const after = await mm.readFile(path.join("memory", "later.md"));
        assert.ok(after?.includes("2600"), "a note written later must be untouched");
      } finally {
        mm.close();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });

    // normalizeRule drops an empty `paths`, which would silently widen a matched-scope rule
    // to the whole store -- the exact opposite of what was asked for.
    it("a matched-scope rule that matches nothing is not recorded", async () => {
      const before = minimem.listRedactions().length;
      const plan = await minimem.redact({ match: "no-such-string-anywhere", scope: "matched" });
      assert.equal(plan.applied, false);
      assert.equal(minimem.listRedactions().length, before);
    });
  });

  it("can be switched off for ablation", async () => {
    const off = await Minimem.create({
      memoryDir: tempDir,
      embedding: { provider: "openai", model: "text-embedding-3-small" },
      watch: { enabled: false },
      hybrid: { enabled: true },
      query: { minScore: 0.0 },
      retrieval: { redaction: false },
    });
    try {
      const content = await off.readFile(path.join("memory", "access.md"));
      assert.ok(content?.includes(SECRET), "redaction: false must restore the raw content");
    } finally {
      off.close();
    }
  });
});
