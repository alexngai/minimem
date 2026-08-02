#!/bin/zsh
# C4 stage 1: does deletion buy anything once a behavioural constraint exists?
#
# C4's original evidence -- deletion spending 17.8 U to buy 9.4 F, scoring below no-deletion
# -- predates the no-reconstruct guard. C3b then showed the guard dominates F by ~20x, and
# with it on F is already 1.52%. So the premise "deletion buys forgetting" may no longer
# hold, and this is the one cell never run:
#
#                      guard ON      guard OFF
#   delete               1.52% F        6.09% F
#   tombstone            0.14% F        8.57% F
#   deletion OFF        <- THIS            (21.7% F, education only, no guard)
#
# If F stays near 1.5% with deletion entirely off, deletion is pure utility cost and C4
# inverts from "there is an optimum" to "deletion buys nothing given a constraint".
#
# Read the attack-type breakdown, not just aggregate F: our deletion also removes STALE
# content, so turning it off may raise F through supersession (update_delete_conflict, our
# largest residual at 4.8%) rather than through recovery. Those mean different things.
cd /Users/alexngai/GitHub/minimem
export GM_JUDGE_CONC=3
CFG=(--top-k 32 --neighbors 2 --deletion off --reconstruct-guard on)
pids=()
for d in medical office education household; do
  rm -rf evals/gatemem/.work-nodelguard-$d
  zsh evals/gatemem/eval-domain.tmp.sh $d nodelguard $CFG \
    --work-dir evals/gatemem/.work-nodelguard-$d \
    > evals/gatemem/results/nodelguard-$d.log 2>&1 &
  pids+=($!); sleep 5
done
wait $pids
echo "=== C4 STAGE 1 COMPLETE ==="
grep -h CONFIG evals/gatemem/results/nodelguard-medical.log | head -1
for d in medical office education household; do
  printf "  %-10s %s | failures %s\n" "$d" \
    "$(grep -E '^U=' evals/gatemem/results/nodelguard-$d.log | head -1)" \
    "$(grep -c 'answer call FAILED\|EPISODE FAILED' evals/gatemem/results/nodelguard-$d.log)"
done
