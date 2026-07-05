# LOCOMO results — baseline v1 (tracked for debugging)

Full run: 10 conversations, **1986 QA each**, Azure GPT-5.5 for extraction +
answer + judge, `--concurrency 8`, `--topk 8`, seed 1. mem0 embedder = local
Ollama `nomic-embed-text`; cogcore/minimem embedder = minimem local model.
Judge = mem0 J-judge (self-family, **not yet human-validated** → treat as a
provisional upper bound).

## Accuracy (excl. adversarial; 1540 scored QA)

| Arm | Accuracy | 95% CI |
|---|---|---|
| `minimem-alone` (BM25) | 59.0% (908/1540) | [56.5, 61.4] |
| `cogcore-memory` (extraction + consolidation) | 68.7% (1058/1540) | [66.4, 70.9] |
| `cogcore-retrieval` (structured notes + minimem hybrid) | 72.1% (1111/1540) | [69.8, 74.2] |
| `mem0` (competitor) | 78.2% (1205/1540) | [76.2, 80.2] |

## Per-category accuracy

| category | minimem-alone | cogcore-retrieval | cogcore-memory | mem0 |
|---|---|---|---|---|
| single_hop (841) | 68.8% | 81.9% | 75.7% | 86.1% |
| multi_hop (282) | 33.3% | 50.0% | 46.5% | 56.7% |
| temporal (321) | 59.5% | 71.7% | 74.8% | 84.4% |
| open_domain (96) | 45.8% | 53.1% | 52.1% | 52.1% |

## Cost / tokens (full run)

| arm | ingest tok | ingest/conv | answer/q | judge/q | TOTAL tok |
|---|---|---|---|---|---|
| minimem-alone | 0 | 0 | 601 | 243 | 1.68M |
| cogcore-retrieval | 0 | 0 | 715 | 243 | 1.90M |
| cogcore-memory | 550.8k | 55.1k | 1.0k | 242 | 3.05M |
| mem0 | 2.92M | 292.3k | 537 | 237 | 4.46M |

## Open gaps to close (debugging targets)

Goal: get **both** cogcore arms to beat mem0 (78.2%).

- mem0 leads every category except open_domain. Biggest cogcore gaps vs mem0:
  temporal (retrieval 71.7 vs 84.4), single_hop (81.9 vs 86.1), multi_hop
  (50.0 vs 56.7).
- `cogcore-memory` < `cogcore-retrieval`: extraction is lossy and the entity
  tier barely fires (see procedure notes below).

## cogcore retrieval procedure (as currently wired)

`getRelevantKnowledge({ description: question }, { maxNotes: topK, maxTokens })`
runs cognitive-core's 3-tier retrieval:

1. **Domain tier** — skipped: the adapter does not pass `task.domain`.
2. **Entity tier** — only fires when the question string literally contains an
   entity slug (substring match). `cogcore-retrieval` stores `entities: []`, so
   this tier is always empty for it; `cogcore-memory` has entity notes but the
   literal-substring gate rarely matches real questions.
3. **Semantic tier** — delegates to `MinimemSearchProvider` → **our minimem**
   `search(query, { maxResults })` over the note files (hybrid BM25+local-embed,
   RRF fusion), mapping minimem path hits back to note IDs.

So in practice **both cogcore arms are dominated by the minimem semantic tier**:
- `cogcore-retrieval`: minimem hybrid over one note per raw turn.
- `cogcore-memory`: minimem hybrid over extracted facts + defrag'd entity notes,
  with the entity tier mostly inert.

Suspected levers (to test): raise `topK`; make the entity tier embedding-based
instead of literal-substring; feed raw turns alongside extracted facts;
compare against mem0's hybrid+entity-boost retrieval.

## Trace findings v1 (conv-26, 24 stratified QA)

Tool: `npx tsx evals/locomo/trace.ts` → `results/trace-ccr-ccm.{md,json}`.
Sample accuracy: cogcore-retrieval 17/24 (70.8%), cogcore-memory 16/24 (66.7%)
— reproduces the full-run gap. Concrete root causes:

1. **Entity-note truncation is keep-FIRST + chronological → surfaces stale
   junk (cogcore-memory).** `defragment()` builds a consolidated `melanie` /
   `caroline` entity note ordered oldest-first. The entity tier scores it 0.9
   and sorts it into slot 1, but `answerFromBank` truncates every excerpt to
   1200 chars — so only the EARLIEST (session-1, least relevant) facts survive
   and the query-relevant later facts are cut. The headline consolidation
   mechanism is currently **net-negative**: it burns the top slot on a truncated
   chronological dump. Example — "What do Melanie's kids like?" (gold:
   dinosaurs, nature): retrieval retrieves the verbatim turn "stoked for the
   dinosaur exhibit… love learning about animals" and answers correctly; memory
   gets the truncated entity note + 3 off-topic facts and answers "Swimming".

2. **Extraction paraphrases away the needed detail (cogcore-memory).**
   "How did Melanie feel about her family after the accident?" (gold: they mean
   the world to her): retrieval hits the exact turn; memory's extracted fact
   "Melanie felt very scared during the accident" displaces it → answers "Very
   scared". Raw turns preserve the exact wording the judge wants.

3. **topK=8 under-retrieves multi-hop facts (BOTH arms).** "Melanie's pets"
   (gold: Oliver, Luna, Bailey — 2 sessions) and "instruments Melanie plays"
   (gold: clarinet AND violin — D15:26 + D2:5) fail on both arms: the 3rd
   pet / the violin turn never make the top 8. This is pure recall.

### Ranked levers to test
- **A. Raise topK (8 → 16/20)** — directly targets the multi-hop recall misses.
  Cheapest; no code change. (Testing now.)
- **B. Fix entity-note surfacing** — either relevance-rank facts within the
  consolidated note before truncation, give consolidated notes a larger char
  budget, or disable the entity tier and rely on the semantic fact notes (which
  already answer correctly). Clean A/B via `includeEntityNotes`.
- **C. Hybrid context for memory** — feed raw turns alongside extracted facts so
  exact wording survives (closes the paraphrase gap vs retrieval).

## Experiment log (conv-26, 24 stratified QA)

| variant | cogcore-retrieval | cogcore-memory |
|---|---|---|
| baseline topk=8 | 70.8% (17/24) | 66.7% (16/24) |
| **A. topk=16** | **75.0% (18/24)** | 66.7% (16/24) |
| A + B (entity-note relevance-rank) | — | 58.3% (14/24) |

- **A. topk=16 is a real win for retrieval** (+4.2pt): it fixed the "instruments
  Melanie plays" multi-hop miss (now retrieves clarinet D15:26 **and** violin
  D2:5). Adopt for the next full run. Memory unmoved → its bottleneck is not
  recall.
- **B. Entity-note relevance-ranking (`excerptForQuery`) is verified working**
  at the mechanism level: the `caroline` entity excerpt now leads with the
  query-relevant fact instead of the earliest chronological one. But its net
  accuracy effect is **unmeasurable on this harness** because `cogcore-memory`
  re-runs GPT-5.5 extraction with no seed every time — only 2 questions flipped
  between the two memory runs and both were semantic-note (not entity-note)
  answers. Extraction variance ≈ ±2/24 (±8pt) dominates.

## cognitive-core 0.3.0 validation (ADD-only + index consolidation + entity-boost)

cognitive-core `0.3.0` (branch `memory-add`) landed the DESIGN-memory-extraction-add-only
workstreams and is linked into the harness (`npm link`). The `cogcore-memory` adapter now
caches LLM-extracted facts per `sampleId` (WS0) → **deterministic ingest**.

**Mechanical checks (conv-26 smoke, 6 Q):** entity-boost fires (39 `[entity]`-tagged
retrievals), index-record entity notes are **never** surfaced as content (0 leaks),
and the lossy chronological content-dump entity note is gone. Extraction cache written
and reused across runs.

**Cross-conversation sample (10 convs × 30 stratified QA = 238 scored, excl. adversarial;
seed=1, topk=8, local embeddings):**

| category | cogcore-retrieval | cogcore-memory (0.3.0) |
|---|---|---|
| overall (excl-adv) | 64.7% (154/238) | 64.7% (154/238) |
| multi_hop | 50.0% | **53.2%** |
| temporal | 73.8% | **78.7%** |
| single_hop | **78.7%** | 73.8% |
| open_domain | **55.6%** | 51.9% |

- **The baseline ordering is reversed on the categories the fixes target.** In the full
  1540-QA baseline `cogcore-memory` (68.7%) trailed `cogcore-retrieval` (72.1%), and lost
  on multi_hop (50.0 vs 50.0→ was below) and temporal. Now `cogcore-memory` **ties overall
  and leads on multi_hop (+3.2pp) and temporal (+4.9pp)** — the entity-boost / index-record
  consolidation is doing exactly what it was designed to: lifting entity-anchored multi-hop
  and temporal facts instead of drowning them in a truncated content dump.
- `cogcore-retrieval` still leads single_hop/open_domain (raw turns carry verbatim phrasing
  that helps single-fact lexical matches); `cogcore-memory`'s remaining misses are
  **extraction-quality** (paraphrasing away specifics, e.g. "cup with a dog face" → "pottery
  bowl"), i.e. WS3 fact-granularity, not retrieval.

**Caveats / not yet done:**
- This 30-per-conv **stratified** sample oversamples the hard categories (multi/temporal/
  open) relative to the natural distribution (which is ~55% single_hop), so 64.7% here is
  **not comparable** to the 78.2% full-distribution mem0 number. The WS5 target
  (both cogcore arms > 78.2%) needs the **full 1540-QA natural-distribution ladder**
  (incl. re-running mem0) — recommend an overnight run.
- Harness note: run **one arm per process** (`run-full.sh` pattern). Running multiple arms
  in a single process accumulates native embedding/exit-listener resources (~14 minimem
  instances) and crashed the combined run mid-way; per-arm resume completed cleanly.

## Sample-iteration diagnostic — why cogcore trails mem0 (conv-26, 24 Q)

Ran a per-question failure taxonomy on the deterministic conv-26 sample (extraction cached).
Split cogcore-memory's 8 losses by whether cogcore-retrieval got them right:

| bucket | count | meaning |
|---|---|---|
| memory wrong, **retrieval right** | 6 | **extraction cost** — detail existed in raw turns, extraction dropped it |
| **both** wrong | 2 | shared multi-hop recall / embedding ceiling |
| retrieval wrong, memory right | 5 | index/boost consolidation genuinely helps (abstract art, "since 2016", "10 yrs ago") |

**Iteration 1 — extraction fidelity (v2 prompt, cache v2):** preserve concrete modifiers,
exact temporal phrasing, emotions; split enumerations into atomic facts. Result: the dropped
details ("bailey", "violin", "friday", "universe", "conference", "got hurt") are **now in the
store** (743 facts, up from enumeration-splitting). **But aggregate accuracy did not move
(16/24).** The bottleneck **moved to retrieval**: facts present, not surfaced.

**Iteration 2 — IDF-weighted entity boost (cognitive-core):** the flat +0.15 boost floods the
top-k with the dominant speaker's generic facts. Made it `boostWeight / log2(links+2)` so
ubiquitous entities fade. Tests green. **But mechanically unchanged on the target case:**
"What are Melanie's pets' names?" still retrieves 0 pet notes in top-16 — the pet facts
("Melanie has a pet named Luna/Oliver", "another cat named Bailey") aren't in the semantic
pool at all. cogcore-retrieval (dense raw turns) finds them; the 743 thin atomic facts +
weak local embeddings can't.

**Conclusions:**
1. **The mem0-style write technique (index consolidation + boost) is winning its cases (5 wins),
   not the problem.** The ceiling is **retrieval precision over the atomic-fact store**, and it
   is a *shared* ceiling — cogcore-retrieval (raw hybrid) also trails mem0 → embedding quality
   (minimem local model vs mem0's `nomic-embed-text`) is the prime suspect.
2. **Enumeration-splitting helped completeness but hurt retrievability** — dense notes match
   weak embeddings better than many thin facts.
3. **24 Q cannot A/B ±1–2pp changes.** GPT-5.5 is a reasoning model (no `temperature`), so the
   answerer is irreducibly noisy — retrieval arm swung 17→18→16 with no code change. Reliable
   sample A/B needs ≥3–5 convs (~120–150 Q) + bootstrap CIs.

**Recommended next levers (validate on a mid sample, not 24 Q, before the full 1540 run):**
- **A.** Wire the already-built `KeywordExpandingSearchProvider` (WS2d) into the cogcore arms —
  distills the question to keywords, lifting lexical recall for thin atomic facts.
- **B.** Swap minimem's embedding model (or use the same `nomic-embed-text` as mem0) — shared
  ceiling for **both** arms; likely the biggest single lever.
- **C.** Don't over-split enumerations — keep a combined note alongside atomic facts.
- **D.** (mem0 parity) dedup / UPDATE to shrink the store and cut distractors.

## ROOT CAUSE FOUND — FTS had no stemming ("pets" ≠ "pet")

Isolated the retrieval failure with a standalone probe (`probe-retrieval.ts`) that reconstructs
the bank from the extraction cache and queries minimem directly, bypassing the noisy answer/judge:

| query | pet-relevant in top-16 |
|---|---|
| `"Luna"` | 5/5 (incl. the pet fact `k-00279`) — **indexing is fine** |
| `"Melanie pets cats dogs names Luna Oliver Bailey"` | 13/16 — **content is retrievable** |
| `"What are Melanie's pets' names?"` (the actual question) | **0/16** |

The note says "Melanie has a pet named Luna"; the question says "pet**s**' **names**". minimem's
FTS5 table used the **default tokenizer with no stemming**, so `pets ≠ pet` and `names ≠ named` —
the only matching token was "Melanie", which floods. Not an embedding, boost, or extraction
problem — a **lexical-stemming** gap that capped **both** arms.

**Fix (`src/db/schema.ts`):** `tokenize = 'porter unicode61'` on the FTS5 table. Query and index
terms are both Porter-stemmed, so morphological variants match. (Requires a reindex for
pre-existing DBs; the eval builds fresh indexes each run.)

**Impact (conv-26, 24 Q, topk 16, local embeddings) — before → after stemming:**

| arm | before | after |
|---|---|---|
| cogcore-retrieval | 16–18/24 | **21/24 (87.5%)** |
| cogcore-memory | 16/24 | **18/24 (75.0%)** |

The pets question now answers "Luna, Oliver, and Bailey" on **both** arms. This is a minimem-core
retrieval improvement (helps every consumer, not just the eval). Keyword expansion (A) and the
`nomic` embedding option (B) are now wired and available (`--keyword-expansion`,
`--embeddings nomic`) but are secondary to stemming; evaluate whether they add anything on top
via the mid sample before spending them on the full run.

### Mid-sample A/B with stemming (3 convs = conv-26/30/41, 94 non-adversarial QA, topk 16, local emb.)

Run one arm per process (`mid-stem.json` = retrieval, `mid-stem-ccm.json` = memory; the combined
one-process run crashed on the memory arm's embedding startup — the documented resource issue).

| metric | cogcore-retrieval | cogcore-memory |
|---|---|---|
| overall (excl-adv) | **79.8% (75/94)** CI[71.3–87.2] | **71.3% (67/94)** CI[61.7–80.9] |
| single_hop | 88.5% | 80.8% |
| multi_hop | 65.4% | 57.7% |
| temporal | 92.3% | 84.6% |
| open_domain | 68.8% | 56.3% |

**Read-out:**
- Stemming lifted **both** arms. `cogcore-retrieval` at **79.8%** is competitive with / above the
  mem0 OSS number (78.2% full-run) — on a different sample, but its CI comfortably spans it.
- `cogcore-memory` (the extraction arm, closest to mem0's write technique) still trails its own
  retrieval arm on **every** category (~8pp). This is the **extraction recall tax**: compressing
  dense turns into atomic facts loses verbatim detail that LOCOMO rewards. The mem0-style
  index/boost helps ranking but can't recover detail the extractor dropped or split too thin.
- Takeaway for launch: **raw-turn structured hybrid retrieval + stemming is the strongest,
  simplest arm.** Closing the memory arm's gap to mem0 would need mem0-parity write work
  (ADD/UPDATE dedup, less aggressive enumeration splitting) — a separate investment.
- Next: full 1540-QA natural-distribution ladder (retrieval + memory + mem0) with stemming for
  the headline. Expect retrieval ≈ or > mem0; memory somewhat behind.

## mem0's "91.6 LoCoMo" vs our measured 78.2 — reconciling the gap

Source: mem0 blog "The Token-Efficient Memory Algorithm" (Apr 16 2026).

The 91.6 is **not comparable** to our 78.2:
- **91.6 = mem0 managed platform + NEW algorithm.** Blog: "Scores reflect Mem0's
  managed platform, which includes proprietary optimizations **not available in
  the open-source SDK**." Their own OLD-algorithm LoCoMo baseline = **71.4**.
- **Our arm = mem0ai OSS `v3.0.13`** driven by GPT-5.5 for extraction+answer, our
  J-judge, fixed topK=8. 78.2 sits between their old (71.4) and new (91.6),
  which is exactly what you'd expect for the OSS SDK + a frontier model — the
  blog itself notes LoCoMo "can be materially improved by … larger context
  windows, or frontier models."
- Different system tier, algorithm version, judge, and retrieval budget → the
  marketing number is not an apples-to-apples target. Our harness's value is the
  **fair internal comparison** (same LLM + judge across all arms, plus a cost
  axis), not reproducing mem0's headline.
- Note: mem0's own "what's next" admits temporal / event-ordering /
  multi-session reasoning stay WEAK even for them — precisely LoCoMo's
  multi-hop/temporal buckets. They de-emphasize LoCoMo in favor of BEAM (1M/10M).

## What mem0's new algorithm does differently → cognitive-core action items

| mem0 new-algo principle | cognitive-core today | action |
|---|---|---|
| **Single-pass ADD-only** extraction; every fact an independent record; state changes coexist (never overwrite) | extracts atomic facts, then `defragment()` **consolidates/overwrites** into entity notes | **Drop write-time consolidation.** Our trace proved the consolidated entity note is lossy + net-negative. Keep atomic facts as independent notes. |
| **Entity linking as a query-time ranking BOOST** (entities embedded, query entities matched → score boost) | entity tier = **literal substring** match; when it fires it injects a truncated chronological dump into the top slot | Make the entity layer embedding-based; use it as a **fusion/boost signal**, not a slot-consuming top-priority note. |
| **Multi-signal retrieval**: semantic + keyword + entity, rank-fused | minimem hybrid = semantic + BM25 (RRF); **no entity signal** | Add an entity-match signal into minimem's fusion (semantic+BM25 already good). |
| **Keyword normalization** (verb-form lemmatization) | FTS tokenization, no stemming | Add stemming/lemmatization to FTS ("attended" ↔ "attending"). |
| Agent-generated facts first-class | n/a for LoCoMo (2 humans) | product note. |

Bottom line: several of mem0's biggest wins (ADD-only, entity-as-boost) target
the **exact anti-patterns our trace found** in `cogcore-memory` (lossy
`defragment()` consolidation, brittle substring entity tier). Fixing those is
the highest-leverage work — independent of chasing mem0's platform number.

## Methodology gap → next infra
`cogcore-memory` cannot be A/B'd until extraction is **deterministic**. Plan:
cache extracted facts (+ the built KnowledgeBank note dir) to disk keyed by
`sampleId`, and reuse across runs so answer-side changes (topK, entity ranking,
entity tier on/off, hybrid context) become clean single-variable A/Bs. Only then
re-test levers B and C for memory.

## Recall diagnostic — where do the misses come from? (conv-26, 24 Q, seed=1)

Retrieval-only, deterministic (no answer/judge LLM). Attributes each miss to
retrieval vs extraction by checking whether the **gold evidence turns** are
actually surfaced. Tool: `recall-diag.ts`. Report: `results/recall-diag.md`.

**Recall of gold evidence**

| k | ccr turn-recall | ccr session-recall | ccm session-recall |
|---|---|---|---|
| 8 | 62.5% | 83.3% | 75.0% |
| 16 | 75.0% | 100% | 79.2% |
| 24 | 79.2% | 100% | 79.2% |

- **Extraction coverage** = 83.9% (26/31 evidence sessions produced ≥1 fact).
  ~16% of evidence is **dropped at extraction** — a hard ceiling for
  `cogcore-memory` regardless of retrieval/topK.

**Attribution @k=8 (retrieval hit × answer correctness)**

| arm | retrieved✓ & wrong | retrieved✓ & right | retrieved✗ & wrong | retrieved✗ & right |
|---|---|---|---|---|
| cogcore-memory | 6 | 12 | 2 | 4 |
| cogcore-retrieval | 3 | 12 | 4 | 5 |

- `cogcore-retrieval` → **retrieval-bound**: 4/7 misses are the exact evidence
  turn falling outside top-8; turn-recall +12.5pp at k=16.
- `cogcore-memory` → **extraction-bound**: 6/8 misses have the right session
  retrieved but the answer still wrong (lossy fact), + zero-fact sessions.
  Session-recall plateaus ~79% — more k barely helps.

## Fix + retest: topK 8 → 16 (same sample, 0.3.0 code)

| arm | topK=8 | topK=16 | Δ | drivers |
|---|---|---|---|---|
| cogcore-retrieval | 70.8% | **83.3%** | +12.5pp | multi_hop 3→5, temporal 3→4 |
| cogcore-memory | 66.7% | **75.0%** | +8.3pp | single_hop 3→5, multi_hop 2→4 |

Matches the recall prediction exactly (ccr turn-recall +12.5pp @k=16). Baked
`topK=16` as the default for both cogcore adapters. **Next lever (ccm ceiling):
extraction lossiness** — richer per-turn facts + reducing zero-fact sessions
(the retrieved✓-but-wrong bucket), which topK cannot fix.

## Extraction ceiling fix: chunked extraction (cache v2 → v3)

Root cause of the 16% coverage gap: GPT-5.5 is a **reasoning** model, so reasoning
tokens count against `max_completion_tokens` (4096). On the *largest* sessions
the budget was exhausted before the JSON finished → truncated output → `parseFacts`
(which required a closing `]`) returned `[]`. The 3 biggest sessions of conv-26
(8=39, 14=35, 16=20 turns) each extracted **zero facts**.

Fix (adapter, cache v3):
- **Chunk long sessions** into ≤10-turn windows; extract per chunk; union facts
  per session. Bounds output so it never truncates, and improves per-turn
  thoroughness.
- **Salvage-parse**: recover complete `{...}` objects from a truncated array
  (string/escape-aware brace scan) as defense-in-depth.

Result on conv-26 (24 Q, seed=1, topK=16):

| metric | v2 | v3 |
|---|---|---|
| zero-fact sessions | 8, 14, 16 | **none** |
| total facts | 743 | **1061** (+43%) |
| extraction coverage (evidence sessions w/ ≥1 fact) | 83.9% | **100%** |
| ccm session-recall@8 | 75.0% | **95.8%** |
| **ccm sample accuracy** | 75.0% | **95.8%** (multi_hop 4→6, temporal 4→6, single_hop 5→6) |

Attribution @k=8 flipped to 22/24 "retrieved✓ & right" — the lossy
extraction bucket is essentially eliminated. Net on this sample: ccm went
66.7% (topk8/v2) → **95.8%** (topk16/v3). Single conversation (n=24) so the
absolute number is optimistic/noisy, but the mechanism is real; full-ladder
run (topK=16 + v3) in progress for the headline.

## FULL LADDER — all 10 conversations, answerable QA (topK=16 + v3)

`overallN=1540` = answerable questions (single_hop+multi_hop+temporal+open_domain).
Adversarial (446, refusal test) reported separately.

| arm | topK | **answerable** | single_hop | multi_hop | temporal | open_domain | adversarial |
|---|---|---|---|---|---|---|---|
| minimem-alone | 16 | 68.5% | 78.7 | 44.3 | 67.9 | 52.1 | 15.0 |
| cogcore-retrieval | 16 | 76.9% | 85.1 | 57.4 | 79.4 | 54.2 | 13.2 |
| cogcore-memory (v3) | 16 | 75.8% | 83.4 | 55.3 | **81.6** | 50.0 | **22.2** |
| mem0 | 8¹ | **78.2%** | 86.1 | 56.7 | 84.4 | 52.1 | 22.9 |

¹ mem0 is the prior Jul-3 run at topK=8 (its ingest is topK-independent; only the
answer-time retrieval budget differs). A topK=16 mem0 rerun is needed for a fully
apples-to-apples headline.

**Readout:**
- topK=16 + v3 extraction lifted the cogcore arms from trailing badly to
  **within ~1–2pp of mem0**. cogcore-retrieval 76.9%, cogcore-memory 75.8%.
- cogcore-memory leads on **temporal** (81.6, +1.7 vs ccr) and **adversarial
  refusal** (22.2, +9 vs ccr) — the entity-consolidation + dated-fact extraction
  paying off — but trails ccr on single/multi/open, netting ≈ ccr overall.
- The conv-26 sample (ccm 95.8%) was **wildly optimistic** — conv-26 is an easy
  conversation. Full-set ccm is 75.8%. Lesson: single-conversation samples are
  not predictive of the full distribution; validate levers on ≥1 conv but trust
  only the full ladder for headlines.
- cogcore has NOT yet overtaken mem0 on the full set. Remaining levers (all
  measured as helpful but not yet default-on): query distillation
  (KeywordExpandingSearchProvider), higher topK, MMR diversity in retrieval.
