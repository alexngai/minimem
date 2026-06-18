# minimem × swarmkit-eval

minimem's BEIR retrieval evals run on [**swarmkit-eval**](https://github.com/alexngai/swarmkit/src/eval),
the centralized eval infra — this is minimem's **primary** eval path. The bespoke generic harness (config
matrix, IR metrics + bootstrap CIs, report rendering, regression gate) has been **retired**; `evals/harness/`
now holds only minimem's domain pieces (corpus materialization, the minimem index + `runQueries`, and the
Jaccard baseline ranker). The matrix, content-addressed store/resume, shared-resource lifecycle,
aggregation + paired CIs, reporting, and gating all come from the package (design §3c/§4d, D6/D15).

## The mapping

| minimem concept | swarmkit-eval seam |
|---|---|
| corpus index (materialize + open + run all queries, expensive) | a `ResourceSpec` — built once per arm (`scope: ['benchmark','arm']`), shared by every query-cell |
| a search config (bm25 / vector / hybrid-rrf / jaccard) | an **Arm** (the independent variable) |
| a query | a **cell** (`task.prompt` = query, `task.relevance` = qrels) |
| nDCG@k / Recall@k / MRR / Precision@k | the `{ kind: 'retrieval', k, ks }` grader → `score.metrics` (per-arm CIs + paired Δ-vs-jaccard for free) |
| regression baseline | `buildGateBaseline` / `checkGate` vs a committed `baselines/*.json` |

- `beir-swarmkit.ts` — `MINIMEM_CONFIGS` (the arms), `beirBenchmark()` (benchmark + per-arm ranking `ResourceSpec`), `rankingAdapter()`.
- `cli.ts` — the eval entrypoint (`npm run eval`): matrix → report → gate.
- `__tests__/gate.smoke.test.ts` — the offline BM25-only CI gate (`npm run eval:ci`).

## Run

`swarmkit-eval` is a published dependency (`npm install` pulls it in):

```sh
npm run eval -- --fixture evals/datasets/__fixtures__/mini --bm25-only   # offline, instant
npm run eval -- --dataset scifact --bm25-only --out scifact.md           # full BM25 matrix
npm run eval -- --dataset arguana --embedding local --base-url $TEI_URL --ks 1,5,10,20
```

Gating / CI:

```sh
npm run eval:ci                                                          # the offline gate smoke test
npm run eval -- --fixture … --bm25-only --gate evals/baselines/mini.json # gate an arbitrary run
npm run eval -- --fixture … --bm25-only --update-baseline evals/baselines/mini.json --as-of 2026-06-17
```

Results are content-addressed under `--store` (default `.eval-cache/swarmkit-<dataset>`), so re-running the
same command resumes — skipping already-scored query-cells across runs.

## Validated

- **Fixture (`mini`, BM25-only):** jaccard nDCG@10 0.975 · bm25-only-or 0.880 · bm25-only-and 0.000 — matches
  the retired harness's committed baseline exactly; the gate passes.
- **scifact `bm25-only-or`:** nDCG@10 0.656 / Recall@10 0.780 / MRR@10 0.624 / Hit@10 0.800 over 300 queries —
  reproduces the native minimem result through swarmkit-eval.

> Note: the per-arm index rebuilds each run (no `ResourceCache` persistence wired yet — D15c). BM25/Jaccard
> need no embeddings, so the free CI path is unaffected; vector runs re-embed until a cache is added.
