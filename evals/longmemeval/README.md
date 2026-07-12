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

## Arms (cognitive-core)

| arm | memory path |
|-----|-------------|
| `cogcore-memory` | extracted facts in cognitive-core KnowledgeBank |
| `cogcore-hybrid` | extracted facts plus raw turns in KnowledgeBank |
| `cogcore-hybrid-mq` | `cogcore-hybrid` plus multi-query retrieval |
| `cogcore-evolve` | `cogcore-hybrid` plus LLM memory evolution |
| `cogcore-system` | `cogcore-hybrid` plus session-level ExperienceMemory |
| `cogcore-system-evolve` | `cogcore-system` plus LLM memory evolution |
| `cogcore-live` | Atlas live-agent path with KnowledgeBank, ExperienceMemory, and minimem tools |

System arms keep KnowledgeBank as the primary context channel and reserve only
`min(4, floor(k/4))` final slots for ExperienceMemory, so session-level episodic
matches supplement rather than displace high-ranked fact/raw-turn evidence.

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

QA flags: `--per-category N` (stratified sample size per question type, default
10), `--sample N` (round-robin total question cap across categories),
`--categories a,b,c` (restrict the stratified sample to those question types),
`--category-offset N` (deterministic head-slice offset within each category),
`--no-abstain` (exclude abstention questions), `--retrieval-only` (skip
answer/judge and score whether retrieved context covers all gold evidence turn
ids), and `--details-out path.jsonl` (`run` metadata, per-question
answer/retrieval/evidence-coverage details, and per-arm cost summary). Add
`--debug-all` on diagnostic runs to include
question/gold/evidence-matching extracted facts and evolution actions even when
the answer is correct. Use `--record-retries N` to retry transient per-question
failures, and `--retry-errors-from path.jsonl` to rerun only questions that had
an `error` in a previous details file.
System-arm ExperienceMemory tuning flags: `--experience-granularity session|chunk|turn`,
`--experience-chunk-turns N`, `--experience-embedding none|hash`,
`--experience-scope knowledge-sessions|all`, `--experience-pool-size N`,
`--experience-slots N`, and `--experience-min-score X`.
Live-agent observation-memory flags: `--observation-memory off|kb` writes
Mastra-like distilled observation notes into KnowledgeBank when set to `kb`;
`--observation-source chunks|combined` selects whether observations are extracted
with the original second chunk pass (`chunks`) or alongside extracted facts in one
combined pass (`combined`); `--observation-context retrieved|log|both` selects
whether answer-time uses retrieved observation notes, a stable chronological
observation log injected into the agent context, or both; `--observation-log-max-chars N`
caps that injected log; `--observation-max-per-chunk N` caps write-time extraction, and
`--observation-slots N` caps how many observation notes can preempt normal
scoped KnowledgeBank notes at answer time.
`--live-tool-policy auto|always|off` controls live-agent minimem tool use during
answer synthesis. `auto` disables tools for log-context temporal questions,
where the injected observation log is usually less noisy than a second search
pass. `--live-tool-queries N` and `--live-tool-results N` tune the tool pass when
the selected policy enables tools.
Retrieval flags: `--ks a,b,c` (k-sweep, reuses built indexes).

For cognitive-core arms, run the staged funnel in
[`COGCORE-FUNNEL.md`](./COGCORE-FUNNEL.md): micro category smoke, targeted hard
set, then balanced decision set before full 500.

The current full live-agent launcher is:

```sh
source ~/.zshrc
evals/longmemeval/run-live-full-qa.sh
```

To recover transient Azure failures from a previous full run without rerunning
all 500 questions:

```sh
source ~/.zshrc
npx tsx evals/longmemeval/qa.ts --arms cogcore-live \
  --retry-errors-from evals/longmemeval/DETAILS-live-full-qa.jsonl \
  --record-retries 2 --k 16 --concurrency 4 --cogcore-concurrency 4 \
  --extract-concurrency 1 --experience-granularity chunk \
  --experience-embedding hash --experience-scope knowledge-sessions \
  --experience-pool-size 64 --live-tool-policy auto \
  --live-tool-queries 2 --live-tool-results 6 \
  --out evals/longmemeval/RESULTS-live-error-rerun.md \
  --details-out evals/longmemeval/DETAILS-live-error-rerun.jsonl
```

To A/B the observation-form KnowledgeBank layer on targeted hard cases:

```sh
source ~/.zshrc
npx tsx evals/longmemeval/qa.ts --arms cogcore-live \
  --question-ids gpt4_d84a3211,6e984301,71017277 \
  --observation-memory kb --observation-source combined --observation-context log \
  --observation-log-max-chars 80000 \
  --observation-max-per-chunk 12 --observation-slots 12 \
  --record-retries 2 --k 16 --concurrency 3 --cogcore-concurrency 3 \
  --extract-concurrency 1 --experience-granularity chunk \
  --experience-embedding hash --experience-scope knowledge-sessions \
  --experience-pool-size 64 --live-tool-policy auto \
  --live-tool-queries 2 --live-tool-results 6 \
  --out evals/longmemeval/RESULTS-live-observation-targeted.md \
  --details-out evals/longmemeval/DETAILS-live-observation-targeted.jsonl
```

## Results (LongMemEval_S, stratified sample)

Curated headline numbers; regenerate full per-category/per-run breakdowns via
the CLIs (raw `RESULTS-*.md` are gitignored).

Retrieval recall@k (n=100):

| arm            | k=5   | k=10  | k=20  |
|----------------|-------|-------|-------|
| `none` (BM25)  | 79.0% | 86.0% | 88.0% |
| `local` (hybrid)| 89.0% | 92.0% | 97.0% |

Hybrid's gains concentrate in the semantically-expressed categories where
lexical search is weakest (recall@5, local vs BM25): single-session-preference
+25pp, multi-session +19pp, temporal-reasoning +13pp; knowledge-update and
single-session-assistant are already saturated for BM25.

QA accuracy (full 500-question LongMemEval_S):

| arm             | k | accuracy | multi-session | preference | abstention |
|-----------------|---|----------|---------------|------------|------------|
| `none` (BM25)   | 10 | 76.2%    | 56%           | 57%        | 27/30 refused |
| `local` (hybrid)| 10 | 81.6%    | 68%           | 77%        | 27/30 refused |
| `cogcore-live`  | 16 | **88.4%**| **76.7%**     | **90.0%**  | 27/30 refused |

Paired McNemar: local fixed 46 BM25 misses and broke 19 BM25 hits,
**+5.4pp**, p=0.001. The run saw transient Azure HTTP 500s after retries
(2 BM25 records, 2 local records), so the absolute scores are slightly noisy;
the paired lift remains significant.

The `cogcore-live` score uses the Atlas live-agent path with KnowledgeBank,
chunk ExperienceMemory, and minimem tools. The initial full run scored 86.0%
with 13 transient Azure `fetch failed` errors; rerunning those errors with
`--retry-errors-from` produced 12/13 correct and no remaining runtime errors,
for a repaired full-run score of 442/500 (88.4%).

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
