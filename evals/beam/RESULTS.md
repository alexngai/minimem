# Retrieval results — BEAM + LOCOMO

**Corrected headline (see "Attribution" below).** Routing memory retrieval through
**minimem's focused hybrid search** — instead of the cognitive-core
KnowledgeBank's dump-the-whole-observation-log approach — is a large win that
**grows with scale**: +13pp on BEAM-500K, +43pp on LOCOMO. A **knowledge-graph
feature layered on top** (`autoEntityLinks` + `graphExpand`) adds only a
**marginal +1–2pp (within noise)**, with an abstention downside — so the durable
result is the retrieval *substrate*, not the graph.

> An earlier version of this doc attributed the win to "structural graph-aware
> retrieval." That was **mis-attributed** — the KB-vs-graph comparison conflated
> the retrieval substrate with the graph traversal. The clean three-arm
> decomposition below isolates them and corrects the record.

> Judge/scale caveats: BEAM's reference judge is `gpt-4.1-mini`; this harness uses
> `gpt-4.1`. LOCOMO uses the mem0 "J" correctness judge (`gpt-4.1`). Answer model:
> `gpt-5.5`. All numbers are same-judge, same-data deltas between arms, not
> leaderboard-exact absolutes. BEAM cells are majority-of-3; LOCOMO is single-sample
> over 300 stratified questions.

## Attribution — the clean three-arm decomposition

The win was originally reported as "cognitive-core KB **vs** minimem-graph," which
changes **two** things at once: the retrieval **substrate** (cognitive-core KB +
obs-log dump → minimem hybrid + focused context) *and* the **graph traversal**.
Isolated with a third arm (minimem-flat = minimem hybrid retrieval, graph off):

| arm | BEAM 500K (6 conv, maj-3) | LOCOMO (10 conv, 300 q) |
|---|---:|---:|
| cognitive-core KB (obs-log dump + KB retrieval) | 55.3 | 35.3 |
| **minimem-flat** (hybrid RRF search, focused 16-note context, **no graph**) | **68.4** | **78.0** |
| minimem-graph (+ `autoEntityLinks` + `graphExpand`) | 70.3 | 79.3 |
| **→ substrate delta** (KB → flat) | **+13.1** | **+42.7** |
| → graph delta (flat → graph) | +1.9 | +1.2 |

**The substrate is the win. The graph traversal is marginal — +1.9 / +1.2, inside
the noise (n=12 maj-3 / n=62-per-category single-sample)** — and it carries a
consistent downside (abstention −13.9 @BEAM, from over-retrieval). It is **not** a
proven win on this evidence.

## Why the substrate wins, and why it scales

The cognitive-core KB arm injects a **40k-char observation-log dump + flat top-K**.
minimem-flat does **focused hybrid (RRF) retrieval** — the ~16 most relevant notes.
- At small scale (LOCOMO ~9–26k tokens, ~128 obs) the KB dump *fits* but is noisy
  and under-ranked → minimem's focused retrieval wins by a huge margin (+42.7).
- At large scale the KB obs-log **truncates** (60 → 239 → 515 observations
  extracted; ~69% dropped at 1M), while minimem retrieves the right focused notes
  **regardless of store size** → the gap *widens with tokens*.

The original "scale curve" (cognitive-core KB vs minimem-graph): parity @100K →
**+14.7 @500K** → **+23.2 @1M**. Decomposed at 500K (substrate +13.1 vs graph +1.9),
**~90% of it is the substrate** — a property of minimem's retrieval, not the graph.
(The 1M flat arm wasn't run; by the 500K/LOCOMO decomposition the graph share is
~+2pp there too, so substrate ≈ +21pp @1M.)

## The original diagnosis (still correct, re-pointed)

The cogcore-live retrieval was **structure-blind and fixed-budget**: a top-16
semantic injection + an always-on 40k obs-log dump, nothing else (the agentic tool
path was inert, `state.mm` null). Prompt tuning (+6.6pp @100K) only made the model
read that pile better. The fix that actually moved the needle was **replacing the
substrate** — routing retrieval through minimem's hybrid search with a focused
context — **not** adding graph structure on top.

## Cross-benchmark generalization (LOCOMO)

minimem-flat/-graph reach **78–79%** on LOCOMO — a recognized benchmark at a very
different scale and with a different judge (mem0 "J") — in the SOTA ballpark (mem0
reports ~66%). Every category improves massively over the KB arm (multi-hop +51,
temporal +63, single-hop +56, open-domain +37, adversarial +12). The graph adds
~+1pp here too. The retrieval substrate **generalizes**; the graph does not add
meaningfully in either regime.

## The "push past SOTA" bets (on top of the substrate+graph champion)

Three retrieval-side levers, each a majority-of-3 ablation vs the champion (6 conv,
1M). All failed or landed in noise — consistent with a substrate that already
captures the retrievable signal:

| bet | mechanism | overall Δ | verdict |
|---|---|---:|---|
| temporal + timeline | route temporal Qs to a chronological, timeline-prompted context | −1.5 | hurt |
| query decomposition | split each question into sub-queries, union graph retrievals | +0.7 | neutral (noise) |
| synthesized summaries | LLM summary nodes, retrievable like any note | −3.9 | hurt badly |

## Measurement discipline

- **Isolate one variable at a time.** The original KB-vs-graph comparison
  conflated substrate + graph; the three-arm decomposition (KB / flat / graph) is
  the honest form. Always include the flat control.
- **Majority-of-3 on BEAM** (single-sample per-dim std ≈ ±8pp; the "69.0% tuned
  @100K" was an optimistic single draw). LOCOMO's binary mem0-J over 300 questions
  is stable single-sample for the overall.
- **Cache-collision gotcha:** splits/benchmarks reuse ids; observation/graph caches
  are id-keyed, so ids are namespaced per dataset (`beam-500K--1`, `locomo--<id>`).

## Reproduce

```sh
# BEAM three-arm decomposition @500K (majority-of-3); extraction cached after arm 1
for arm in "kb" "minimem-graph --graph-traverse off" "minimem-graph --graph-traverse on"; do
  npx tsx evals/beam/run.ts --data evals/beam/cache/beam-500K.json --conversations 6 --samples 3 \
    --retrieval ${=arm} --details-out "evals/beam/results/500k-${arm// /_}.jsonl"
done
npx tsx evals/beam/diff-details.tmp.ts evals/beam/results/500k-kb.jsonl evals/beam/results/500k-minimem-graph_--graph-traverse_off.jsonl  # substrate
npx tsx evals/beam/diff-details.tmp.ts evals/beam/results/500k-minimem-graph_--graph-traverse_off.jsonl evals/beam/results/500k-minimem-graph_--graph-traverse_on.jsonl  # graph

# LOCOMO (small scale, mem0-J judge), KB vs flat vs graph
npx tsx evals/locomo/run-graph.tmp.ts --conversations 10 --max-q 30 --retrieval kb --details-out evals/locomo/results/locomo-kb-details.jsonl
npx tsx evals/locomo/run-graph.tmp.ts --conversations 10 --max-q 30 --retrieval minimem-graph --graph-traverse off --details-out evals/locomo/results/locomo-flat-details.jsonl
npx tsx evals/locomo/run-graph.tmp.ts --conversations 10 --max-q 30 --retrieval minimem-graph --graph-traverse on --details-out evals/locomo/results/locomo-graph-details.jsonl
```

## Takeaway

The durable, well-supported result: **minimem's focused hybrid retrieval ≫ the
cognitive-core KnowledgeBank baseline (+13pp @BEAM-500K, +43pp @LOCOMO), widening
with scale because the KB's obs-log dump truncates while minimem retrieves the
right notes regardless of store size.** The **knowledge-graph feature**
(`autoEntityLinks` + `graphExpand`, in `src/minimem.ts`) is **marginal — +1–2pp,
within noise, with an abstention cost** — sound code, but not a validated win. The
honest deliverable is the *retrieval evidence*, not the graph feature.

Open threads: model/judge-matched comparison for a true leaderboard number; the
full 35-conv BEAM numbers; and — if the graph is to earn its place — a workload
where entity traversal beats focused hybrid search by more than noise (not found
in either benchmark so far).
