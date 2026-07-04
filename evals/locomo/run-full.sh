#!/usr/bin/env bash
# Full LOCOMO ladder: all 10 conversations, all questions, one output file per
# arm (so a crash in one arm never loses the others). Cheapest arms first for
# early signal; mem0 last because its ingest dominates wall-clock.
#
# Usage: source ~/.zshrc && bash evals/locomo/run-full.sh
set -u

CONV=${CONV:-10}
Q=${Q:-0}            # 0 = all questions (stratified sample disabled)
CONC=${CONC:-8}
TOPK=${TOPK:-16}     # recall diagnostic: 16 beats 8 across arms (see RESULTS.md)
SYSTEMS=${SYSTEMS:-"minimem-alone cogcore-retrieval cogcore-memory mem0"}
OUT_DIR="evals/locomo/results"
mkdir -p "$OUT_DIR"

echo "=== FULL RUN START $(date) (conv=$CONV questions=$Q concurrency=$CONC topk=$TOPK) ==="
for sys in $SYSTEMS; do
  echo "=== RUN $sys $(date) ==="
  npx tsx evals/locomo/run.ts \
    --systems "$sys" \
    --conversations "$CONV" \
    --questions "$Q" \
    --concurrency "$CONC" \
    --topk "$TOPK" \
    --out "$OUT_DIR/full-$sys.json"
  echo "=== DONE $sys (exit $?) $(date) ==="
done
echo "=== FULL RUN COMPLETE $(date) ==="
