#!/usr/bin/env bash
# Run the mem0 arm until all 10 conversations are present. Each pass resumes
# from the checkpoint (skips completed conversations), so a partial exit is
# mopped up on the next pass. Belt-and-suspenders on top of the runner's
# keep-alive + per-question timeouts.
set -u
cd /Users/alexngai/GitHub/minimem
source ~/.zshrc 2>/dev/null
OUT=evals/locomo/results/full-mem0.json

convs_done() {
  node -e "try{const r=require('$PWD/$OUT');process.stdout.write(String(r.systems.mem0.score.ingestCost.count||0))}catch(e){process.stdout.write('0')}"
}

for attempt in $(seq 1 8); do
  echo "=== mem0 pass $attempt $(date) (done so far: $(convs_done)/10) ==="
  npx tsx evals/locomo/run.ts --systems mem0 \
    --conversations 10 --questions 0 --concurrency 8 --resume \
    --out "$OUT"
  d=$(convs_done)
  echo "=== mem0 pass $attempt ended, done=$d/10 $(date) ==="
  if [ "$d" -ge 10 ]; then echo "=== mem0 COMPLETE ($d/10) $(date) ==="; break; fi
  sleep 3
done
