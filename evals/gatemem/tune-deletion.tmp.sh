#!/bin/zsh
set -e
cd /Users/alexngai/GitHub/minimem
source ~/.zshrc 2>/dev/null || true
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export GATEMEM_DUMMY_KEY="unused-by-proxy"
GM="/private/tmp/claude-501/-Users-alexngai-GitHub-minimem/cb88acb3-b040-46fb-9e96-4caaa0b47d51/scratchpad/gatemem"
R=evals/gatemem/results

echo "=== arm B: tight threshold, no verify (top2 / 0.7) ==="
npx tsx evals/gatemem/run.ts --data-dir "$GM/bench/data/medical" --episodes 1 \
  --deletion-verify off --delete-top-k 2 --delete-min-score 0.7 \
  --out $R/tune-B.jsonl 2>&1 | grep -E "notes deleted|action mix"

echo "=== arm C: verify (top8 / 0.3 + verification) ==="
npx tsx evals/gatemem/run.ts --data-dir "$GM/bench/data/medical" --episodes 1 \
  --deletion-verify on --delete-top-k 8 --delete-min-score 0.3 \
  --out $R/tune-C.jsonl 2>&1 | grep -E "notes deleted|action mix"

for arm in B C; do
  echo "=== scoring arm $arm ==="
  (cd "$GM" && ./.venv/bin/python bench/scripts/score_predictions.py \
    --data_dir bench/data/medical \
    --predictions /Users/alexngai/GitHub/minimem/$R/tune-$arm.jsonl \
    --out_dir /tmp/gm-tune-$arm \
    --use_llm_judge --judge_provider llama --judge_model gpt-4.1 \
    --judge_api_base http://127.0.0.1:8787 --judge_api_key_env GATEMEM_DUMMY_KEY \
    --judge_concurrency 4 >/dev/null 2>&1)
done
echo "=== COMPARISON (1 episode, 28 ckpts) ==="
python3 - <<'PY'
import json
print(f'{"arm":34} {"U":>6} {"A":>6} {"F":>6} {"MGS":>7}')
print(f'{"A: top5/0.45 no-verify (known)":34} {60.0:6.1f} {11.1:6.1f} {11.1:6.1f} {47.4:7.1f}')
for arm, label in [("B","B: top2/0.70 no-verify"),("C","C: top8/0.30 + verify")]:
    try:
        s=json.load(open(f"/tmp/gm-tune-{arm}/summary.json"))
        print(f'{label:34} {100*s["utility_accuracy"]:6.1f} {100*s["privacy_leakage_rate"]:6.1f} {100*s["deletion_leakage_rate"]:6.1f} {100*s["compliance_utility_score"]:7.1f}')
    except Exception as e:
        print(f'{label:34} (failed: {e})')
PY
