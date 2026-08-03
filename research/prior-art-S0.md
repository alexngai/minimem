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

## 5. Search log and bounds

Queries: `agent memory systems Mem0 Letta Zep A-Mem retrieval method hybrid search BM25 dense
comparison 2026`; `retrieval advantage widens with context scale long-context truncation
observation log dump memory benchmark`. Fetched and text-extracted: 2604.15484, 2605.29630.

**Bounds.** Two queries, two deep reads. Not exhaustive. Not covered: BEAM's own leaderboard and
who else reports on it; ACL Anthology; the RAG-vs-long-context literature at scale (one paper,
2501.01880, surfaced unread); the deployed-systems claims above are all snippet-level. **A
second pass should target the scale-widening claim specifically**, since that is now the
load-bearing part of S0 and only one query has been aimed at it.
