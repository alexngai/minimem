# minimem × swarmkit-eval

Run minimem's BEIR retrieval evals through [**swarmkit-eval**](https://github.com/anthropics) — the
centralized eval infra — instead of the bespoke `evals/harness/`. minimem is the *client*: this directory
owns only the minimem-specific seams; the matrix, content-addressed store/resume, shared-resource
lifecycle, aggregation, and paired CIs come from the package (design §3c/§4d, decisions D6/D15).

## The mapping

| minimem concept | swarmkit-eval seam |
|---|---|
| corpus index (materialize + open, expensive) | a `ResourceSpec` — built once per arm (`scope: ['benchmark','arm']`), shared by every query-cell |
| a search config (bm25 / vector / hybrid-rrf …) | an **Arm** (the independent variable) |
| a query | a **cell** (`task.prompt` = query, `task.relevance` = qrels) |
| nDCG@k / Recall@k / MRR / Precision@k | the `{ kind: 'retrieval', k }` grader → `score.metrics` (per-arm CIs for free) |

`beir-swarmkit.ts` — `beirBenchmark(dataset, arms, k)` (the BenchmarkAdapter + corpus ResourceSpec) and
`minimemRetrievalAdapter(k)` (the search SUT that fills `RawRun.ranked`).

## Run

`swarmkit-eval` is not published yet, so link it from the sibling checkout (build its `dist` first):

```sh
( cd ../swarmkit/src/eval && npm run build )
ln -s ../../swarmkit/src/eval node_modules/swarmkit-eval   # from the minimem repo root
npx tsx evals/swarmkit/run-scifact.ts
```

`run-scifact.ts` is the acceptance test: it reproduces the native minimem result
(`evals/results/scifact-bm25.md`, `bm25-only-or`) **through swarmkit-eval** —

```
[beir/scifact bm25-only-or] queries=300 nDCG@10=0.656 Recall@10=0.780 MRR@10=0.624 Hit@10=0.800 ✅
```

— matching all four metrics exactly.
