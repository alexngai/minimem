# Preserved judge verdicts

Per-checkpoint LLM-judge output for every scored GateMem arm, plus each run's `summary.json`.

**Why this is committed.** The GateMem checkout lived in the session scratchpad under
`/private/tmp`, and OS temp cleanup removed `bench/scripts/score_predictions.py`,
`bench/eval/{scorer,metrics}.py` and **all of `bench/data`** mid-session — while leaving the
directory in place, so a `-d` check still passed. 6 of 128 scored arms were already
unrecoverable by the time this was noticed. These files are the evidence behind the
attack-type analyses (the C3b 2×2, C4's answer-vs-e2e decomposition, C6's exposure
conditioning) and cannot be regenerated identically, since re-judging is not deterministic.

**Contents.** One directory per arm, named `gm-<tag>-<domain>`:
- `summary.json` — the aggregate the scorer reports
- `judge_scores.jsonl.gz` — per-checkpoint verdicts under `judge.{utility_ok, privacy_leak,
  deletion_leak}`, plus `attack_type` joins

**Reading them:** `zcat judge_scores.jsonl.gz`. Cross-check any derived statistic against
`summary.json` — deriving from `scores.jsonl` (rule-based) instead of the judge reads ~44pp
low on utility.

The predictions themselves (`../results/*.jsonl`, 810 MB) are **not** committed and exist in
one place only. Regenerating them costs a full run per arm.
