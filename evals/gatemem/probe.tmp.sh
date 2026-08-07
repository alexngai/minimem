#!/bin/zsh
set -e
cd /Users/alexngai/GitHub/minimem
CFG=(--episodes 2 --top-k 32 --neighbors 2 --delete-top-k 8)
for d in medical household; do
  zsh evals/gatemem/eval-domain.tmp.sh $d probe $CFG 2>&1 | grep -E "=== \[probe\]|^U=|action mix|^  (answer|refuse|no_memory)|privacy confusion|^  [a-z_]+ +-> "
done
