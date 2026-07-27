# BEAM structural-retrieval results

How a memory arm built on **minimem's own knowledge graph** performs on
[BEAM](https://github.com/mohammadtavakoli78/BEAM) (*Beyond a Million Tokens*,
ICLR 2026), and the path that got there. Headline: **structural, graph-aware
retrieval matches flat retrieval at 100K and pulls decisively ahead as the
context grows — +14.7pp at 500K and +23.2pp at 1M** over a flat baseline on the
same data.

> Judge/scale caveats up front: BEAM's reference judge is `gpt-4.1-mini`; this
> harness substitutes `gpt-4.1`. All comparisons here are **same-judge,
> same-data deltas** between two retrieval strategies (not leaderboard-exact
> absolute scores). Answer model: `gpt-5.5`. Every number below is
> **majority-of-3** unless noted; single-sample BEAM numbers proved unreliable
> (per-dim run-to-run noise ±8pp; see "Measurement" below).

## The question

Can we match or beat the BEAM leaders — Hindsight (73.4% @100K, verified SOTA on
[agentmemorybenchmark.ai](https://agentmemorybenchmark.ai)), and the vendor
self-reports cognee (0.79 @100K) and Exabase M-1 (0.769 @100K / 0.75 @1M)? Their
edge is **retrieval that exploits structure** — cognee seeds vector search then
*traverses a graph*; Exabase does query-decomposition + temporal/coherence
re-ranking. None win by putting better notes in a flat pile.

## The diagnosis: retrieval was the bottleneck

The cogcore-live arm's retrieval was **structure-blind and fixed-budget**: a
top-16 semantic-similarity injection plus an always-on 40k-char observation-log
dump, and nothing else (the agentic tool path was inert — `state.mm` was null).
Two consequences, both measured:

- **Prompt tuning is exhausted.** A BEAM-tuned answer prompt gave +6.6pp @100K,
  but that only made the model *read the pile better*.
- **Adding structure to a fixed pile is zero-sum.** A contradiction-synthesis
  pass helped in isolation (+14.4pp offline) but washed out live (−1.2pp) —
  derived notes just displaced other notes in the 16 slots, and the always-on
  obs-log already carried the raw content.

At 100K the obs-log (~60 observations, ~20k chars) already fits most of memory,
so *any* retrieval on top is marginal. **The bottleneck — and the leaders'
lever — only bites at scale, where memory no longer fits.**

## The fix: graph-aware retrieval on minimem's own graph

minimem already ships the whole stack and the eval was bypassing it: typed
knowledge notes (`knowledge_type`/`entities`/`domains`), a `knowledge_links`
graph, BFS traversal (`getGraphNeighbors`/`getGraphPath`), and hybrid RRF
search. The overhaul (module: `evals/longmemeval/minimem-graph.ts`):

1. **Typed, linked ingestion.** Each observation → a minimem knowledge note.
   Edges built automatically: **entity** links (observations sharing an entity,
   via per-entity hub nodes) and a **temporal** chain (`before` edges by date).
2. **Seed-then-traverse retrieval.** Hybrid `search()` seeds observation nodes;
   `getGraphNeighbors(depth 2)` expands along entity/temporal edges into a
   *connected* context, not 16 independent chunks. Size-independent by
   construction — it retrieves the right notes regardless of how big the store is.

Toggles: `--retrieval minimem-graph --graph-traverse on` (plus `--samples N`,
`--dims`, `--conv-start` for measurement).

## Results — the scale curve

Overall accuracy (mean of the 10 BEAM dimensions), flat KB baseline vs.
minimem-graph, same data / same judge, majority-of-3:

| scale | KB (flat + obs-log) | minimem-graph | delta | notes |
|-------|--------------------:|--------------:|------:|-------|
| 100K  | ~parity             | ~parity       | ~0    | obs-log still fits (~60 obs) |
| 500K  | 58.0                | **72.7**      | **+14.7** | 18 conv; obs-log truncates (~239 obs) |
| 1M    | 45.3                | **68.5**      | **+23.2** | 6 conv; obs-log truncates hard (~515 obs) |

**The gap widens monotonically with scale.** The flat KB baseline degrades
catastrophically (parity → 58.0 → 45.3) as its 40k obs-log truncates an
ever-larger share of memory (60 → 239 → 515 observations extracted; ~69% dropped
at 1M). minimem-graph stays roughly flat (72.7 → 68.5) — a graceful decline.
minimem-graph@1M (68.5%) lands in the published leaders' 1M band (Hindsight
73.9%, Exabase 75.0%), on minimem's own machinery.

### Per-dimension @1M (6 conv, majority-of-3)

| dimension | KB | minimem-graph | Δ |
|-----------|---:|--------------:|--:|
| information_extraction   | 29.0 | 84.0 | **+55.0** |
| knowledge_update         | 33.3 | 75.0 | **+41.7** |
| preference_following     | 63.4 | 90.3 | **+26.9** |
| multi_session_reasoning  | 30.1 | 55.0 | **+24.9** |
| event_ordering           | 31.0 | 53.6 | **+22.6** |
| contradiction_resolution | 38.9 | 57.6 | **+18.7** |
| summarization            | 21.8 | 37.9 | **+16.0** |
| temporal_reasoning       | 36.1 | 51.4 | **+15.3** |
| instruction_following    | 69.4 | 82.9 | **+13.4** |
| abstention               | 100.0 | 97.2 | −2.8 |
| **OVERALL**              | **45.3** | **68.5** | **+23.2** |

The **smoking gun is information_extraction: KB 29.0% at 1M** — the facts have
been truncated out of the obs-log entirely — **vs graph 84.0% (+55)**. Flat
"dump everything" isn't a retrieval strategy at scale; it's just truncation.

### 500K per-dimension (18 conv, majority-of-3), overall +14.7

extraction +26.8, event_ordering +21.5, multi_session +21.0, instruction +18.7,
contradiction +16.4, knowledge_update +13.9, summarization +12.8, preference
+10.1, temporal +9.9; abstention −3.7.

## Secondary findings (100K)

- **Query-adaptive retrieval** (route by question intent): summarization routing
  = **+10.2pp** on that dimension (~3σ), by giving summary questions a holistic
  prompt over the broad context instead of the fact-focused default. Temporal
  routing was flat (the obs-log is already chronological). Lesson: query-adaptive
  assembly pays off where the default *strategy* mismatches, not as a blanket.
- **Contradiction flips positive at scale.** Feared a gap (−4.9 at n=6), it
  becomes **+16.4 (500K) / +18.7 (1M)** with more data and no explicit
  `contradicts` edges — entity hubs co-retrieve *both sides* of a conflict
  (same entity), so flagging gets easier for free.

## Measurement discipline

- **Majority-of-3 everywhere.** Single-sample BEAM is noise-dominated: per-dim
  std ≈ ±8pp; event_ordering/temporal have 25–30% of substantive answers scored
  0 by the rubric judge (genuine model variance on multi-chunk reasoning). The
  "69.0% tuned @100K" headline was an optimistic single draw.
- **Always ablate in-run**, same data + judge, and report the delta — absolute
  numbers aren't leaderboard-exact (gpt-4.1 vs gpt-4.1-mini judge).
- **Cache-collision gotcha:** splits reuse conversation ids (100K conv `1` vs
  500K conv `1`); observation/graph caches are id-keyed, so ids are namespaced
  per dataset (`beam-500K--1`).

## Reproduce

```sh
# data (once per scale)
curl -sL "https://huggingface.co/api/datasets/Mohammadta/BEAM/parquet/default/1M/0.parquet" \
  -o evals/beam/cache/beam-1M.parquet
evals/beam/.venv/bin/python evals/beam/convert.py \
  evals/beam/cache/beam-1M.parquet evals/beam/cache/beam-1M.json

# flat KB baseline vs structural minimem-graph, majority-of-3
npx tsx evals/beam/run.ts --data evals/beam/cache/beam-1M.json --conversations 6 --samples 3 \
  --details-out evals/beam/results/1m-kb-details.jsonl
npx tsx evals/beam/run.ts --data evals/beam/cache/beam-1M.json --conversations 6 --samples 3 \
  --retrieval minimem-graph --graph-traverse on \
  --details-out evals/beam/results/1m-graph-details.jsonl
npx tsx evals/beam/diff-details.tmp.ts \
  evals/beam/results/1m-kb-details.jsonl evals/beam/results/1m-graph-details.jsonl
```

## Pushing past SOTA: three bets, and the ceiling

minimem-graph@1M (68.5%) sits ~5–6pp under the vendor 1M self-reports (Exabase
75.0, Hindsight 73.9). We tested three retrieval-side levers to close it, each a
majority-of-3 ablation against the champion (6 conv, 1M):

| bet | mechanism | overall Δ | verdict |
|-----|-----------|----------:|---------|
| #1 temporal + timeline | route temporal/ordering Qs to a chronological, timeline-prompted context | **−1.5** | hurt (event_ordering −12.1, temporal −6.9) |
| #3 query decomposition | split each question into sub-queries, union graph retrievals (Exabase's lever) | **+0.7** | neutral (noise; multi_session flat +0.2) |
| #2 synthesized summaries | LLM-synthesize hierarchical summary nodes, retrievable like any note (cognee's lever) | **−3.9** | hurt badly (abstention −19.4, extraction −14.9) |

**All three failed or landed in the noise, and the reasons rhyme:**

- **Specialization disrupts** (#1): routing away from the tuned prompt and
  sorting by date destroys the relevance ordering the answer model relies on.
- **The graph already gathers multi-hop evidence** (#3): seed-then-traverse pulls
  entity-connected notes across the whole history, so decomposing the query is
  redundant.
- **Broad nodes pollute a shared top-K** (#2): summary nodes rank high for many
  queries and *displace* the specific observations that precise dims (extraction,
  abstention) need — over-retrieval → confident wrong answers.

**Conclusion: the graph champion (seed-then-traverse + the plain tuned prompt,
relevance-ordered) is a local optimum for this setup** — the graph already
captures the retrievable signal; adding retrieval machinery on top displaces more
than it adds. All three levers are flag-gated and off by default, so the champion
is unchanged (`--query-adaptive` / `--query-decomp` / `--graph-summaries`).

**The remaining absolute gap is a model/judge axis, not retrieval.** We answer
with gpt-5.5 and judge with gpt-4.1; the leaders use Gemini-3 and judge with
gpt-4.1-mini. Closing 68.5→75 absolute most plausibly requires matching those,
which is orthogonal to the retrieval architecture this doc validates.

## Takeaway

Retrieval was the bottleneck; structural, graph-aware, size-independent retrieval
is the fix; and its advantage **grows with scale** (parity @100K → +14.7 @500K →
+23.2 @1M) — the property the SOTA systems are known for, reproduced on minimem's
own graph. Three follow-on retrieval levers all showed the champion is at a local
optimum, so the durable result is the **structural-vs-flat delta**, and the
remaining absolute gap is a model/judge question. The graph feature is folded into
the minimem **product** (`graph.autoEntityLinks` at sync + `search({graphExpand})`),
off by default, tests green.

Open threads for a fresh strategy: match model/judge for a true leaderboard
comparison; harden with the full 35-conv numbers; revisit abstention (traversal
over-retrieves); and a genuinely different mechanism for summarization (the one
dim nothing moved).
