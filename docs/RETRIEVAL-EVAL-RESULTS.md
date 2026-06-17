# minimem Retrieval Eval — Results & Findings

> Empirical record from running the harness. Design: [RETRIEVAL-EVAL.md](RETRIEVAL-EVAL.md);
> plan: [RETRIEVAL-EVAL-P0.md](RETRIEVAL-EVAL-P0.md). Date: 2026-06-16, branch `eval`.
> Corpora: real BEIR (SciFact, NFCorpus, ArguAna). Vector configs use local
> **embeddinggemma-300M** (Q8_0, 768-dim) via sqlite-vec; BM25 via FTS5; the
> Jaccard baseline replicates cognitive-core's default `textSimilarity`.

## TL;DR

- **Best config: `hybrid-rrf` — 0.729 nDCG@10 on SciFact.** Ordering: **RRF > weighted-sum > pure-vector > BM25-OR > Jaccard**; every layer adds value.
- The eval's highest-value output was **4 real minimem bugs found and fixed** (plus one default change) — see §1. These were silently degrading retrieval for *all* users, not just the eval.
- minimem's BM25 and (post-fix) hybrid now **match published BEIR baselines**, so the harness is trustworthy.

---

## 1. Bugs found & fixed (the highest-value outcome)

The harness surfaced these by **hard-failing instead of silently degrading**. All are committed with tests.

| # | Bug | Symptom | Fix | Impact | Commit |
|---|---|---|---|---|---|
| 1 | **`bm25RankToScore` inverted** | `1/(1+\|rank\|)` scored the *strongest* BM25 matches *lowest*, so weighted-hybrid & pure-BM25 ranking was near-random | monotonic `\|rank\|/(1+\|rank\|)` | SciFact BM25 nDCG@10 **0.003 → 0.656** | `b52c006` |
| 2 | **BM25 not normalized vs cosine** | raw BM25 magnitudes aren't comparable to cosine, so the fixed `minScore: 0.3` over-filtered legit matches | max-normalize BM25 within the result set | restores threshold + fusion sanity (fixed a failing auto-fallback test) | `b52c006` |
| 3 | **sqlite-vec never loaded** | `DatabaseSync` opened without `allowExtension`, so `enableLoadExtension()` throws → **vector search silently fell back to brute-force JS cosine for every node:sqlite user** | open with `{ allowExtension: true }` | `vectorAvailable: true`; vector search uses sqlite-vec (verified `chunks_vec` populated) | `f3e4d2a` |
| 4 | **`search()` O(files) stat per query** | with `watch` off, `isStale()` `stat`s every memory file on *each* query (~3.1M stats over a SciFact run) | `skipStaleCheck` option for batch callers | SciFact BM25 run **10:13 → 2:47** | `b52c006` |
| + | **`ftsQueryMode` default `and`→`or`** | AND-join collapses recall on multi-term/NL queries | default to `or` (callers can opt into `and`) | see §3 (AND→OR) | `0d3a5fe` |

---

## 2. Results

### 2a. BM25-only baselines — 3 real BEIR datasets (match published BM25)

| Dataset | queries | bm25-only-and | **bm25-only-or** | published BM25 (nDCG@10) |
|---|---|---|---|---|
| SciFact | 300 | 0.017 | **0.656** | ~0.665 |
| NFCorpus | 323 | 0.192 | **0.300** | ~0.325 |
| ArguAna | 1406 | 0.000 | **0.356** | ~0.31–0.40 |

*(`evals/results/{scifact,nfcorpus,arguana}-bm25.{md,json}`)*

### 2b. SciFact full matrix (local embeddinggemma-300M)

| config | nDCG@10 | Recall@10 | MRR@10 | Δ vs jaccard |
|---|---|---|---|---|
| jaccard (lexical baseline) | 0.278 | 0.390 | 0.244 | — |
| bm25-only-and | 0.017 | 0.017 | 0.017 | −26.1pp |
| bm25-only-or | 0.656 | 0.780 | 0.624 | +37.9pp |
| vector-only | 0.702 | 0.833 | 0.668 | +42.4pp |
| hybrid-weighted-70-30 | 0.719 | 0.830 | 0.689 | +44.2pp |
| **hybrid-rrf** | **0.729** | **0.847** | **0.698** | **+45.2pp** |
| hybrid-rrf-or | 0.729 | 0.847 | 0.698 | +45.2pp |

*(`evals/results/scifact-full.{md,json}`; 18,305 chunks / 5,183 docs ≈ 3.5 chunks/doc)*

---

## 3. Findings (hypotheses → confirmed)

- **RRF beats weighted-sum fusion** (0.729 vs 0.719) — confirms the spec's hypothesis, and RRF sidesteps the cosine-vs-BM25 scale problem entirely. **Recommend RRF as the default fusion.**
- **Vector > BM25 on SciFact** (0.702 vs 0.656) — semantic matching helps on scientific-claim retrieval.
- **Hybrid > either signal alone** — each layer (lexical → BM25 → vector → hybrid → RRF) is monotonically better.
- **FTS `AND`→`OR` is critical, and the effect scales with query length:** AND degrades to ~0 as queries get longer — ArguAna (full-paragraph queries) **AND 0.000 vs OR 0.356**; SciFact (claims) **0.017 vs 0.656**; NFCorpus (short terms) **0.192 vs 0.300**. OR is now the default.
- `hybrid-rrf` == `hybrid-rrf-or` (both 0.729) — a consistency check confirming the `or` default took effect.
- `bm25-only-and` (0.017 / 0.000) is the broken-AND artifact (now non-default); kept in the matrix to quantify the FTS-mode effect.

---

## 4. Operational notes & lessons

- **Metal is healthy** — standalone embeddinggemma reports `gpu = metal`, 25 layers, **147 embeds/sec**. An earlier apparent "Metal wedge" was a *misdiagnosis*: the real cause was a single long-lived worker that had been repeatedly killed/suspended across Metal-crash aborts and session restarts degrading to CPU *within that process*. A fresh process runs at full speed.
- **Run long jobs under `tmux` + `caffeinate` from the start** (independent server survives Claude restarts; no idle-sleep). Don't let the worker get repeatedly killed/suspended.
- **Resumability works:** persistent `--memory-dir` caches embeddings (content-hash) and a per-config checkpoint skips finished configs — a killed run resumes cheaply. Validated against multiple real session restarts.
- **Local embedding is sequential** (`getEmbeddingFor` one text at a time) — fine on Metal for small corpora, but the dominant cost on large ones. **Follow-up:** batch embedding in the local provider would speed local runs substantially.
- Embeddings are computed once and cached; the per-query search side dominates wall-clock on large/long-query corpora (e.g., ArguAna's 1,406 queries).

---

## 5. Validated vs open

**Validated:** SciFact full vector/hybrid matrix; BM25 baselines on 3 datasets; all 4 fixes (unit + integration tests + real runs).

**Open / next:**
- NFCorpus + ArguAna **full** (vector/hybrid) matrices — feasible unattended via the tmux + resumable setup; ArguAna is the slow one on local embedding.
- **Local-embed batching** optimization (above).
- **M2/M3** — wire cognitive-core to call minimem's `knowledgeSearch` (parked; cognitive-core under active development).

---

## 6. Reproduce

```bash
# BM25-only (free; downloads BEIR on first run)
npm run eval -- --dataset scifact --bm25-only --json evals/results/scifact-bm25.json

# Full matrix with local embeddings (resumable; run under tmux for long jobs)
tmux new-session -d -s mmeval 'caffeinate -i npm run eval --silent -- \
  --dataset scifact --embedding local \
  --memory-dir evals/.eval-cache/scifact --json evals/results/scifact-full.json \
  > evals/results/scifact-full.md 2> evals/results/scifact-full.log'
# re-running the SAME command resumes (skips finished configs, reuses cached embeddings)

npm run eval:ci        # offline regression gate (BM25-only matrix on the fixture)
```

---

## 7. Commit trail (branch `eval`)

| Commit | What |
|---|---|
| `5a6f79e` | eval design spec + P0 plan |
| `b52c006` | hybrid ranking fixes (bm25 inversion, normalization), config (ftsQueryMode/fusion/RRF), knowledgeSearch SQL pushdown, skipStaleCheck |
| `990e6a4` | eval harness + BM25 baselines + scripts |
| `8a4df90` | ArguAna BM25 baseline |
| `0d3a5fe` | default `ftsQueryMode` to `or` |
| `f3e4d2a` | enable sqlite-vec (`allowExtension`) |
| `4b48dc7` | CLI `--embedding` colon parsing |
| `2d888bc` | resumable runs (persistent `--memory-dir` + checkpoint) |
| `36f20d8` | SciFact full-matrix results |
