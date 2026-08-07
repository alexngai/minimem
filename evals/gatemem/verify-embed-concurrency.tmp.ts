/** Four concurrent local-embedding providers: N model loads + racing disposes used to abort. */
import { createEmbeddingProvider } from "../../src/embeddings/embeddings.js";

const N = 4;
const t0 = Date.now();
const results = await Promise.all(
  Array.from({ length: N }, async (_, i) => {
    const { provider } = await createEmbeddingProvider({ provider: "local" });
    const vec = await provider.embedQuery(`concurrent probe ${i}`);
    return { i, dims: vec.length, provider };
  }),
);
const loadMs = Date.now() - t0;
console.log(`acquired ${results.length} providers in ${loadMs}ms; dims=${results.map((r) => r.dims).join(",")}`);

// Concurrent batch work on the shared context.
const t1 = Date.now();
await Promise.all(results.map((r) => r.provider.embedBatch?.(["alpha", "beta", "gamma"])));
console.log(`concurrent embedBatch across ${N} providers: ${Date.now() - t1}ms`);

// Staggered close: releasing all but the last must NOT dispose the shared model.
await results[0].provider.close?.();
await results[1].provider.close?.();
const stillWorks = await results[2].provider.embedQuery("after two closes");
console.log(`after 2 closes, 3rd provider still embeds: ${stillWorks.length} dims`);

await results[2].provider.close?.();
await results[3].provider.close?.();
console.log("all closed cleanly");

// A fresh acquire after full release must reload without error.
const { provider: reacquired } = await createEmbeddingProvider({ provider: "local" });
const again = await reacquired.embedQuery("reacquire after full release");
await reacquired.close?.();
console.log(`reacquired after full release: ${again.length} dims`);
console.log("PASS");
