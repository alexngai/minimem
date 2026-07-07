# LongMemEval harness

A second, reproducible memory benchmark alongside `evals/locomo/`, built on
[`swarmkit-eval`](https://www.npmjs.com/package/swarmkit-eval)'s `memory-qa`
module (normalized loaders, evidence-labelled retrieval scoring, the mem0
J-judge, and paired McNemar stats). LongMemEval is less noisy than LoCoMo and a
stronger public headline.

## Dataset

Cleaned LongMemEval_S (~500 questions, ~48 sessions / ~494 turns per haystack,
6 question types, 30 abstention questions). Download once (277 MB):

```sh
mkdir -p evals/longmemeval/cache
curl -L "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json" \
  -o evals/longmemeval/cache/longmemeval_s.json
```

Verify the loader / print dataset shape:

```sh
npx tsx evals/longmemeval/dataset.ts
```

## Arms (retrieval backend)

| arm     | retrieval |
|---------|-----------|
| `none`  | BM25 full-text only (no embeddings, no external services) |
| `local` | minimem hybrid RRF, embeddinggemma-300M via node-llama-cpp |
| `nomic` | minimem hybrid RRF, Ollama `nomic-embed-text` (OpenAI-compatible) |

## Retrieval-only grader

Scores minimem's raw-turn retrieval against turn/session evidence labels
(recall@k / MRR). No LLM, no extraction — the floor the cogcore arms sit on.

```sh
npx tsx evals/longmemeval/retrieval.ts --arms none,local --sample 100 --ks 5,10,20 \
  --out evals/longmemeval/RESULTS-retrieval.md
```

## Full QA harness

ingest → retrieve top-k → GPT-5.5 answer → judge. Answerable questions use the
mem0 J-judge; abstention questions (`*_abs`) are scored on refusal. Index builds
are serialized (embedding-safe) and evicted right after retrieval; the LLM
answer+judge calls run concurrently up to `--concurrency`.

```sh
source ~/.zshrc   # Azure GPT-5.5 creds: AZURE_API_BASE / _KEY / _VERSION
npx tsx evals/longmemeval/qa.ts --arms none,local --per-category 10 --k 10 \
  --concurrency 4 --out evals/longmemeval/RESULTS-qa.md
```

Flags: `--per-category N` (stratified sample size per question type, default 10),
`--no-abstain` (exclude abstention questions), `--sample N` (retrieval runner
only — total instances), `--ks a,b,c` (k-sweep, reuses built indexes).

## Files

- `dataset.ts` — cached loader over `swarmkit-eval`'s `loadLongMemEval` + stratified sampler.
- `minimem-search.ts` — the adapter: `MemQADocument[]` → minimem index → `MemoryQASearchFn`; serialized builds, per-instance `evict()`.
- `retrieval.ts` — retrieval-only grader CLI.
- `qa.ts` — full QA harness CLI.

## Notes

- The retrieval grader scores turn/session ids, so it tests raw-turn retrieval
  only. Extracted cognitive-core notes carry note-ids (not turn-ids) and can't be
  scored against turn evidence — measuring extraction quality is the QA harness's job.
- The judge and answer model are the same family (GPT-5.5); treat judge accuracy
  as a lower bound and validate against a human-labelled sample (as in LoCoMo).
