/**
 * StoreGraph integration tests (requires node:sqlite)
 *
 * Run with: npx tsx --test src/store/__tests__/store-graph.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { StoreGraph } from "../store-graph.js";
import type { StoreManifest } from "../manifest.js";

describe("StoreGraph", () => {
  let tmpDir: string;
  let storeADir: string;
  let storeBDir: string;
  let storeCDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-storegraph-test-"));
    storeADir = path.join(tmpDir, "store-a");
    storeBDir = path.join(tmpDir, "store-b");
    storeCDir = path.join(tmpDir, "store-c");

    // Create store directories with minimal structure
    for (const dir of [storeADir, storeBDir, storeCDir]) {
      await fs.mkdir(path.join(dir, ".minimem"), { recursive: true });
      await fs.writeFile(path.join(dir, "MEMORY.md"), `# Memory\n\nTest content for ${path.basename(dir)}\n`);
      await fs.writeFile(
        path.join(dir, ".minimem", "config.json"),
        JSON.stringify({ embedding: { provider: "none" } }),
      );
    }

    // Store C links to A and B
    await fs.writeFile(
      path.join(storeCDir, ".minimem", "links.json"),
      JSON.stringify({ links: ["store-a", "store-b"] }),
    );
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function createManifest(): StoreManifest {
    return {
      stores: {
        "store-a": { path: storeADir },
        "store-b": { path: storeBDir, remote: "git@example.com:store-b.git" },
        "store-c": { path: storeCDir },
      },
    };
  }

  function makeConfigFactory() {
    return async (memoryDir: string) => ({
      memoryDir,
      embedding: { provider: "none" as const },
      watch: { enabled: false },
    });
  }

  it("creates from manifest", () => {
    const manifest = createManifest();
    const graph = StoreGraph.fromManifest(manifest);
    assert.deepStrictEqual(
      Object.keys(graph.getManifest().stores).sort(),
      ["store-a", "store-b", "store-c"],
    );
  });

  it("resolves a store with its linked stores", async () => {
    const manifest = createManifest();
    const graph = StoreGraph.fromManifest(manifest, {
      configFactory: makeConfigFactory(),
    });

    try {
      const instances = await graph.resolve("store-c");
      assert.strictEqual(instances.length, 3);
      assert.strictEqual(instances[0].name, "store-c");
      assert.deepStrictEqual(
        instances.map((i) => i.name).sort(),
        ["store-a", "store-b", "store-c"],
      );
    } finally {
      await graph.close();
    }
  });

  it("resolves a store with no links as single instance", async () => {
    const manifest = createManifest();
    const graph = StoreGraph.fromManifest(manifest, {
      configFactory: makeConfigFactory(),
    });

    try {
      const instances = await graph.resolve("store-a");
      assert.strictEqual(instances.length, 1);
      assert.strictEqual(instances[0].name, "store-a");
    } finally {
      await graph.close();
    }
  });

  it("resolves by directory path", async () => {
    const manifest = createManifest();
    const graph = StoreGraph.fromManifest(manifest, {
      configFactory: makeConfigFactory(),
    });

    try {
      const instances = await graph.resolveByPath(storeCDir);
      assert.strictEqual(instances.length, 3);
      assert.strictEqual(instances[0].name, "store-c");
    } finally {
      await graph.close();
    }
  });

  it("resolves unknown directory as standalone", async () => {
    const unknownDir = path.join(tmpDir, "unknown");
    await fs.mkdir(path.join(unknownDir, ".minimem"), { recursive: true });
    await fs.writeFile(path.join(unknownDir, "MEMORY.md"), "# Memory\n");
    await fs.writeFile(
      path.join(unknownDir, ".minimem", "config.json"),
      JSON.stringify({ embedding: { provider: "none" } }),
    );

    const manifest = createManifest();
    const graph = StoreGraph.fromManifest(manifest, {
      configFactory: makeConfigFactory(),
    });

    try {
      const instances = await graph.resolveByPath(unknownDir);
      assert.strictEqual(instances.length, 1);
      assert.strictEqual(instances[0].memoryDir, unknownDir);
    } finally {
      await graph.close();
    }
  });

  it("throws for unknown store name", async () => {
    const manifest = createManifest();
    const graph = StoreGraph.fromManifest(manifest, {
      configFactory: makeConfigFactory(),
    });

    try {
      await assert.rejects(
        () => graph.resolve("nonexistent"),
        { message: /Store "nonexistent" not found/ },
      );
    } finally {
      await graph.close();
    }
  });

  it("skips unavailable linked stores gracefully", async () => {
    const manifest: StoreManifest = {
      stores: {
        "store-a": { path: storeADir },
        "store-b": { path: "/nonexistent/path" },
        "store-c": { path: storeCDir },
      },
    };

    const graph = StoreGraph.fromManifest(manifest, {
      configFactory: makeConfigFactory(),
    });

    try {
      const instances = await graph.resolve("store-c");
      const names = instances.map((i) => i.name);
      assert.ok(names.includes("store-c"));
      assert.ok(names.includes("store-a"));
      assert.ok(!names.includes("store-b"));
    } finally {
      await graph.close();
    }
  });

  it("lists stores with their info", async () => {
    const manifest = createManifest();
    const graph = StoreGraph.fromManifest(manifest);

    const stores = await graph.listStores();
    assert.strictEqual(stores.length, 3);

    const storeC = stores.find((s) => s.name === "store-c");
    assert.ok(storeC);
    assert.deepStrictEqual(storeC.links, ["store-a", "store-b"]);

    const storeA = stores.find((s) => s.name === "store-a");
    assert.ok(storeA);
    assert.deepStrictEqual(storeA.links, []);
  });

  it("caches resolved instances", async () => {
    const manifest = createManifest();
    let createCount = 0;
    const graph = StoreGraph.fromManifest(manifest, {
      configFactory: async (memoryDir) => {
        createCount++;
        return {
          memoryDir,
          embedding: { provider: "none" as const },
          watch: { enabled: false },
        };
      },
    });

    try {
      await graph.resolve("store-c");
      const firstCount = createCount;

      await graph.resolve("store-a");
      assert.strictEqual(createCount, firstCount);
    } finally {
      await graph.close();
    }
  });
});
