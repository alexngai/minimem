# minimem Retrieval Eval — P0 Execution Plan

> Companion to [RETRIEVAL-EVAL.md](RETRIEVAL-EVAL.md) (the design spec). This is the
> build plan for **P0**: a model-free, deterministic small-BEIR tuning harness, plus
> the **M1–M3** knowledgeSearch/metadata integration patch that P0 produces evidence
> for. Tracking tasks mirror the workstream IDs (W1–W5, M1–M3).

---

## Goal & exit criteria

**Goal:** pick minimem's fusion / FTS-query / hybrid-weight defaults from *measured
deltas*, on a fixed embedding model, with no LLM in the loop.

**P0 is done when:**
1. The harness runs end-to-end on **SciFact, NFCorpus, ArguAna**.
2. TS metrics (`nDCG@10`, `recall@{1,5,10,20}`, `MRR@10`, `hit@k`) are **validated
   against `pytrec_eval`** within ±0.001 on one run, then used self-contained.
3. The **config-comparison table** (below) is produced per dataset with **bootstrap
   95% CIs** and deltas vs the hybrid baseline and vs Jaccard.
4. A **free CI gate** runs (BM25-only, no embeddings) with an `nDCG@10` regression guard.

---

## The efficiency insight that shapes everything

Every P0 config is **search-time only** (chunking is fixed in P0). So it's **one index
per (dataset × embedding model)**, embeddings content-hash-cached, and all configs are
swept over that single index. Only the **Jaccard** baseline runs outside minimem
(harness-side). This keeps P0 cheap and fast.

---

## Workstreams

### W1 — Datasets
- Loader + on-disk cache for **SciFact (~5k), NFCorpus (~3.6k), ArguAna (~8.7k)**;
  SciDocs (~25k) deferred to P1.
- BEIR format: `corpus.jsonl {_id,title,text}`, `queries.jsonl {_id,text}`,
  `qrels/test.tsv {query-id, corpus-id, score}`. Source: HuggingFace `BeIR/*` or BEIR zips.
- Commit dataset versions/checksums; no network in CI (use cache).
- ArguAna is the **long-query** dataset — the stress case for the FTS-mode row.

### W2 — minimem affordances (the only core changes P0 needs)
All backward-compatible config; defaults preserve current behavior.
1. **`hybrid.ftsQueryMode: "and" | "or"`** — make `buildFtsQuery` pluggable
   (`src/search/hybrid.ts:23`). Default `"and"`.
2. **`hybrid.fusion: "weighted" | "rrf"`** — add a Reciprocal Rank Fusion path to
   `mergeHybridResults` (rank-based, k=60). Default `"weighted"`.
3. **Clean pure-vector / pure-BM25 selection** — honor `vectorWeight:0` → skip vector
   search, `textWeight:0` → skip FTS, so the matrix gets unmixed rankings.
> The winning values become shippable minimem defaults — that's the payoff of tuning.

### W3 — Harness
- **`materialize`** — corpus doc → `memory/<sanitized-id>.md` (`# {title}` + body),
  collision-safe id↔path map, batched writes.
- **`run`** — per query → `Minimem.search` with **`minScore:0`** and
  **`watch:{enabled:false}`**; **hard-fail** unless `status().vectorAvailable` &&
  `ftsAvailable`. Over-fetch chunks toward the 200-candidate cap.
- **chunk→doc aggregation** = **max-chunk score = doc score** (dedup before truncating
  to top-k docs).

### W4 — Metrics + report
- TS impl of `nDCG@k / recall@k / MRR@10 / hit@k` from qrels + **bootstrap CI over
  queries** (mirror cognitive-core's convention).
- A harness-side **Jaccard retriever** as the baseline (matches cognitive-core's
  default; keeps the comparison in-repo).
- **Validate TS metrics vs `pytrec_eval` once** (±0.001), then TS is CI-self-contained.
- Output: JSON + Markdown, per dataset, configs × metrics with deltas + CIs.

### W5 — Matrix run + CI gate
- Run the full matrix; write the findings doc.
- **CI:** BM25-only run (zero embedding deps → free) + `nDCG@10` regression guard.
- Embedding ladder: BM25-only (smoke) → local `embeddinggemma` (inner loop) →
  **SageMaker/TEI via the `openai` provider + baseUrl** (milestone confirmation).

---

## The P0 config matrix (the deliverable)

Per dataset × {SciFact, NFCorpus, ArguAna}, reporting nDCG@10 / recall@10 / MRR@10 + CI + delta:

| Config | Tests |
|---|---|
| Jaccard (harness baseline) | the bar minimem must beat |
| hybrid 70/30 (current default) | what minimem gives today |
| **FTS AND → OR/quorum** | cost of the `buildFtsQuery` bug; value of the fix |
| **RRF vs weighted-sum** | does rank-fusion beat the scale-mismatched sum |
| weight sweep (0 / .3 / .5 / .7 / 1.0) | is a single 70/30 defensible; per-regime optimum |
| vector-only / BM25-only | which signal carries which dataset |

### Hypotheses P0 will confirm or kill
- **FTS AND→OR**: large win on ArguAna (long queries), ~neutral on SciFact (short).
- **BM25 wins SciFact, vectors win ArguAna** → quantifies the right hybrid weight.
- **RRF ≥ weighted-sum** (kills the cosine-vs-BM25 scale bug) → likely new default.

---

## Sequencing & risks
- **Parallel:** W1 ⟂ W2; W3 needs both; W4 builds against a fixture; W5 last.
- **Risks:** sqlite-vec/FTS5 must load (W3 asserts); `node-llama-cpp` for local
  embeddings (BM25-only smoke sidesteps it); 25k-file materialization perf (batch;
  defer SciDocs); `node:sqlite` experimental flag in the runner.

---

## knowledgeSearch / metadata patch (M1–M3)

**Broken:** cognitive-core calls only minimem `.search()`, hand-rolls domain/entity
tiers, defaults to Jaccard — so minimem's `domain/entities/minConfidence/knowledgeType`
filters and populated metadata columns go unused.

| Stage | Repo | Work | Gate |
|---|---|---|---|
| **M1 — minimem hardening** | minimem | Fix `knowledgeSearch`'s O(n) post-filter (it discards the chunk id then re-queries per result, `src/minimem.ts:1204`+) — push the metadata `WHERE` into the vector/FTS SQL join. Make `knowledgeSearch` first-class in the public surface. | **Now** — low-risk, parallel to P0/W2. |
| **M2 — bridge widening** | cognitive-core | Widen `MinimemSearchClient` + `MinimemSearchProvider` to expose `knowledgeSearch(query, {domain, entities, minConfidence, knowledgeType})`. | After M1. |
| **M3 — rewire `getRelevantKnowledge`** | cognitive-core | Replace hand-rolled tier-1 (domain file-read) / tier-2 (entity substring) with metadata-filtered minimem queries; pass `minConfidence` to drop stale notes. | **After P3 Layer-C evidence** decides the exact shape. |

M1 starts now (same flavor of change as W2); M2–M3 wait for the Layer-C A/B so the
rewiring is evidence-led.

---

## Task tracking
Workstreams are tracked as tasks **W1–W5** (P0) and **M1–M3** (patch). W1/W2/M1 are
the parallel starting set; W3→W4→W5 are sequential; M2/M3 are gated as above.
