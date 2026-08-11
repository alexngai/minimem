# Prior art — S0 (the retrieval substrate result)

Run directly, 2026-08-02, after S0 was promoted to headline claim. **[fetched]** = retrieved and
read, PDF text extracted with `pypdf` where the summarizer was unreliable. *[snippet]* = search
result only, not verified.

**Claim under test.** Routing agent-memory retrieval through focused hybrid search, rather than
a dump-the-observation-log knowledge bank, wins by +13.1pp on BEAM-500K and +42.7pp on LOCOMO,
and the gap widens with scale (parity@100K → +14.7@500K → +23.2@1M). Isolated from the graph
layer by a three-arm decomposition.

## 1. Verdict

**PARTIAL-OVERLAP, split cleanly along architecture vs result.**

The **architecture** is pre-empted, precisely and independently, four months ago. The **claim**
is not. No located work tests this substrate class against deployed agent-memory systems at
500K–1M token scale, and none reports a scale-widening gap. S0 survives as a result about
deployed systems, and must stop describing its architecture as novel.

## 2. Nearest prior work

### 1. vstash: Local-First Hybrid Retrieval with Adaptive Fusion for LLM Agents **[fetched]**
Jayson Steffens. arXiv 2604.15484, 2026-04-20. Code: github.com/stffns/vstash

**This is minimem's stack, published independently.** From the abstract, verbatim: *"a
local-first document memory system that combines vector similarity search with full-text
keyword matching via Reciprocal Rank Fusion (RRF) and adaptive per-query IDF weighting. All
data resides in a single SQLite file using **sqlite-vec** for approximate nearest neighbor
search and **FTS5** for keyword matching."*

Single SQLite file, sqlite-vec, FTS5, RRF, local-first. That is our substrate, component for
component.

**What it does NOT pre-empt.** Its four contributions are about *embedding and fusion tuning*,
not memory-system architecture: self-supervised embedding refinement from hybrid-retrieval
disagreement (74.5% of 753 BEIR queries produce top-10 disagreement between vector-heavy and
FTS-heavy search, used as a free training signal); adaptive RRF with per-query IDF weighting
(up to +21.4% NDCG@10 on ArguAna); a negative result on post-RRF scoring (frequency+decay,
history-augmented recall, and cross-encoder reranking all failed); and a production substrate
with integrity checking. **It is evaluated entirely on BEIR** — SciFact, NFCorpus, FiQA,
ArguAna. It never runs an agent-memory benchmark, never compares against Mem0, Letta or a
knowledge-bank baseline, and makes no scale-widening claim about long-horizon stores.

**Consequence.** We cannot present the substrate as a novel architecture. We can present the
*result*: what this substrate class does against deployed memory systems on long-horizon
benchmarks, which is the question vstash does not ask. Its negative result on cross-encoder
reranking also **independently corroborates ours** (our LLM reranker netted +0.9, a
precision-for-breadth wash) and should be cited as such.

### 2. Entity-Collision: A Stratified Protocol for Attributing Retrieval Lift in Agent Memory **[fetched]**
Youwang Deng, Independent Researcher. arXiv 2605.29630v1, 2026-05-29. Code:
github.com/youwangd/engram

**Methodologically adjacent, and a corroborating null — not a pre-emption.** A first-pass
summary suggested it decomposes substrate versus graph, the same move as our three-arm
ablation. Reading the abstract, it does not. It attributes lift **over BM25 to the embedder**,
by constructing distractors that share the answer's entity tokens so the BM25 floor is pinned
by construction, then stratifying by discriminator tag. Design: 5 tags × 3 embedders × 5
collision degrees, paired-bootstrap 95% CIs.

Its findings are directly relevant to ours. *"Encoder capacity alone is not the binding
constraint"* — a 2.7×-parameter BGE-large does not uniformly beat MiniLM-384. And: *"Adaptive
vector-weight routing on LoCoMo is a measured null: 11.7 pp of oracle headroom exists, but no
signal we tested recovers it."* That is an independent replication of our own finding that
every retrieval-side lever lands in the noise band, on the same benchmark, by a different
method. It also reports a single-session-preference recall cliff replicating on LongMemEval
(n=500), adjacent to our single-session-assistant gap.

**Must cite** — for the attribution methodology, and as independent support for "retrieval is
solved for this pipeline."

### 3. The deployed-systems landscape *[snippet]*
Search summaries indicate **Mem0 now uses hybrid retrieval combining semantic, keyword and
entity methods, with BM25 + dense on newer versions**; **Hindsight** runs four parallel
strategies (semantic, BM25, graph traversal, temporal) with cross-encoder reranking; and
**SuperLocalMemory** implements **4-channel RRF** (Fisher-Rao geometric, BM25 lexical, entity
graph, temporal). None verified at source.

**This kills a framing we were carrying.** `PAPER-PLANNING.md` C2 argues the novel part is
"that *deployed memory systems don't do it*, which is an observation about the field." That
observation appears to be **out of date**. Multiple deployed systems now fuse lexical and dense
retrieval, at least one with RRF specifically. **Verify before writing anything that depends on
it, and drop the claim if it holds up.**

## 3. What survives

| component | status |
|---|---|
| sqlite-vec + FTS5 + RRF in one file, local-first | **pre-empted** by vstash (2604.15484) |
| "hybrid beats vector-only" | long established; never was ours |
| "deployed memory systems don't fuse" | **likely false now** — Mem0, Hindsight, SuperLocalMemory |
| Beating a deployed KB baseline by +13.1/+42.7 on BEAM/LOCOMO | **survives** |
| The gap widening with scale (parity → +14.7 → +23.2) | **survives, and is the strongest part** |
| Mechanism: log-dump truncation (~69% dropped at 1M) vs size-invariant retrieval | **survives** |
| Three-arm isolation of substrate from graph | survives; adjacent to Entity-Collision, different axis |

**The scale curve is the defensible core.** Not "we built a hybrid retriever" — vstash did too,
and tuned it more carefully. What no located work shows is that the advantage of focused
retrieval over context-stuffing *grows* with store size on long-horizon agent memory, with a
named mechanism for why.

## 4. Consequences for the paper

1. **§3 (System) must cite vstash and concede the architecture.** Position as: same substrate
   class, independently arrived at, different question. Claiming novelty for sqlite-vec + FTS5 +
   RRF after April 2026 would be a citation failure a reviewer can find in one search.
2. **The framing of commitment 1 in `thesis.md` needs narrowing** from "the retrieval substrate"
   to "what this substrate does at scale against deployed memory systems."
3. **Verify the Mem0 / SuperLocalMemory hybrid claims at source** before any sentence asserts
   that deployed systems don't fuse. That sentence is currently in `PAPER-PLANNING.md`.
4. **Both papers are corroborating as well as constraining** — vstash's cross-encoder null and
   Entity-Collision's LoCoMo null independently support our "every lever is in the noise band"
   conclusion. That strengthens the honest version of the paper.

## 4b. Focused pass on the scale-widening claim (2026-08-02, second round)

Run because the scale curve became S0's load-bearing part. It survives, but is narrower than
the ledger implies, and two structural problems surfaced.

### The RAG-vs-long-context literature does not establish it — and that helps

**Long Context vs. RAG for LLMs: An Evaluation and Revisits** — Xinze Li, Yixin Cao, Yubo Ma,
Aixin Sun, arXiv 2501.01880. **[fetched]** ~20K questions across 12 QA datasets, GPT-4o and
GPT-4-Turbo, five retrievers. Concludes **long context generally beats RAG** (56.3% vs 49.0%),
and explicitly frames the result as a trade-off between context length and relevance **rather
than a scaling relationship**. Critically for us: RAG wins on *"fragmented information,
particularly in dialogue-based contexts."*

Every benchmark we use — BEAM, LOCOMO, LongMemEval — is dialogue-based. So this paper does not
pre-empt our claim; it **circumscribes** it, and supplies a citation for why the setting
matters. Cite it as the boundary condition, not as a threat.

*[snippet]* Adjacent, unverified: "In Defense of RAG in the Era of Long-Context Language
Models" (2409.01666); search summaries indicate the RAG-advantage-with-corpus-size argument is
usually made on **cost** grounds rather than accuracy.

### Problem 1 — the baseline's truncation makes the curve partly mechanical

Our scale-widening result is measured against the cognitive-core KB, which dumps a fixed-size
observation log and drops ~69% of observations at 1M. A gap that widens as a fixed-budget
baseline truncates harder is close to definitional. It is a real property of a deployed system
and worth reporting, but it is **not a surprising finding**, and stating it as one invites the
obvious objection. Frame as: fixed-budget context assembly degrades at scale while retrieval
does not, demonstrated on a deployed system — not as a discovery about retrieval.

### Problem 2 — BEAM has a live leaderboard, it runs to 10M, and our curve stops at 1M

*[snippet, needs direct verification]* BEAM is a public benchmark
(github.com/vectorize-io/agent-memory-benchmark) with a leaderboard at
benchmarks.hindsight.vectorize.io. **Hindsight** claims #1 "with a 58% margin", explicitly at
the **10M-token** tier "where context stuffing is impossible", and has a paper
(arXiv 2512.12818, *Hindsight is 20/20*). **cognee** reports beating SOTA at the 100K setting
by 6.5% and matching SOTA at 10M using default open-source features.

Two consequences, both uncomfortable:

1. **Our comparison baseline is not on the board.** "+13.1 over cognitive-core KB" is a delta
   against a system that does not appear in BEAM's competitive set. That is a legitimate
   ablation but it is not a leaderboard claim, and the paper must not let the two blur.
2. **The scale claim is weakest exactly where the benchmark is most interesting.** Our curve
   covers 100K→1M. The tier competitors contest is 10M, and it is the tier where the mechanism
   we identify (context stuffing becomes impossible) is most decisive. A reviewer familiar with
   BEAM will ask why we stopped at 1M.

**Recommended action.** Either extend the curve to 10M, or state the 1M ceiling explicitly and
frame the contribution as the *mechanism* rather than the frontier. `open-before-submission.md`
lists "full 35-conversation BEAM" as optional with "no reason to expect improvement" — that
assessment predates knowing the leaderboard runs to 10M, and should be revisited.

*Also surfaced, unread, relevant to the discussion section*: "Beyond Memory Leaderboards:
Evaluating Scientific Memory as Budgeted Context Restoration" (arXiv 2607.16848).

## 4c. The 10M competitive picture, and why our own structural features failed (2026-08-04)

### Provisional standing — and why it is not a ranking

| system | BEAM-10M | protocol |
|---|--:|---|
| Hindsight | 64.1% | AMB harness, vendor-reported |
| **minimem-flat** | **58.3%** | ours, n=4 conv |
| mem0 | 48.6% | cited in `evals/beam/run.ts` |
| "next-best published" | 40.6% | Hindsight's own claim |
| *our kb baseline* | *29.9%* | ours |

**Three protocols, not one.** This is not a judge mismatch, it is a whole-pipeline mismatch:

| | answerer | judge | conversations |
|---|---|---|--:|
| AMB harness | `gemini-3.1-pro-preview` | `gemini-2.5-flash-lite` | 35 |
| BEAM paper reference | — | `gpt-4.1-mini` | 35 |
| **ours** | `gpt-5.5` | `gpt-4.1` | **4** |

The answer model differs too, so 64.1 vs 58.3 confounds judge, answerer, sample size **and
possibly the metric**: AMB reports "raw mean nugget score, pass@score≥0.5, pass@score≥0.8, and
perfect-score counts", and which of those 64.1 refers to is unstated. Our figure is a
mean-of-dimension-means over per-item floored rubric scores. These may not be the same
quantity. **Do not publish this table as a ranking.**

### The important question: cognitive-core already provides most of what Hindsight does

Hindsight's architecture is four networks (world facts, agent experiences, entity summaries,
evolving beliefs) with retain/recall/reflect, four parallel retrieval strategies (semantic,
BM25, graph traversal, temporal) and cross-encoder reranking. Its pitch is that "observations
synthesize higher-order knowledge so retrieval returns insights, not raw history."

**We already have the synthesis half.** Both BEAM arms consume the *same* cognitive-core
extracted observations — 27,358 facts for conv 1. The kb arm and the flat arm differ only in
retrieval. So minimem-flat's store already contains "insights, not raw history"; what it lacks
is Hindsight's structure-aware *retrieval*.

**And we tested that half. It failed:**

| feature | measured Δ | scale tested |
|---|--:|---|
| graph traversal (`autoEntityLinks` + `graphExpand`) | +1.9 / +1.2 | 500K / LOCOMO |
| synthesized summary nodes | **−3.9** | 1M, 6 conv, mean-3 |
| temporal + timeline routing | −1.5 | 1M, 6 conv, mean-3 |
| query decomposition | +0.7 | 1M, 6 conv, mean-3 |
| LLM reranker | +0.9 | 500K |

Every Hindsight-shaped feature we implemented landed in noise or hurt. Graph traversal also
carried an abstention penalty (−13.9 @BEAM) from over-retrieval.

### Two reasons that null may not generalise to 10M

**1. Everything was tested at ≤1M — outside the regime where structure should pay.** This is
exactly the scope C1-P states in advance: compression and structure earn their cost only where
context is *binding*. At 1M with top-k 16 over focused retrieval, it is not. Hindsight's margin
appears at 10M, and **our own weakest dimensions at 10M are precisely the ones structure
targets**: multi_session_reasoning 15.6, temporal_reasoning 18.8, summarization 20.4,
event_ordering 40.2 — against instruction_following 100.0 and information_extraction 75.0. We
are strong where an excerpt suffices and weak where assembly is required.

**2. The ablations may be under-powered.** They were 6 conversations, mean-of-3, at 1M. We now
know per-conversation variance at 10M is large (kb sd 6.3, flat sd 1.6). A −3.9 or +1.9 effect
measured across 6 conversations may not be distinguishable from zero at that spread. "Landed in
noise" and "too few conversations to detect" are not the same claim, and the write-up currently
asserts the former.

### The falsifiable follow-up

Re-run the structural ablations **at 10M**, paired, on the conversations whose extraction
caches are already warm (1–6). If graph traversal / summary nodes / temporal routing pay there
and not at 1M, C1-P is confirmed on a second axis and the "retrieval is solved for this
pipeline" conclusion is scope-limited rather than general. If they still fail at 10M, the
substrate story is stronger than currently claimed and Hindsight's margin must come from
something else — most plausibly evolving beliefs, the one component we have no analogue for.

Either outcome is publishable. The current state — a null measured only outside the regime
where the effect is predicted — is the one that is not.

## 5. Search log and bounds

Queries: `agent memory systems Mem0 Letta Zep A-Mem retrieval method hybrid search BM25 dense
comparison 2026`; `retrieval advantage widens with context scale long-context truncation
observation log dump memory benchmark`. Fetched and text-extracted: 2604.15484, 2605.29630.

**Bounds.** Two queries, two deep reads. Not exhaustive. Not covered: BEAM's own leaderboard and
who else reports on it; ACL Anthology; the RAG-vs-long-context literature at scale (one paper,
2501.01880, surfaced unread); the deployed-systems claims above are all snippet-level. **A
second pass should target the scale-widening claim specifically**, since that is now the
load-bearing part of S0 and only one query has been aimed at it.
