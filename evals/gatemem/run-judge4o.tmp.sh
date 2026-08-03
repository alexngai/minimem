#!/bin/zsh
# Full judge-matched re-score against GateMem's reference judge (gpt-4o).
#
# Every GateMem number we have was judged with gpt-4.1; the benchmark's own configs
# (paper_main.yaml, paper_matrix.yaml) specify gpt-4o, and the published leaderboard was
# produced with it. A pilot on medical/officialfx showed the difference is NOT cosmetic and
# is concentrated exactly where our claims live:
#
#     U 79.5 -> 79.5   over-refusal 11.9 -> 11.9   (mechanical judgments: identical)
#     A  5.2 -> 11.5   F 1.1 -> 2.3   MGS 74.5 -> 68.8   (leak judgments: much stricter)
#
# So all comparisons to the leaderboard were judge-mismatched in our favour. Most at risk is
# the S1 rank-1 access-control claim (A = 7.0 vs RAG-Policy 12.2): if A roughly doubles, we
# fall behind it and the claim loses its headline evidence.
#
# Predictions are re-scored, NOT re-run. Output goes to gm4o-* so the gpt-4.1 results stay
# intact for the paired comparison. Ordered by how load-bearing each arm is, so the critical
# numbers land first if this is interrupted.
cd /Users/alexngai/GitHub/minimem
GM="${GATEMEM_ROOT:-$HOME/GitHub/gatemem}"
export GATEMEM_DUMMY_KEY="unused-by-proxy"
JUDGE="${GM_JUDGE_MODEL:-azure-openai-uswest3-gpt4o}"
[[ -f "$GM/bench/scripts/score_predictions.py" ]] || { echo "FATAL: no scorer at $GM" >&2; exit 1; }

score () {  # $1 = tag, $2 = domain
  local tag="$1" d="$2"
  local pred="evals/gatemem/results/${tag}-${d}.jsonl"
  [[ -f "$pred" ]] || { echo "  skip ${tag}-${d}: no predictions"; return; }
  rm -rf "/tmp/gm4o-${tag}-${d}"
  ( cd "$GM" && ./.venv/bin/python bench/scripts/score_predictions.py \
      --data_dir "bench/data/${d}" \
      --predictions "/Users/alexngai/GitHub/minimem/${pred}" \
      --out_dir "/tmp/gm4o-${tag}-${d}" \
      --use_llm_judge --judge_provider llama --judge_model "$JUDGE" \
      --judge_api_base http://127.0.0.1:8787 --judge_api_key_env GATEMEM_DUMMY_KEY \
      --judge_concurrency 4 ) > "/tmp/judge4o-${tag}-${d}.log" 2>&1
}

# Phase order = claim criticality.
PHASE1=(hybrid hybrid-r2 hybrid-r3 officialfx officialfx-r2 officialfx-r3)   # headlines + S1's A
PHASE2=(nodelguard nodelguard-r2 nodelguard-r3)                              # C4 answer-vs-e2e
PHASE3=(weak2 weak-r2 weak-r3 sol sol-r2 sol-r3)                             # C4b capability curve
PHASE4=(tomb tomb-ng del-ng precise)                                         # C3b 2x2
PHASE5=(stdsol stdweak)                                                      # prompt x backbone grid

for phase in 1 2 3 4 5; do
  eval "arms=(\${PHASE${phase}[@]})"
  echo "=== PHASE $phase: ${arms[@]} ==="
  for tag in $arms; do
    pids=()
    for d in medical office education household; do score "$tag" "$d" & pids+=($!); done
    wait $pids
    python3 - "$tag" <<'PY'
import json, os, sys
tag=sys.argv[1]; D=["medical","office","education","household"]
vals=[]
for d in D:
    p=f"/tmp/gm4o-{tag}-{d}/summary.json"
    if not os.path.exists(p): print(f"  {tag}: {d} FAILED"); continue
    s=json.load(open(p))
    exp={"medical":579,"office":547,"education":540,"household":552}[d]
    if s["n_checkpoints"]!=exp: print(f"  {tag}: {d} POLLUTED {s['n_checkpoints']}"); continue
    g=lambda k:(s[k]*100 if s[k] is not None and s[k]<=1 else s[k])
    vals.append((g("utility_accuracy"),g("privacy_leakage_rate"),
                 g("deletion_leakage_rate"),g("compliance_utility_score")))
if len(vals)==4:
    m=[sum(v[i] for v in vals)/4 for i in range(4)]
    print(f"  {tag:16} U {m[0]:5.1f}  A {m[1]:5.1f}  F {m[2]:5.1f}  MGS {m[3]:5.1f}")
PY
  done
done
echo "=== JUDGE-MATCHED RE-SCORE COMPLETE ==="
