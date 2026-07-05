#!/usr/bin/env bash
# Resilient finisher for the full ladder: runs each remaining arm with --resume,
# auto-restarting on death so an OOM/kill just continues from the last
# per-conversation checkpoint. minimem-alone is already complete.
#
# Usage: source ~/.zshrc && bash evals/locomo/run-remaining.sh
set -u

CONV=${CONV:-10}
Q=${Q:-0}
CONC=${CONC:-8}
TOPK=${TOPK:-16}
SYSTEMS=${SYSTEMS:-"cogcore-retrieval cogcore-memory mem0"}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-10}
OUT_DIR="evals/locomo/results"

echo "=== REMAINING RUN START $(date) (conv=$CONV q=$Q conc=$CONC topk=$TOPK) ==="
for sys in $SYSTEMS; do
  out="$OUT_DIR/full-$sys.json"
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    echo "=== $sys attempt $attempt $(date) ==="
    npx tsx evals/locomo/run.ts \
      --systems "$sys" \
      --conversations "$CONV" \
      --questions "$Q" \
      --concurrency "$CONC" \
      --topk "$TOPK" \
      --resume \
      --out "$out"
    code=$?
    if [ "$code" -eq 0 ]; then
      echo "=== DONE $sys (exit 0) $(date) ==="
      break
    fi
    echo "=== $sys attempt $attempt died (exit $code); resuming after backoff $(date) ==="
    sleep 5
  done
done
echo "=== REMAINING RUN COMPLETE $(date) ==="
