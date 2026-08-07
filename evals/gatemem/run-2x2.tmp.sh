#!/bin/zsh
# Completes the storage x constraint 2x2 for C3b.
#
#                      guard ON              guard OFF
#   delete       hybrid   0.81% (n=3)     del-ng   <- this run
#   tombstone    tomb     0.00%           tomb-ng  <- this run
#
# The two guard-ON cells already exist. The existing no-guard number (precise, 5.95%) came
# from an older build, so del-ng re-runs it on current code: that way all four cells are
# matched on everything except the two variables being crossed.
#
# The decisive cell is tomb-ng. If tombstoning alone lands near zero, the deletion MARKER
# is the mechanism -- telling the model a record was deleted beats deleting it, because
# erasure destroys the evidence that erasure happened. If it leaks like del-ng, the guard
# does all the work and the storage choice is irrelevant.
#
# Sequential: four domains in parallel already saturates memory with the model retained.
cd /Users/alexngai/GitHub/minimem
export GM_JUDGE_CONC=3
BASE=(--top-k 32 --neighbors 2
      --literal-max-share 0.10 --delete-top-k 3 --delete-min-score 0.60 --deletion-verify on)

run_arm () {
  local tag="$1"; shift
  local pids=()
  for d in medical office education household; do
    rm -rf "evals/gatemem/.work-${tag}-${d}"
    zsh evals/gatemem/eval-domain.tmp.sh "$d" "$tag" $BASE "$@" \
      --work-dir "evals/gatemem/.work-${tag}-${d}" \
      > "evals/gatemem/results/${tag}-${d}.log" 2>&1 &
    pids+=($!); sleep 5
  done
  wait $pids
  echo "=== $tag complete ==="
  # Echo the config banner back so an inert flag is visible in the summary, not just the log.
  grep -h "CONFIG" "evals/gatemem/results/${tag}-medical.log" | head -1
  for d in medical office education household; do
    printf "  %-10s %s | failures %s\n" "$d" \
      "$(grep -E '^U=' "evals/gatemem/results/${tag}-${d}.log" | head -1)" \
      "$(grep -c 'answer call FAILED\|EPISODE FAILED' "evals/gatemem/results/${tag}-${d}.log")"
  done
}

run_arm tomb-ng --deletion tombstone --reconstruct-guard off
run_arm del-ng  --reconstruct-guard off
echo "=== 2x2 COMPLETE ==="
