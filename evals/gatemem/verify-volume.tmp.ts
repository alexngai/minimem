/** Sustained embedding volume through one shared context — the pilot does ~4000+. */
import { createEmbeddingProvider } from "../../src/embeddings/embeddings.js";
const TOTAL = Number(process.argv[2] ?? "4000");
const { provider } = await createEmbeddingProvider({ provider: "local" });
const t0 = Date.now();
let done = 0;
try {
  for (let b = 0; b < TOTAL / 20; b++) {
    await provider.embedBatch?.(Array.from({ length: 20 }, (_, i) => `episode note ${b}-${i}: the patient reported symptoms and the clinician adjusted the medication schedule accordingly.`));
    done += 20;
    if (done % 1000 === 0) console.log(`  ${done} embeddings ok (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }
  console.log(`SURVIVED ${done} embeddings in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
} catch (e) {
  console.log(`FAILED after ${done} embeddings: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await provider.close?.();
}
