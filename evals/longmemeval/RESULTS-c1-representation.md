# Memory representation: verbatim vs extracted (LongMemEval_S)

**At matched retrieval budget, write-time compression buys no quality — it buys cost.**

| | extract k16 | verbatim k16 | **verbatim k32** |
|---|--:|--:|--:|
| **recall** (n=98) | 85.7% | 98.0% | **99.0%** |
| **synthesis** (n=102) | **85.3%** | 79.4% | **85.3%** |
| overall | 85.5% | 88.5% | **92.0%** |

n=200, `gpt-5.5`, judge `gpt-4.1` (mem0-J, validated against the official rubric within 0
flips), live tools **off** in every arm. Recall = `single-session-*`; synthesis =
`multi-session`, `knowledge-update`, `temporal-reasoning`.

k=32 is **coverage-matched**: an extracted note cites ~2.0 source turns, so extraction at
k=16 reaches ~32 turns of conversation. It is also generous on tokens — an extracted note is
268.8 chars against verbatim's 1001.3, so verbatim at k=32 carries roughly **7× the context**.

## Per category

| category | extract k16 | verb k16 | verb k32 | type |
|---|--:|--:|--:|---|
| single-session-assistant | 61.8% | **100.0%** | **100.0%** | recall |
| single-session-user | 97.1% | 97.1% | 97.1% | recall |
| single-session-preference | 100.0% | 96.7% | 100.0% | recall |
| knowledge-update | 94.1% | 97.1% | 97.1% | synthesis |
| temporal-reasoning | 85.3% | 85.3% | 88.2% | synthesis |
| multi-session | **76.5%** | 55.9% | 70.6% | synthesis |

## What the control changed

At equal top-k, extraction appeared to win synthesis by +5.9 while losing recall by 12.2 —
read as a *trade*. **The budget control refutes that.** Giving verbatim extraction's turn
coverage recovers `multi-session` by **+14.7** (55.9 → 70.6) and erases the aggregate
synthesis gap entirely (85.3 vs 85.3, 87/102 both). The apparent trade was a retrieval-budget
artifact.

What survives is a **cost** difference: extraction reaches parity on synthesis at ~1/7 the
context tokens. Compression is a compression — it saves budget and, at equal budget, buys
nothing.

**This explains the GateMem result rather than contradicting it.** There, extracted memory
scored 24.4 against verbatim's 59.1 — but GateMem episodes are only 7–8K tokens, so nothing
is context-bound. Compression costs quality and saves nothing it needed to save. It predicts
extraction should pay where context genuinely binds (BEAM at 500K–1M), which is untested.

## Why this needed a control

Both pre-existing arms extract. `run-flat.tmp.ts` is "flat" in *retrieval structure*, and its
own docstring notes it reuses the cached observations — so reading flat-vs-cogcore as
"verbatim vs extracted" was wrong, and that comparison was additionally confounded by live
search tools.

The control writes a **verbatim cache in the same `ObservationCache` schema the adapter
already loads** — one note per turn holding raw text — so pointing the adapter at that
directory changes only what the notes contain. Retrieval, prompt, answer model and judge are
untouched. Verified rather than assumed: an empty cache dir takes 218s and writes a file
(re-extracts) against 54s for a cache hit.

## Threats

- **n=200, single run per arm.** No error bars.
- `multi-session` still favours extraction at matched coverage (70.6 vs 76.5). The aggregate
  synthesis tie is a sum of opposing category effects, not uniform parity.
- **Cost-matched comparison untested** — verbatim at k=32 spends ~7× the tokens. Equal-token
  is the setting where extraction should win, and it has not been run.
- This claim has been framed three times (bad-trade → trades-recall-for-synthesis →
  dominated-at-matched-budget). Treat the current form as provisional.

## Reproduce

```bash
npx tsx evals/longmemeval/make-verbatim-cache.tmp.ts
zsh evals/longmemeval/run-c1.tmp.sh 200          # extracted + verbatim at k=16
zsh evals/longmemeval/run-c1budget.tmp.sh        # verbatim at coverage-matched k=32
```
