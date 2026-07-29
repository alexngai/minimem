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

## Peak scores

Best measured overall per benchmark. These are **memory-QA-pipeline** scores
(extract observations → minimem retrieval → answer), not leaderboard-exact — see the
per-benchmark config/judge caveats below.

| benchmark | peak | config | judge |
|---|---:|---|---|
| **LongMemEval_S** | **93.0%** | full-500, cogcore-live (v15) | official prompts + gpt-4.1 (re-judged 3 ways; ~1.9pp behind Mastra 94.87%) |
| **LOCOMO** | **79.3%** | 10 conv, minimem-graph | mem0-J + gpt-4.1 |
| **BEAM** (500K) | **72.7%** | 18 conv, minimem-graph | rubric + gpt-4.1 |

Answer model gpt-5.5 throughout. **LongMemEval is a full-benchmark run** (500 questions,
the most rigorous — validated across three judges); LOCOMO and BEAM are representative
subsets. Absolute numbers are same-family-judge, not leaderboard-exact (the leaders use
gpt-4.1-mini). The LongMemEval peak is the cogcore-live arm; BEAM/LOCOMO peaks are the
minimem-graph arm (the substrate finding below is what earns the BEAM/LOCOMO numbers).

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

## Sharpening the substrate: precision levers + the answer model

Since the substrate is the win, we probed whether *sharpening retrieval precision*
(rather than adding recall/structure) or a *stronger answer model* could close the
~5pp gap to the SOTA self-reports. All three landed in the noise band — each is a
precision/recall or synthesis/precision tradeoff that cancels.

| lever | measure | verdict |
|---|---|---|
| **Bigger embeddings** (Qwen3-Embedding-0.6B, 1024-d, vs EmbeddingGemma-300M) | −1.3 @500K | inconclusive — **compromised test**: Qwen3-Embedding needs an instruction prefix on queries that minimem doesn't emit; info_extraction −15.5 is the misuse tell, not a verdict on bigger embeddings |
| **LLM reranker** (24-candidate pool → gpt-4.1 listwise → topK) | +0.9 @500K (n=24) | wash — a clean **precision-for-breadth trade**: lookup dims +3 to +5 (extraction, knowledge, event_ordering), breadth dims −3 to −6 (multi_session, contradiction, summarization). Nets to zero. |
| **Abstention guard** on the reranker | 1 fire / 240 Q | inert — the reranker won't return "none relevant" because there's always something *topically* related among candidates (topical ≠ answer-bearing) |
| **Stronger answer model** (gpt-5.6-sol answering; extraction held on gpt-5.5) | see below | synthesis-vs-precision wash |

**gpt-5.6-sol (answer model only; judge held constant):**

| benchmark | gpt-5.5 | gpt-5.6-sol | Δ |
|---|---|---|---|
| BEAM 500K (12 conv) | 70.0 | 71.6 | +1.6 |
| BEAM 1M (6 conv) | 65.5 | 67.4 | +1.8 |
| LOCOMO (10 conv, 300 q) | 78.0 | 76.0 | **−2.1** |

sol is a *stronger synthesizer, weaker at precision*: robust summarization gains
(+13 to +16) and multi_session (+19 @1M), but losses on extraction / instruction /
factual-QA. On synthesis-heavy BEAM it nets slightly positive (+1.6/+1.8, edge of
noise); on precision-heavy LOCOMO it nets **negative**. Net across benchmarks ≈ zero.
Attempting to prompt-correct sol's precision losses **backfired** (a
precision-hardened "sol prompt" scored −11.3 vs the plain tuned prompt — the
terseness/exactness directives starved the reasoning dims: temporal −33,
event_ordering −29, knowledge −21). **Useful nugget:** model choice is
*workload-dependent* — sol for synthesis-heavy tasks, gpt-5.5 for precision-heavy
recall — but neither is a universal win, and the answer model does not close the gap.

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

The one durable, large, well-supported result: **minimem's focused hybrid retrieval
≫ the cognitive-core KnowledgeBank baseline (+13pp @BEAM-500K, +43pp @LOCOMO),
widening with scale because the KB's obs-log dump truncates while minimem retrieves
the right notes regardless of store size.**

Everything layered on top of that substrate was then tested and **every axis nets to
the noise band** — because each is a precision/recall or synthesis/precision tradeoff
that cancels:

- retrieval *mechanisms*: graph traversal (+1–2pp), query decomposition (+0.7),
  synthesized summaries (−3.9), temporal specialization (−1.5);
- retrieval *quality*: LLM reranker (+0.9, precision-for-breadth wash), bigger
  embeddings (inconclusive/compromised test);
- the *answer model*: gpt-5.6-sol (synthesis-vs-precision wash; +1.6/+1.8 BEAM,
  −2.1 LOCOMO), un-boostable by prompt (−11 when tried).

**Retrieval is solved for this pipeline; the remaining ~5pp to the SOTA self-reports
is not reachable through these levers.** The honest deliverable is the retrieval
evidence (the substrate), not any single add-on. Two actionable nuggets survive: the
LLM reranker is a genuine **+4–5pp for lookup-heavy workloads** (it just nets zero on
a balanced dim-mix), and model choice is **workload-dependent** (sol for
synthesis-heavy, gpt-5.5 for precision-heavy).

Genuinely open threads (different *kind* of work, not more retrieval levers):
**judge-matched** comparison (gpt-4.1-mini) for a true leaderboard number, and the
full 35-conv BEAM numbers to firm up the absolutes.
