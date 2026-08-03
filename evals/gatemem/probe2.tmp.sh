#!/bin/zsh
set -e
cd /Users/alexngai/GitHub/minimem
# 4 episodes each: utility checkpoints are evenly distributed, so this samples the
# over-refusal axis adequately even though it under-samples privacy.
for d in household medical; do
  zsh evals/gatemem/eval-domain.tmp.sh $d probe2 --episodes 4 --top-k 32 --neighbors 2
done
