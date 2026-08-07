/**
 * Local-embedding concurrency tests (requires node-llama-cpp + the local model).
 *
 * Run with: npm run test:embeddings
 *
 * Not part of `test:all` because a cold machine would download the model (~320 MB).
 *
 * Each Minimem instance builds its own embedding provider, so these guard the sharing that
 * makes that safe: model weights are hundreds of megabytes and the ggml backend is
 * process-global, so loading per provider meant N copies on one shared backend plus N
 * racing `dispose()` calls at teardown — a native abort inside `ggml_metal_device_free`.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingProvider } from "../embeddings.js";

const local = { provider: "local" as const };

describe("local embedding provider sharing", () => {
  it("serves concurrent providers from one shared model", async () => {
    const providers = await Promise.all(
      Array.from({ length: 4 }, async () => (await createEmbeddingProvider(local)).provider),
    );
    try {
      const vectors = await Promise.all(
        providers.map((p, i) => p.embedQuery(`concurrent probe ${i}`)),
      );
      for (const vector of vectors) {
        assert.ok(vector.length > 0, "expected a non-empty embedding");
        assert.equal(vector.length, vectors[0].length, "all providers should share one model's dims");
      }
    } finally {
      await Promise.all(providers.map((p) => p.close?.()));
    }
  });

  it("keeps the shared model alive until the last holder closes", async () => {
    const a = (await createEmbeddingProvider(local)).provider;
    const b = (await createEmbeddingProvider(local)).provider;
    try {
      // Closing one holder must not dispose the model the other is still using — that is
      // exactly the use-after-dispose that aborted natively.
      await a.close?.();
      const vector = await b.embedQuery("still alive after sibling close");
      assert.ok(vector.length > 0);
    } finally {
      await b.close?.();
    }
  });

  it("reloads after every holder has released", async () => {
    const first = (await createEmbeddingProvider(local)).provider;
    const dims = (await first.embedQuery("before release")).length;
    await first.close?.();

    const second = (await createEmbeddingProvider(local)).provider;
    try {
      assert.equal((await second.embedQuery("after release")).length, dims);
    } finally {
      await second.close?.();
    }
  });

  it("rejects use after close", async () => {
    const provider = (await createEmbeddingProvider(local)).provider;
    await provider.close?.();
    await assert.rejects(() => provider.embedQuery("closed"), /closed/i);
  });

  it("handles concurrent batches over the shared context", async () => {
    const providers = await Promise.all(
      Array.from({ length: 3 }, async () => (await createEmbeddingProvider(local)).provider),
    );
    try {
      const batches = await Promise.all(
        providers.map((p) => p.embedBatch?.(["alpha", "beta", "gamma"])),
      );
      for (const batch of batches) {
        assert.equal(batch?.length, 3);
        for (const vector of batch ?? []) assert.ok(vector.length > 0);
      }
    } finally {
      await Promise.all(providers.map((p) => p.close?.()));
    }
  });
});
