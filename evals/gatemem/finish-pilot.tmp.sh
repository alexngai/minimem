#!/bin/zsh
set -e
cd /Users/alexngai/GitHub/minimem
source ~/.zshrc 2>/dev/null || true
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
export GATEMEM_DUMMY_KEY="unused-by-proxy"
GM="/private/tmp/claude-501/-Users-alexngai-GitHub-minimem/cb88acb3-b040-46fb-9e96-4caaa0b47d51/scratchpad/gatemem"
R=evals/gatemem/results

echo "=== running the 6 previously-failed episodes (016-021) ==="
npx tsx evals/gatemem/run.ts --data-dir "$GM/bench/data/medical" \
  --episode-start 15 --episodes 6 --out $R/pilot-medical-ep16to21.jsonl 2>&1 \
  | grep -viE "ExperimentalWarning|trace-warnings"

echo "=== merging into the full 579 ==="
cat $R/pilot-medical-ep1to15.jsonl $R/pilot-medical-ep16to21.jsonl > $R/pilot-medical-full.jsonl
wc -l < $R/pilot-medical-full.jsonl | xargs echo "  total predictions:"

echo "=== scoring full medical domain with the official scorer ==="
(cd "$GM" && ./.venv/bin/python bench/scripts/score_predictions.py \
  --data_dir bench/data/medical \
  --predictions /Users/alexngai/GitHub/minimem/$R/pilot-medical-full.jsonl \
  --out_dir /tmp/gm-pilot-full \
  --use_llm_judge --judge_provider llama --judge_model gpt-4.1 \
  --judge_api_base http://127.0.0.1:8787 --judge_api_key_env GATEMEM_DUMMY_KEY \
  --judge_concurrency 6 2>&1 | tail -2)

echo "=== RESULT vs medical leaderboard ==="
GATEMEM_ROOT="$GM" python3 - <<'PY'
import json, os
root = os.environ["GATEMEM_ROOT"]
s = json.load(open("/tmp/gm-pilot-full/summary.json"))
u,a,f,mgs = (100*s[k] for k in ("utility_accuracy","privacy_leakage_rate","deletion_leakage_rate","compliance_utility_score"))
print(f'n={s["n_checkpoints"]} (utility {s["n_utility"]}, privacy {s["n_privacy"]}, safety {s["n_safety"]})')
print(f'action_accuracy={100*s["action_accuracy"]:.1f}  over_refusal={100*s["over_refusal_rate"]:.1f}\n')
rows=[r for r in json.load(open(os.path.join(root,"docs/assets/leaderboard.json"))) if r["domain"].lower()=="medical"]
rows.append({"method":"minimem","backbone":"gpt-5.5","u":u,"a":a,"f":f,"mgs":mgs})
rows.sort(key=lambda r:-r["mgs"])
seen=set(); print(f'{"method":18} {"backbone":15} {"U":>6} {"A":>6} {"F":>6} {"MGS":>6}')
for r in rows:
    k=(r["method"],r["backbone"])
    if k in seen: continue
    seen.add(k)
    print(f'{r["method"][:18]:18} {r["backbone"][:15]:15} {r["u"]:6.1f} {r["a"]:6.1f} {r["f"]:6.1f} {r["mgs"]:6.1f}{"   <<<" if r["method"]=="minimem" else ""}')
PY
