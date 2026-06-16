# Retrieval eval harness (W3)

Materializes a BEIR corpus into a minimem memory directory, runs queries, and
aggregates chunk-level hits into document rankings for qrels-based scoring (W4).

See [`docs/RETRIEVAL-EVAL-P0.md`](../../docs/RETRIEVAL-EVAL-P0.md) §W3 for the design.

## Pieces

| File | Role |
|---|---|
| `materialize.ts` | corpus doc → `memory/<sanitized-id>.md`; returns id↔path maps |
| `run.ts` | `openIndex` (build + capability assert), `runQueries` (chunk→doc agg), `runDataset` (convenience) |
| `index.ts` | barrel export |

## Key behaviors

- **Capability assert** — `openIndex` hard-fails if FTS5 (always) or sqlite-vec
  (unless `provider: "none"`) is unavailable, so a degraded config never yields a
  silently-wrong number.
- **chunk → doc** — minimem returns chunk hits; BEIR qrels are doc-level. We
  over-fetch chunks (bounded by minimem's 200-candidate cap) and take the
  **max-chunk score per doc**.
- **`minScore: 0` + `watch: off`** — the harness sets both so the full ranking is
  returned and a 50k-file corpus doesn't spin up a watcher.
- **One index, many configs** — all P0 knobs (fusion / fts-mode / weights) are
  search-time, so the materialized corpus + built index are reused across configs;
  each config is a fresh `Minimem` over the same dir (embeddings are cached).

## Run the smoke test (offline, BM25-only)

```bash
npx tsx --test evals/harness/__tests__/harness.smoke.test.ts
```

Uses `node:test` (not vitest) because it exercises `node:sqlite` + `sqlite-vec`.

## Example (single config)

```ts
import { loadBeirDataset } from "../datasets/beir.js";
import { runDataset } from "./run.js";

const ds = await loadBeirDataset("scifact"); // network on first run
const { rankings } = await runDataset(ds, {
  embedding: { provider: "openai", model: "text-embedding-3-small" },
  hybrid: { fusion: "rrf", ftsQueryMode: "or" },
  k: 10,
});
// rankings: Map<queryId, { docId, score }[]>  -> feed to the W4 scorer
```
