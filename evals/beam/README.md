# BEAM harness

Runs a memory arm over [BEAM](https://github.com/mohammadtavakoli78/BEAM)
(*Beyond a Million Tokens*, ICLR 2026) — a less-saturated memory benchmark than
LongMemEval, testing 10 memory dimensions (abstention, contradiction resolution,
event ordering, information extraction, instruction following, knowledge update,
multi-session reasoning, preference following, summarization, temporal reasoning)
over 100K–10M-token conversations. Answers are scored against a per-question
**rubric** (list of criteria), not a single gold answer.

## Reusable infra (swarmkit-eval)

The loader and judge live in `swarmkit/src/eval` and are shared via the
`swarmkit-eval` package:

- `loadBeam(path)` → normalized `MemQAInstance[]` (one conversation per instance;
  message id = turn id; `category` = dimension; `rubric` carried per question).
- `beamJudgeQuestion(judge, rubric, response, {floor})` + `BEAM_JUDGE_PROMPT` +
  `BEAM_DIMENSIONS` — faithful to BEAM's `unified_llm_judge_base_prompt`
  (per-rubric-item, `int()`-floored for 9 of 10 dims; `<question>` intentionally
  left unsubstituted to match the reference).

> **Dependency note:** `loadBeam`/`beamJudgeQuestion` require **swarmkit-eval
> ≥ 0.1.0**. Until that version is published to npm, consume the local build via
> `npm link` (from `swarmkit/src/eval`: `npm run build && npm link`; from this
> repo: `npm link swarmkit-eval`). `package.json` still pins `^0.0.9`; publish
> swarmkit-eval and bump the dep to make a fresh `npm ci` reproducible.

## Dataset (download + convert once)

BEAM is parquet on HuggingFace (`Mohammadta/BEAM`, splits `100K`/`500K`/`1M`;
`10M` is `Mohammadta/BEAM-10M`). Convert to the normalized JSON `loadBeam` reads:

```sh
mkdir -p evals/beam/cache
python3 -m venv evals/beam/.venv && evals/beam/.venv/bin/pip install pyarrow
curl -sL "https://huggingface.co/api/datasets/Mohammadta/BEAM/parquet/default/100K/0.parquet" \
  -o evals/beam/cache/beam-100K.parquet
evals/beam/.venv/bin/python evals/beam/convert.py \
  evals/beam/cache/beam-100K.parquet evals/beam/cache/beam-100K.json
```

100K = 20 conversations, 400 questions (40 × 10 dimensions), ~286 messages/conv.

## Run

```sh
source ~/.zshrc   # Azure creds
npx tsx evals/beam/run.ts --data evals/beam/cache/beam-100K.json \
  --conversations 0 --answer-deployment gpt-5.5 --judge-deployment gpt-4.1 \
  --concurrency 4 --out evals/beam/results/beam-100K-cogcore-live.json
```

`--conversations N` limits to the first N (0 = all). The `cogcore-live` adapter
ingests each conversation and answers its probing questions; the BEAM rubric
judge scores each answer; per-dimension + overall (mean of dims) are reported.

## Caveats (not yet leaderboard-exact)

- **Judge model:** BEAM uses `gpt-4.1-mini`; this harness substitutes `gpt-4.1`
  (mini not deployed on our Azure) — a slightly stronger judge.
- **`event_ordering`:** scored rubric-based here; the reference uses a Kendall-tau
  (`tau_norm`) after LLM alignment. Flagged; the other 9 dimensions are faithful.
- Result files (`results/`), the dataset cache (`cache/`), and `.venv/` are
  git-ignored.

## Answer prompt (`--answer-prompt`)

`tuned` (default) uses a BEAM-tuned answer prompt: comprehensive + closed-book,
with LongMemEval-specific rules removed and an explicit contradiction-flagging
instruction added (the v15 "prefer the latest state" rule was resolving
contradictions the rubric wants flagged). `v15` uses the legacy `cogcore-live`
answer prompt (the LongMemEval one). Validated held-out (conv 15–20,
mean-of-3): tuned beats v15 by +4.4pp offline; confirmed live at +6.6pp.

## Results (100K, current system)

`cogcore-live` (gpt-5.5 answer, gpt-4.1 judge), 20 conv / 400 Q:

| answer prompt | overall | notable dims |
|---------------|---------|--------------|
| `v15` (legacy) | 62.4% | contradiction 29, instruction 59, extraction 69 |
| **`tuned`** (default) | **69.0%** | contradiction **54**, instruction **84**, extraction **86**, knowledge **71** |

tuned = **+6.6pp** overall (contradiction +25.6, instruction +25.0, extraction
+16.6, knowledge +10.0), with two regressions worth future work: summarization
−12.6 and multi_session −8.4 (both want whole-conversation context — a retrieval
lever, not a prompt one). Reference leaderboard @100K: Hindsight 73.4% (SOTA),
Honcho 63.0%, paper baselines ~32–36% — so tuned clears Honcho and sits ~4pp from
SOTA (not judge-matched: our gpt-4.1 vs their gpt-4.1-mini; the +6.6 *improvement*
is measured consistently).
