# minimem Retrieval/Serving Evaluation — Design Spec

> **Status:** design spec (no harness code yet). Defines *what* to measure, on
> *which standard corpora*, *how* to plug minimem in, the *roadblocks* and how the
> harness handles them, and *how* this offline retrieval eval bridges to the
> end-to-end agent eval that already exists in cognitive-core.

> **Thesis:** minimem is the *retrieval/serving* half of a two-repo memory system
> (cognitive-core is the write/extraction half). Its retrieval quality is
> currently **unmeasured by either repo**. This spec makes that quality
> measurable — primarily to **tune minimem's own configuration** (fusion,
> chunking, filters, thresholds), with literature positioning as a secondary
> by-product that guides which configs to try.

---

## 1. Where minimem sits (and the gap)

minimem stores knowledge notes (Markdown + YAML frontmatter) and serves them via
hybrid search (vector + BM25, sqlite-vec). cognitive-core produces the notes and,
at serving time, retrieves them through `KnowledgeBank.getRelevantKnowledge()`.

Verified facts about the current seam (cognitive-core `@0.x`):

- **Default knowledge retrieval is Jaccard, not minimem** (`knowledge-bank.ts:54`,
  `TextSimilaritySearchProvider`). minimem is swapped in only when a `.minimem/` /
  `MEMORY.md` marker is detected (`knowledge-bank.ts:1183`, lazy `Minimem.create`).
- **minimem only powers the semantic tail.** `getRelevantKnowledge` is 3-tier:
  domain match (file read, 1.0) → entity match (substring, 0.9) → semantic search
  for remaining slots. Tiers 1–2 bypass minimem.
- **minimem's purpose-built API is unused.** The seam (`MinimemSearchClient`)
  exposes only `.search(query, {maxResults, minScore})`. `knowledgeSearch`
  (domain/entities/**minConfidence**/type) and the `knowledge_*` graph tools are
  never called — cognitive-core hand-rolls tiers 1–2 that `buildKnowledgeFilterSql`
  already does in one indexed query.

So the cheapest missing signal is minimem's own retrieval quality. This spec
targets it, and the config matrix (§8) doubles as the evidence for whether the
integration should change (push tiers 1–2 into `knowledgeSearch`).

---

## 2. Purpose: tuning-primary

Two purposes pull in opposite directions; we commit to the first:

- **(A) Tuning (primary).** "Which minimem config is best?" Needs a *fixed* embedding
  model and reports **deltas between configs**. Cheap, deterministic, actionable.
- **(B) Positioning (secondary).** "How does minimem stack up?" Only run to *guide*
  which configs are worth trying; never headlined, because on BEIR ~80% of the
  absolute score is the embedding model, not minimem (see §6, caveat E).

**Operational consequence:** the product of this eval is **config deltas on a fixed
embedding model**, not absolute leaderboard position. "RRF gives +3.2 nDCG@10 over
weighted-sum on SciFact (model fixed)" is a result; "minimem ranks #N on MTEB" is
noise.

---

## 3. What we measure (and what we don't)

The cardinal rule, learned from the LoCoMo scoring wars (a weak judge accepted
~63% of wrong-but-adjacent answers; the same system scored 58%↔84% by
configuration alone):

> **Decouple retrieval quality from answer quality.** All headline numbers are
> *retrieval* metrics against gold relevance judgments with **no LLM in the loop**.
> Answer-quality (LLM-judge) is a separate, later, e2e concern (§10), never a proxy.

**Primary metrics (model-free, from `qrels`):**
- **nDCG@10** — graded, position-discounted ranking quality (BEIR headline).
- **Recall@{1,5,10,20}** — most directly predicts downstream answerability.
- **MRR@10**, **Hit-rate@k**.

**Secondary axes (reported alongside, never instead):**
- **Latency** p50/p95 — *relative between configs only* (sqlite-vec is brute-force; §6 caveat F).
- **Index cost** — build time, DB size, embedding cost per 1k docs.
- **Capacity** — recall@k at 10% / 50% / 100% corpus (MemBench "capacity" axis).

---

## 4. Standard corpora (the literature-grounded choice)

Three layers, each for what it can *actually* test. Use a standard benchmark
wherever one exists; synthesize only where no standard can reach a minimem feature.

### Layer A — retrieval-engine tuning → **BEIR** (primary)
[BEIR](https://github.com/beir-cellar/beir) /
[paper](https://datasets-benchmarks-proceedings.neurips.cc/paper/2021/file/65b9eea6e1cc6bb9f0cd2a47751a186f-Paper-round2.pdf):
`{corpus, queries, qrels}`, `nDCG@10`. Small subset, chosen to span the BM25↔vector
spectrum (which *is* the hybrid-weighting tuning question) and stay cheap on
`node:sqlite`:

| Dataset | Corpus | Regime it stresses |
|---|---|---|
| **SciFact** | ~5k | short, exact-term — BM25-favoring; cheap CI default |
| **NFCorpus** | ~3.6k | medical, expert judgments, multi-relevant |
| **ArguAna** | ~8.7k | paraphrase-heavy — vector-favoring; **long queries** (see §6 caveat A) |
| **SciDocs** | ~25k | citation relevance; tests title/abstract chunking |
| **FiQA-2018** | ~57k | jargon + paraphrase mix — hybrid sweet spot (occasional, not CI) |

> **HotpotQA dropped from core** (decided). Full corpus is 5.2M docs; minimem does
> single-shot retrieval and can't do the multi-hop it rewards. Revisit only as a
> labeled "graph-feature ceiling" probe via the Layer-C bridge, never as a headline.

### Layer B — memory abilities → **LongMemEval** (the memory standard)
[LongMemEval](https://arxiv.org/abs/2410.10813) /
[project](https://xiaowu0162.github.io/long-mem-eval/) ships **evidence-session
labels**, so we compute *retrieval recall per ability* model-free:

- Ingest **LongMemEval_S** (~115k tokens, 30–40 sessions).
- Report retrieval recall for: info-extraction, multi-session, **temporal**,
  **knowledge-update**, **abstention**. This is where minimem's ignored
  `created`/`updated`/`confidence`/`supersedes` fields surface as gaps (§6 caveat K).
- **PerLTQA** ([arXiv 2402.16288](https://arxiv.org/abs/2402.16288)) companion:
  its semantic↔episodic split mirrors entity/domain vs observation notes.
  *(English subset only — see §6 caveat M.)*

> **LoCoMo:** vendor-comparability only, never primary (answer key ~6.4% wrong,
> weak judge, short convos). If run: strong judge, exclude adversarial, caveats published.

### Layer C — integration fidelity → cognitive-core note bridge (thin, non-standard)
The only layer that exercises minimem's frontmatter filters + graph (no generic IR
corpus has them). Convert a sample of cognitive-core notes (from `eval-fixtures/`
or the knowledge-extractor) into `{query=(task.description,domain), gold=note_id(s)}`.
Keep small, clearly labeled non-standard.

---

## 5. Embedding strategy (decided)

**Principle: minimem stays embedding-agnostic through the OpenAI-compatible
interface; the end user swaps models via config.** The eval inherits this.

- **Anchor model:** a **SageMaker-hosted open model served via TEI** (Text
  Embeddings Inference), which exposes an OpenAI-compatible `/v1/embeddings`.
  It drops into minimem's existing `openai` provider with only a `baseUrl`
  override — **no new provider needed for P0**. Recommend a symmetric-friendly
  model (e.g. `bge-large-en-v1.5`) so the OpenAI-shaped call needs no query/doc
  asymmetry handling (see caveat below).
- **Inner-loop:** local `embeddinggemma-300M` for fast iteration; **confirm any
  chosen default delta on the SageMaker anchor** before shipping it (deltas can be
  model-dependent — §6 caveat E).
- **Bedrock (Titan v2 / Cohere v3)** is a *later* option for production: it needs
  SigV4 (not Bearer), so reach it via an **OpenAI-compatible proxy** (LiteLLM /
  Bedrock Access Gateway) — still zero minimem change — or a **native provider**
  (separate productionization task, out of scope for the eval).
- **Asymmetric-model gotcha (prerequisite if chosen):** Cohere v3 / Titan v2 / e5
  encode queries vs documents differently (`input_type` / prefixes). minimem's
  `gemini` path already signals this (`RETRIEVAL_QUERY`/`_DOCUMENT`) but its
  **`openai` path sends no type** — an asymmetric model loses quality through the
  OpenAI-compat seam. Anchoring on a symmetric model (bge-v1.5) sidesteps this for
  P0; supporting `input_type` on the OpenAI path is a tracked follow-up.

---

## 6. Corpus roadblocks & how the harness handles them

Real frictions between minimem's internals and standard IR corpora. **Blocking**
ones invalidate numbers until handled; the rest are caveats to report.

**Blocking — handle before any number is valid:**

- **A. `buildFtsQuery` ANDs every token** (`hybrid.ts:23`). Fatal on long queries
  (ArguAna args ~200 words, FiQA sentences) → near-zero FTS matches → "hybrid"
  silently collapses to vector-only. **Handle:** make FTS query mode (`AND` vs
  `OR`/quorum) a **config-matrix row** (§8) — measures the broken baseline *and*
  the fix as the first documented delta.
- **B. `minScore` default 0.3 truncates the ranking** (`minimem.ts:518`).
  **Handle:** harness forces `minScore: 0` (a call parameter — no code change).
- **C. Chunk→doc recovery capped at 200 candidates** (`minimem.ts:425`,
  `min(200, maxResults×2)`). BEIR qrels are doc-level; minimem returns chunk-level.
  **Handle:** over-fetch chunks, aggregate **max-chunk score = doc score**
  (decided), dedup to docs before truncating to top-k. Recall@k for large k is
  structurally ceilinged at ~200 docs — document it.
- **D. Assert sqlite-vec *and* FTS5 loaded.** Both degrade silently
  (vector→brute-force JS; FTS→skipped). **Handle:** harness hard-fails if
  `status().vectorAvailable` or `ftsAvailable` is false.
- **E2. Disable the watcher.** `watch.enabled` defaults true (`minimem.ts:229`);
  chokidar over 57k files is a resource fire. **Handle:** `watch: { enabled: false }`.

**Measurement-validity caveats — report, don't hide:**

- **E. Embedding model dominates BEIR.** ~80% of the absolute score is the model;
  minimem's contribution is the second-order delta. → report **within-corpus,
  fixed-model deltas**; treat absolutes as positioning-only (§2).
- **F. Latency is unrepresentative.** sqlite-vec 0.1.x is brute-force exact KNN
  (linear scan, no ANN). → relative cost only, never a deployable number.
- **G. Long-doc chunk multiplicity biases recall** toward long docs (more chunks =
  more top-k shots). The fixed max-chunk aggregation (C) keeps it constant.

**Scale & cost:**

- **H. Embeddings stored twice** — JSON text in `chunks.embedding` *and* the vec0
  blob (`schema.ts:50`, `minimem.ts:701`). A 1536-dim vector as JSON ≈ 15–25 KB;
  FiQA (~100k chunks) → ~1.5–2.5 GB JSON in SQLite. Plan disk.
- **I. Brute-force scan + embedding cost** at 10k–100k chunks. Mitigated by
  small-BEIR defaults and the content-hash cache: **embeddings paid once**, reused
  across every fusion/threshold config; only chunking changes force re-embed.

**Corpus-fit problems:**

- **K. LongMemEval doesn't map cleanly to pure retrieval.** *Abstention* needs
  "return nothing" → becomes a `minScore`-calibration study, not ranking.
  *Knowledge-update*/*temporal* measure whether the latest fact outranks the
  superseded one — minimem has no such mechanism, so these report the *absence* of
  a feature (valid finding, not a tuning signal). Pin one ingestion unit
  (round-level, per the paper) and don't vary it inside the matrix.
- **M. PerLTQA is bilingual (Chinese-origin);** `buildFtsQuery`'s `[A-Za-z0-9_]+`
  tokenizer drops CJK entirely. **Handle:** English subset only for P-phases.

---

## 7. Feature-coverage map

| minimem feature | Layer A (BEIR) | Layer B (LongMemEval/PerLTQA) | Layer C (cc bridge) |
|---|---|---|---|
| Hybrid vector+BM25 weighting | ✅ primary | ✅ | ✅ |
| Vector-only / BM25-only ablation | ✅ | ✅ | ✅ |
| **FTS query mode (AND vs OR/quorum)** | ✅ primary | ✅ | ✅ |
| **RRF vs weighted-sum fusion** | ✅ primary | ✅ | ✅ |
| Chunking (char-window vs structure-aware) | ✅ (long docs) | ✅ | ◐ (notes small) |
| `minScore` threshold / abstention | ◐ | ✅ (abstention) | ✅ |
| **Metadata filters** (domain/entity/confidence/type) | ❌ | ◐ | ✅ only here |
| **Temporal / knowledge-update** | ❌ | ✅ only here | ◐ |
| **Graph / multi-hop** | ❌ | ◐ | ✅ |
| Latency / index cost / capacity | ✅ | ✅ | ✅ |

`✅` first-class · `◐` partial · `❌` not testable here. The map is the argument for
all three layers.

---

## 8. Config matrix (the decision table)

Same queries through each config; the deltas are the findings. Each row maps to a
product/integration decision.

| Config | Question it answers |
|---|---|
| **Jaccard** (cognitive-core default) | the production baseline minimem must beat |
| minimem `search()` — current 70/30 hybrid | what minimem contributes *as wired today* |
| **FTS mode: AND → OR/quorum** | cost of the `buildFtsQuery` bug; value of the fix |
| **RRF vs weighted-sum** | does rank-fusion beat the scale-mismatched weighted sum |
| **vector-only / BM25-only**, weight sweep | which signal carries which query type; is 70/30 right |
| `knowledgeSearch()` + metadata filters | what minimem gives if cognitive-core used its real API (Layer C) |
| full 3-tier vs **minimem-as-single-retriever** | should hand-rolled tiers 1–2 collapse into `knowledgeSearch` |
| + **confidence-aware ranking** | does down-ranking low-confidence/stale notes help (column exists, unused) |
| + **recency tiebreak / supersedes filter** | does honoring `created`/`updated`/`supersedes` help temporal recall |
| + **structure-aware chunking** | does heading-aware chunking beat char-window on long notes |

**Reproducibility guardrails:** pin embedding model+version, chunk config, and seeds
in every report header; commit subsampled doc-id lists; BM25-only + local-embedding
runs are free → the CI gate; SageMaker/paid runs are the periodic confirmation;
report = JSON + Markdown; CI fails on nDCG@10 regression beyond tolerance.

---

## 9. Phased plan

| Phase | Corpus | Deliverable | Cost |
|---|---|---|---|
| **P0 — core engine** | small-BEIR (SciFact, NFCorpus, ArguAna, SciDocs) | model-free nDCG@10/recall/MRR harness; Jaccard vs hybrid vs FTS-mode vs RRF vs vector/BM25-only; capacity sweep | ~zero (BM25/local) |
| **P1 — fusion + chunking** | + FiQA | RRF, structure-aware chunking, threshold/weight calibration; pick defaults from P0/P1 deltas; confirm on SageMaker anchor | low |
| **P2 — memory abilities** | LongMemEval_S, PerLTQA (EN) | per-ability retrieval recall; expose temporal/update/abstention gaps; design confidence/recency/supersedes ranking | medium (retrieval metrics still model-free) |
| **P3 — integration fidelity** | cognitive-core note bridge | `knowledgeSearch` + filters vs hand-rolled tiers; recommend the wiring change | low |
| **P4 — e2e confirmation** | cognitive-core live arm | `knowledgeBank` channel ablation with optimized minimem | high — once per milestone |

Each phase gates the next: no fusion tuning (P1) before the P0 baseline; no live
arm (P4) before P2/P3 say there's a lift to find.

---

## 10. The e2e bridge (so offline wins are real wins)

Offline metrics debug the *mechanism*; cognitive-core already owns the *impact*
test: its `EVALUATION.md` defines a **`knowledgeBank` feature-flag ablation** on the
live ALFWorld/GSM8K arm, currently flagged **unmeasured** (roadmap item 0).
Discipline: tune minimem offline (P0–P3) → confirm the lift flows through that
existing ablation (learning vs no-learning, optimized minimem as retriever). Same
two-tier method cognitive-core already uses for experience memory.

---

## 11. Proposed harness layout (for when built — not in this spec)

```
evals/                          # in the minimem repo (decided)
├── datasets/                   # loaders: beir.ts, longmemeval.ts, perltqa.ts, cc-bridge.ts
│   └── cache/                  # downloaded corpora (gitignored)
├── harness/
│   ├── materialize.ts          # corpus doc -> memory/<sanitized-id>.md (+ id map)
│   ├── run.ts                  # query -> Minimem.search / knowledgeSearch (minScore:0, watch:off)
│   ├── configs.ts              # the §8 matrix (incl. pluggable FTS query builder)
│   └── score.ts                # nDCG@k / recall@k / MRR vs qrels; max-chunk -> doc agg
├── report.ts                   # JSON + Markdown + per-query-type breakdown
└── README.md
```
CLI sketch: `minimem-eval --dataset scifact --config hybrid,rrf,bm25 --fts and,or --k 10 --out report.md`

---

## 12. Decisions & residual open items

**Decided:** tuning-primary (§2) · standard corpora BEIR + LongMemEval/PerLTQA,
HotpotQA dropped from core (§4) · embedding agnostic via OpenAI-compat, SageMaker
TEI anchor + gemma inner-loop (§5) · max-chunk→doc aggregation (§6-C) · FTS-mode &
weights as config rows, `minScore:0` in harness (§6, §8) · harness in minimem,
P4 reuses cognitive-core (§9, §11).

**Residual (decide at build time):**
1. Exact SageMaker anchor model (`bge-large-en-v1.5` recommended for symmetric simplicity).
2. When to add `input_type` support to minimem's OpenAI path (only if an asymmetric anchor is chosen).
3. Whether the FTS fix (AND→OR/quorum) ships to minimem core after the delta confirms it (expected yes).
4. Layer-C bridge: vendor a cognitive-core fixtures snapshot vs dev-dependency.

---

## 13. References
- BEIR — [paper](https://datasets-benchmarks-proceedings.neurips.cc/paper/2021/file/65b9eea6e1cc6bb9f0cd2a47751a186f-Paper-round2.pdf) · [repo](https://github.com/beir-cellar/beir) · MTEB retrieval leaderboard
- LongMemEval — [arXiv 2410.10813](https://arxiv.org/abs/2410.10813) · [project](https://xiaowu0162.github.io/long-mem-eval/) · [code](https://github.com/xiaowu0162/longmemeval)
- PerLTQA — [arXiv 2402.16288](https://arxiv.org/abs/2402.16288)
- LoCoMo (caveats) — [ACL 2024](https://aclanthology.org/2024.acl-long.747/) · [audit](https://penfieldlabs.substack.com/p/we-audited-locomo-64-of-the-answer)
- MemBench (capacity/efficiency) — [ACL 2025](https://aclanthology.org/2025.findings-acl.989/)
- TEI (OpenAI-compatible embeddings) — [github.com/huggingface/text-embeddings-inference](https://github.com/huggingface/text-embeddings-inference)
- e2e bridge — cognitive-core `EVALUATION.md` (`knowledgeBank` channel ablation)
