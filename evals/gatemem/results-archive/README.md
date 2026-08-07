# Archived predictions

Gzipped copies of every `../results/*.jsonl` prediction file — 129 arms, 810 MB → 36 MB.

**Why.** These are the input to scoring, so any re-score (a different judge, a corrected
metric, a new analysis) needs them, and regenerating one costs a full run. They previously
existed in a single uncompressed copy. The session that produced them also watched OS temp
cleanup silently delete the GateMem checkout — scorer, metrics module and all benchmark data
— so single-copy was not an acceptable state for the only remaining irreplaceable artifact.

They compress to 4% because `prompt_memory_block` is ~96% of each file and repeats heavily:
checkpoints within an episode retrieve overlapping notes, re-serialised per checkpoint.

**Use.** `zcat results-archive/<tag>-<domain>.jsonl.gz > results/<tag>-<domain>.jsonl`. The
scorer expects uncompressed `.jsonl`; `results/` stays the uncompressed working copy and is
gitignored.

Judge verdicts for the scored arms are preserved separately in `../judged/`.
