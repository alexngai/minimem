/** Verify the refactored minimem-graph uses the PRODUCT path (autoEntityLinks + graphExpand). */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MinimemGraphStore, type GraphObservation } from "../longmemeval/minimem-graph.js";

const inst = process.argv[2] ?? "1";
const obsPath = `evals/longmemeval/.cache/cogcore-observations/${inst}.combined.json`;
const observations: GraphObservation[] = JSON.parse(fs.readFileSync(obsPath, "utf8")).observations ?? [];
console.log(`[verify] instance ${inst}: ${observations.length} observations`);

const dir = path.resolve(`evals/beam/cache/minimem-graph-verify/${inst}`);
const store = await MinimemGraphStore.build(observations, {
  memoryDir: dir,
  instanceId: `beam_${inst}`,
  embedding: { provider: "local" },
  topK: 8,
  traverse: true,
});
console.log("[verify] store built (traverse=true → product autoEntityLinks)");

// 1) Did the PRODUCT's autoEntityLinks build co-entity edges at sync?
const dbPath = path.join(dir, ".minimem", "index.db");
const db = new DatabaseSync(dbPath, { readOnly: true });
const auto = db.prepare(`SELECT COUNT(*) n FROM knowledge_links WHERE source_path = 'auto:entity'`).get() as { n: number };
const rel = db.prepare(`SELECT relation, layer, COUNT(*) n FROM knowledge_links GROUP BY relation, layer`).all();
db.close();
console.log(`[verify] auto:entity edges = ${auto.n}  | link breakdown:`, JSON.stringify(rel));

// 2) graphExpand retrieval returns clean, expanded results.
const q = "What did the user say about deployment to the cloud?";
const hits = await store.retrieve(q, 5);
console.log(`\nQ: ${q}`);
for (const h of hits) console.log(`  [${h.score.toFixed(2)}] ${h.ref}: ${h.text.slice(0, 90).replace(/\n/g, " ")}`);

await store.close();
console.log(`\n[verify] ${auto.n > 0 ? "PASS: product autoEntityLinks fired + graphExpand retrieved" : "FAIL: no auto edges built"}`);
