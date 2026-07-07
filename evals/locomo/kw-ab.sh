#!/usr/bin/env bash
# Keyword-expansion A/B: same stratified cross-conversation sample, retrieval with
# and without query distillation (KeywordExpandingSearchProvider). Compares QA
# accuracy for both cogcore arms at the k=10 convention.
#
# Usage: source ~/.zshrc && bash evals/locomo/kw-ab.sh
set -u

OUT="evals/locomo/results"
COMMON="--conversations ${CONV:-10} --questions ${Q:-10} --seed ${SEED:-1} --topk ${TOPK:-10} --systems cogcore-retrieval,cogcore-memory --embeddings local --concurrency ${CONC:-6}"

echo "=== KW-AB baseline (no expansion) $(date) ==="
npx tsx evals/locomo/trace.ts $COMMON --out "$OUT/kwab-baseline"
echo "=== KW-AB baseline done (exit $?) $(date) ==="

echo "=== KW-AB keyword-expansion $(date) ==="
npx tsx evals/locomo/trace.ts $COMMON --keyword-expansion --out "$OUT/kwab-keyword"
echo "=== KW-AB keyword done (exit $?) $(date) ==="
echo "=== KW-AB COMPLETE $(date) ==="
