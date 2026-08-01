#!/bin/zsh
# Replication of the two headline configs. Every number in RESULTS.md is currently n=1
# against a measured ~3-point noise floor (office, same config, 3 runs: 62.7/60.1/60.5),
# so "1st of 43" is a tie rather than a win. This adds two further reps of each headline.
#
# Sequential by design: four domains in parallel already saturates memory once the
# embedding model is retained per process (~320 MB each), and a second concurrent batch
# risks paging out a live run. Wall clock ~6h; nothing here needs supervision.
#
# Order puts the leaderboard-comparable config first, since that is the number we would
# publish and therefore the one that most needs an error bar.
cd /Users/alexngai/GitHub/minimem
export GM_JUDGE_CONC=3
BASE=(--top-k 32 --neighbors 2
      --literal-max-share 0.10 --delete-top-k 3 --delete-min-score 0.60 --deletion-verify on)

run_arm () {  # $1 = tag, rest = extra flags
  local tag="$1"; shift
  local pids=()
  for d in medical office education household; do
    rm -rf "evals/gatemem/.work-${tag}-${d}"
    zsh evals/gatemem/eval-domain.tmp.sh "$d" "$tag" $BASE "$@" \
      --work-dir "evals/gatemem/.work-${tag}-${d}" \
      > "evals/gatemem/results/${tag}-${d}.log" 2>&1 &
    pids+=($!)
    sleep 5
  done
  wait $pids
  echo "=== $tag complete ==="
  for d in medical office education household; do
    local f="evals/gatemem/results/${tag}-${d}.log"
    printf "  %-10s %s | failures %s\n" "$d" \
      "$(grep -E '^U=' "$f" | head -1)" \
      "$(grep -c 'answer call FAILED\|EPISODE FAILED' "$f")"
  done
}

run_arm officialfx-r2 --prompt official
run_arm officialfx-r3 --prompt official
run_arm hybrid-r2
run_arm hybrid-r3
echo "=== ALL REPLICATION ARMS COMPLETE ==="
