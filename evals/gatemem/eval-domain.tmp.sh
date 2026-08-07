#!/bin/zsh
# Run minimem on one GateMem domain and score it with the official scorer.
#
#   eval-domain.tmp.sh <domain> <tag> [extra run.ts flags...]
#
# Writes predictions to results/<tag>-<domain>.jsonl and prints U/A/F/MGS.
set -e
cd /Users/alexngai/GitHub/minimem
source ~/.zshrc 2>/dev/null || true
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export GATEMEM_DUMMY_KEY="unused-by-proxy"

# Durable clone first. The session scratchpad under /private/tmp is subject to OS temp
# cleanup, which silently removed score_predictions.py, bench/eval/{scorer,metrics}.py and
# ALL of bench/data mid-session while the directory itself remained -- so a plain -d check
# on the scratchpad passes while the harness is unusable. Probe for the scorer, not the dir.
GM="${GATEMEM_ROOT:-$HOME/GitHub/gatemem}"
[[ -f "$GM/bench/scripts/score_predictions.py" ]] || \
  GM="/private/tmp/claude-501/-Users-alexngai-GitHub-minimem/cb88acb3-b040-46fb-9e96-4caaa0b47d51/scratchpad/gatemem"
[[ -f "$GM/bench/scripts/score_predictions.py" ]] || { echo "FATAL: no usable GateMem checkout" >&2; exit 1; }
DOMAIN="$1"; TAG="$2"; shift 2
R=evals/gatemem/results
PRED="$R/${TAG}-${DOMAIN}.jsonl"
OUTDIR="/tmp/gm-${TAG}-${DOMAIN}"

echo "=== [$TAG] $DOMAIN :: $* ==="
npx tsx evals/gatemem/run.ts --data-dir "$GM/bench/data/$DOMAIN" --out "$PRED" "$@" 2>&1 \
  | grep -viE "ExperimentalWarning|trace-warnings"

echo "=== scoring $DOMAIN ==="
(cd "$GM" && ./.venv/bin/python bench/scripts/score_predictions.py \
  --data_dir "bench/data/$DOMAIN" \
  --predictions "/Users/alexngai/GitHub/minimem/$PRED" \
  --out_dir "$OUTDIR" \
  --use_llm_judge --judge_provider llama --judge_model ${GM_JUDGE_MODEL:-gpt-4.1} \
  --judge_api_base http://127.0.0.1:8787 --judge_api_key_env GATEMEM_DUMMY_KEY \
  --judge_concurrency ${GM_JUDGE_CONC:-4} 2>&1 | tail -2)

SUMMARY="$OUTDIR/summary.json" DOMAIN="$DOMAIN" TAG="$TAG" GATEMEM_ROOT="$GM" \
  PRED="/Users/alexngai/GitHub/minimem/$PRED" python3 evals/gatemem/report.tmp.py
