#!/bin/zsh
# C1: does write-time compression trade exact recall for synthesis?
#
# LongMemEval splits cleanly into synthesis categories (multi-session, knowledge-update,
# temporal-reasoning) and recall categories (single-session-*), so it can test the converse
# that GateMem cannot -- GateMem grades exact recall only, which is why C1 was close to
# tautological there.
#
# Both arms use the SAME adapter, retrieval, prompt, answer model and judge. The only
# difference is the observation cache: derived statements vs one note per turn holding the
# raw text (493 vs 154 notes/instance, a 3.2:1 compression ratio).
#
# Live tools are OFF in both. The default is "auto", and leaving it on would have let live
# search paper over whatever the memory representation failed to supply -- the confound that
# made the pre-existing flat-vs-cogcore comparison uninterpretable.
cd /Users/alexngai/GitHub/minimem
source ~/.zshrc 2>/dev/null || true
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
N=${1:-200}
for arm in extracted verbatim; do
  if [[ $arm == verbatim ]]; then
    EXTRA=(--observation-cache-dir evals/longmemeval/.cache/verbatim-observations)
  else
    EXTRA=()
  fi
  echo "=== arm: $arm (n=$N, live-tools off) ==="
  npx tsx evals/longmemeval/run-flat.tmp.ts --n $N --live-tools off --graph-traverse off \
    --out evals/longmemeval/results/c1-$arm.json $EXTRA \
    > evals/longmemeval/results/c1-$arm.log 2>&1
  python3 -c "
import json
d=json.load(open('evals/longmemeval/results/c1-$arm.json'))
print(f'  n={d[\"n\"]} overall={d[\"overall\"]*100:.1f}%')
for k,v in sorted((d.get('byCategory') or {}).items()): print(f'    {k:28} {v}')
"
done
echo "=== C1 COMPLETE ==="
