#!/usr/bin/env bash
# MMR A/B (chained): waits for any in-flight keyword-expansion trace to finish
# (avoids concurrent cogcore builds → OOM), then runs the MMR-on variant on the
# same stratified sample. The control arm is kwab-baseline.json (identical sample:
# no keyword expansion, no MMR), so only the MMR-on run is needed here.
#
# Usage: source ~/.zshrc && bash evals/locomo/mmr-ab.sh
set -u

OUT="evals/locomo/results"
LAMBDA=${LAMBDA:-0.5}
POOL=${POOL:-50}
COMMON="--conversations ${CONV:-10} --questions ${Q:-10} --seed ${SEED:-1} --topk ${TOPK:-10} --systems cogcore-retrieval,cogcore-memory --embeddings local --concurrency ${CONC:-6}"

echo "=== MMR-AB waiting for keyword trace to finish $(date) ==="
while pgrep -f "trace.ts.*keyword-expansion" >/dev/null 2>&1; do sleep 30; done
echo "=== MMR-AB keyword trace done; starting MMR run (lambda=$LAMBDA pool=$POOL) $(date) ==="

caffeinate -i -s -m npx tsx evals/locomo/trace.ts $COMMON --mmr --mmr-lambda "$LAMBDA" --mmr-pool "$POOL" --out "$OUT/mmr-on"
echo "=== MMR-AB done (exit $?) $(date) ==="
