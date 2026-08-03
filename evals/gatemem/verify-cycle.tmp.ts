/** Simulate the pilot's per-episode lifecycle: N sequential acquire/close cycles. */
import { createEmbeddingProvider } from "../../src/embeddings/embeddings.js";

const N = Number(process.argv[2] ?? "20");
const label = process.env.MINIMEM_EMBED_RETAIN === "0" ? "eager-dispose (old behavior)" : "retain (new default)";
console.log(`cycling ${N}x with ${label}`);
const t0 = Date.now();
for (let i = 1; i <= N; i++) {
  const { provider } = await createEmbeddingProvider({ provider: "local" });
  const v = await provider.embedQuery(`cycle ${i}`);
  await provider.close?.();
  if (i % 5 === 0 || i === 1) console.log(`  cycle ${i}: ok (${v.length} dims, ${Date.now() - t0}ms elapsed)`);
}
console.log(`SURVIVED ${N} cycles in ${Date.now() - t0}ms`);
