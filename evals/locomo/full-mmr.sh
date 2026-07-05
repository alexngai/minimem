#!/usr/bin/env bash
# Full-ladder validation of the two decided levers:
#   1. cogcore-retrieval + MMR (raw-turn arm, where MMR helped +3 on the sample)
#   2. mem0 @ topK=16 (apples-to-apples with the topK=16 cogcore full ladder;
#      prior mem0 was topK=8)
# Both at topK=16, all answerable questions, all 10 conversations. Sequential
# (avoids concurrent cogcore/mem0 builds → OOM), resilient (retry + --resume),
# caffeinated. cogcore-memory is NOT rerun — MMR is off there by decision and the
# no-MMR full-ladder number (75.8%) already stands.
set -u

CONV=${CONV:-10}
Q=${Q:-0}
CONC=${CONC:-8}
TOPK=${TOPK:-16}
MMR_LAMBDA=${MMR_LAMBDA:-0.5}
MMR_POOL=${MMR_POOL:-50}
MAX_ATTEMPTS=${MAX_ATTEMPTS:-10}
OUT_DIR="evals/locomo/results"

run_arm() {
  local label="$1"; shift
  local out="$1"; shift
  for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
    echo "=== $label attempt $attempt $(date) ==="
    caffeinate -i -s -m npx tsx evals/locomo/run.ts \
      --conversations "$CONV" --questions "$Q" --concurrency "$CONC" --topk "$TOPK" \
      --resume --out "$out" "$@"
    code=$?
    if [ "$code" -eq 0 ]; then echo "=== DONE $label (exit 0) $(date) ==="; return 0; fi
    echo "=== $label attempt $attempt died (exit $code); resuming after backoff $(date) ==="
    sleep 5
  done
  echo "=== GAVE UP $label after $MAX_ATTEMPTS attempts $(date) ==="
}

echo "=== FULL-MMR START $(date) (topk=$TOPK mmr_lambda=$MMR_LAMBDA pool=$MMR_POOL) ==="
run_arm "cogcore-retrieval+mmr" "$OUT_DIR/full-cogcore-retrieval-mmr.json" \
  --systems cogcore-retrieval --embeddings local --mmr --mmr-lambda "$MMR_LAMBDA" --mmr-pool "$MMR_POOL"
run_arm "mem0-topk16" "$OUT_DIR/full-mem0-topk16.json" \
  --systems mem0
echo "=== FULL-MMR COMPLETE $(date) ==="
