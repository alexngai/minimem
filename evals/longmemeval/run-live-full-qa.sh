#!/usr/bin/env zsh

cd /Users/alexngai/GitHub/minimem
echo "runner-bootstrap=$(date -Iseconds)"

echo "runner-start=$(date -Iseconds)"
echo "node=$(command -v node)"
echo "npx=$(command -v npx)"
echo "azure-base-len=${#AZURE_API_BASE}"

node node_modules/.bin/tsx evals/longmemeval/qa.ts \
  --arms cogcore-live \
  --per-category 999 \
  --k 16 \
  --concurrency 4 \
  --cogcore-concurrency 4 \
  --extract-concurrency 1 \
  --experience-granularity chunk \
  --experience-embedding hash \
  --experience-scope knowledge-sessions \
  --experience-pool-size 64 \
  --live-tool-queries 2 \
  --live-tool-results 6 \
  --out evals/longmemeval/RESULTS-live-full-qa.md \
  --details-out evals/longmemeval/DETAILS-live-full-qa.jsonl

status=$?
echo "runner-exit=$(date -Iseconds) status=$status"
exit "$status"
