#!/bin/zsh
# C4b replication: capability buys governance, not utility.
#
# Current evidence is n=1 for two of three backbones on the tuned config:
#   gpt-4.1      U 84.8  A 19.9  F 10.1  MGS 61.1   (n=1)
#   gpt-5.5      U 78.3  A  7.4  F  1.5  MGS 71.3   (n=3, already replicated)
#   gpt-5.6-sol  U 78.2  A ~7.0          MGS 72.0   (n=1)
#
# The claim rests on utility being flat-to-INVERTED across capability while A and F improve
# sharply. The inversion (+6.5 U for the weakest model) is the load-bearing part and is
# currently a single observation, so it gets error bars before anything is claimed.
#
# Note on builds: reps unavoidably span code changes (JSON sanitiser, tombstone refactor,
# guard flag). Those default to prior behaviour, and hybrid's own three reps spanned build
# changes with sd 1.22 -- so build variation is demonstrably inside noise. Stated rather
# than assumed.
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
  grep -h "CONFIG" "evals/gatemem/results/${tag}-medical.log" | head -1
  for d in medical office education household; do
    printf "  %-10s %s | failures %s\n" "$d" \
      "$(grep -E '^U=' "evals/gatemem/results/${tag}-${d}.log" | head -1)" \
      "$(grep -c 'answer call FAILED\|EPISODE FAILED' "evals/gatemem/results/${tag}-${d}.log")"
  done
}

run_arm weak-r2 --answer-deployment gpt-4.1
run_arm weak-r3 --answer-deployment gpt-4.1
run_arm sol-r2  --answer-deployment gpt-5.6-sol
run_arm sol-r3  --answer-deployment gpt-5.6-sol
echo "=== C4B REPLICATION COMPLETE ==="
