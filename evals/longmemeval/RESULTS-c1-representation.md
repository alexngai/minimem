# Memory representation: verbatim vs extracted (LongMemEval_S)

**Compression trades recall for synthesis.** Neither representation dominates; which one
wins is decided by what the benchmark grades.

| | extracted | verbatim | |
|---|--:|--:|---|
| **recall** (n=98) | 85.7% | **98.0%** | verbatim **+12.2** |
| **synthesis** (n=102) | **85.3%** | 79.4% | extraction **+5.9** |
| overall | 85.5% | 88.5% | |

n=200, `gpt-5.5`, judge `gpt-4.1` (mem0-J, validated against the official rubric within 0
flips). Recall = `single-session-*`; synthesis = `multi-session`, `knowledge-update`,
`temporal-reasoning`.

## Per category

| category | extracted | verbatim | Δ | type |
|---|--:|--:|--:|---|
| single-session-assistant | 61.8% | **100.0%** | **+38.2** | recall |
| knowledge-update | 94.1% | 97.1% | +2.9 | synthesis |
| single-session-user | 97.1% | 97.1% | 0.0 | recall |
| temporal-reasoning | 85.3% | 85.3% | 0.0 | synthesis |
| single-session-preference | 100.0% | 96.7% | −3.3 | recall |
| multi-session | 76.5% | **55.9%** | **−20.6** | synthesis |

Two categories carry it, and both are mechanistically legible. `single-session-assistant`
asks what the *assistant* said; extraction paraphrases it into third-person statements and
the wording is gone. `multi-session` needs cross-session assembly; verbatim floods retrieval
with 493 notes/instance against 154 at the same top-k. The two dead-level categories confirm
this is not a global shift.

## Why this needed a control

Both pre-existing arms extract. `run-flat.tmp.ts` is "flat" in *retrieval structure* and its
own docstring notes it reuses the cached observations — so an earlier reading of
flat-vs-cogcore as "verbatim vs extracted" was wrong, and that comparison was additionally
confounded by live search tools.

The control avoids building a parallel pipeline (which would reintroduce confounds) by
writing a **verbatim cache in the same `ObservationCache` schema the adapter already loads**
— one note per turn holding raw text. Pointing the adapter at that directory changes only
what the notes contain; retrieval, prompt, answer model and judge are untouched.
`--live-tools off` in both arms, since the `auto` default would let live search compensate
for whatever the representation failed to supply.

Verified rather than assumed: an empty cache dir takes 218s and writes a file (re-extracts)
against 54s for a cache hit, so `--observation-cache-dir` is demonstrably honoured.

## Consequence

**This explains the GateMem extraction collapse rather than contradicting it.** There,
extracted memory scored 24.4 against verbatim's 59.1 — but GateMem grades exact recall
only, so it measures one side of a two-sided trade. Generalising from it would have reported
half a trade as a law.

## Threats

- n=200, single run, no error bars. The two large category deltas (+38.2, −20.6) are far
  outside plausible noise; the aggregate +5.9/−12.2 split is not replicated.
- The verbatim arm carries **3.2× more notes at the same top-k**, so part of its synthesis
  loss is retrieval *budget* rather than representation. A budget-matched arm would separate
  them. The category effects survive this; the exchange rate specifically does not.
- One benchmark, one judge.

## Reproduce

```bash
npx tsx evals/longmemeval/make-verbatim-cache.tmp.ts
zsh evals/longmemeval/run-c1.tmp.sh 200
```
