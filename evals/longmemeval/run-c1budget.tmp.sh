#!/bin/zsh
# C1 budget control + C4 replication, sequential (memory: four parallel domains already
# saturate once the embedding model is retained per process).
#
# C1: the stated reviewer objection -- "verbatim carries 3.2x more notes, so its synthesis
# loss is retrieval budget" -- is about the STORE, and is refuted by measurement at the
# prompt: an extracted note is 268.8 chars, a verbatim note 1001.3, so equal top-k already
# hands verbatim ~3.7x MORE context. The real asymmetry is coverage: an extracted note cites
# ~2.0 source turns, so k=16 covers ~32 turns vs verbatim's 16. Tokens and coverage cannot
# both be matched -- that IS the trade -- so this runs the setting generous to verbatim:
# k=32, matching extraction's coverage and giving it ~7x the tokens. If verbatim still loses
# multi-session there, no budget objection survives.
cd /Users/alexngai/GitHub/minimem
source ~/.zshrc 2>/dev/null || true
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
echo "=== C1: verbatim, coverage-matched top-k 32 (n=200, live tools off) ==="
npx tsx evals/longmemeval/run-flat.tmp.ts --n 200 --live-tools off --graph-traverse off \
  --top-k 32 --observation-cache-dir evals/longmemeval/.cache/verbatim-observations \
  --out evals/longmemeval/results/c1-verbatim-k32.json \
  > evals/longmemeval/results/c1-verbatim-k32.log 2>&1
python3 -c "
import json
d=json.load(open('evals/longmemeval/results/c1-verbatim-k32.json'))
print(f'  n={d[\"n\"]} overall={d[\"overall\"]*100:.1f}%')
for k,v in sorted((d.get('byCategory') or {}).items()): print(f'    {k:28} {v*100:5.1f}%')
"
# C4: the paper's headline claim (deleting nothing scores 77.8 answer / 0.0 e2e) is n=1.
export GM_JUDGE_CONC=3
CFG=(--top-k 32 --neighbors 2 --deletion off --reconstruct-guard on)
for rep in r2 r3; do
  pids=()
  for d in medical office education household; do
    rm -rf evals/gatemem/.work-nodelguard-$rep-$d
    zsh evals/gatemem/eval-domain.tmp.sh $d nodelguard-$rep $CFG \
      --work-dir evals/gatemem/.work-nodelguard-$rep-$d \
      > evals/gatemem/results/nodelguard-$rep-$d.log 2>&1 &
    pids+=($!); sleep 5
  done
  wait $pids
  echo "=== nodelguard-$rep complete ==="
  grep -h CONFIG evals/gatemem/results/nodelguard-$rep-medical.log | head -1
  for d in medical office education household; do
    printf "  %-10s %s | failures %s\n" "$d" \
      "$(grep -E '^U=' evals/gatemem/results/nodelguard-$rep-$d.log | head -1)" \
      "$(grep -c 'answer call FAILED\|EPISODE FAILED' evals/gatemem/results/nodelguard-$rep-$d.log)"
  done
done
echo "=== ALL COMPLETE ==="
