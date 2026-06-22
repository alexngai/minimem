# minimem Retrieval Eval — Results & Findings

> Empirical record from running the harness. Design: [RETRIEVAL-EVAL.md](RETRIEVAL-EVAL.md);
> plan: [RETRIEVAL-EVAL-P0.md](RETRIEVAL-EVAL-P0.md). Dates: 2026-06-16 (embeddinggemma) → 2026-06-22
> (Bedrock cross-model), branch `eval`. Corpora: real BEIR (SciFact, NFCorpus, ArguAna). BM25 via
> FTS5; the Jaccard baseline replicates cognitive-core's default `textSimilarity`. Vector configs run
> two embedding models: local **embeddinggemma-300M** (Q8_0, 768-dim) and **Amazon Titan Text v2**
> (1024-dim, served via a local LiteLLM→Bedrock gateway) — see §2c for the cross-model comparison.
>
> **Note:** the embeddinggemma numbers were first produced by the original native harness (since
> retired) and **reproduced exactly through swarmkit-eval** (every arm matches to 3 decimals) — see
> `evals/results/scifact-full-swarmkit.{md,json}`, with per-arm CIs, paired Δ-vs-jaccard significance,
> and the k=1/5/10/20 sweep.

## TL;DR

- **`hybrid-rrf` is the best config on all 3 datasets and both embedding models** (SciFact 0.729 embeddinggemma / 0.714 Titan, NFCorpus 0.352, ArguAna 0.394 nDCG@10). Ordering: **RRF ≥ pure-vector > BM25-OR > Jaccard**.
- **Weighted-sum fusion is fragile across embedding models** — it *helped* on embeddinggemma (SciFact 0.719) but *collapsed* on Titan (0.533, below even pure-vector/BM25), on all 3 datasets. RRF is rank-based and scale-invariant, so it stays robust. This is the decisive, data-backed case for the RRF default (§3).
- The eval's highest-value output is **5 real minimem bugs/perf fixes** (plus embedding-pipeline hardening) — see §1. All silently degraded retrieval for *every* user, not just the eval. The standout: **vector search was an O(N) brute-force scan, not sqlite-vec KNN — ~6,500ms → ~50ms/query (~100×) on an 18k-chunk corpus.**
- minimem's BM25 and (post-fix) hybrid **match published BEIR baselines**, so the harness is trustworthy.

---

## 1. Bugs found & fixed (the highest-value outcome)

The harness surfaced these by **hard-failing instead of silently degrading**. All are committed with tests.

| # | Bug | Symptom | Fix | Impact | Commit |
|---|---|---|---|---|---|
| 1 | **`bm25RankToScore` inverted** | `1/(1+\|rank\|)` scored the *strongest* BM25 matches *lowest*, so weighted-hybrid & pure-BM25 ranking was near-random | monotonic `\|rank\|/(1+\|rank\|)` | SciFact BM25 nDCG@10 **0.003 → 0.656** | `b52c006` |
| 2 | **BM25 not normalized vs cosine** | raw BM25 magnitudes aren't comparable to cosine, so the fixed `minScore: 0.3` over-filtered legit matches | max-normalize BM25 within the result set | restores threshold + fusion sanity (fixed a failing auto-fallback test) | `b52c006` |
| 3 | **sqlite-vec never loaded** | `DatabaseSync` opened without `allowExtension`, so `enableLoadExtension()` throws → **vector search silently fell back to brute-force JS cosine for every node:sqlite user** | open with `{ allowExtension: true }` | `vectorAvailable: true`; vector search uses sqlite-vec (verified `chunks_vec` populated) | `f3e4d2a` |
| 4 | **`search()` O(files) stat per query** | with `watch` off, `isStale()` `stat`s every memory file on *each* query (~3.1M stats over a SciFact run) | `skipStaleCheck` option for batch callers | SciFact BM25 run **10:13 → 2:47** | `b52c006` |
| 5 | **vector search was O(N) brute-force, not KNN** | even with sqlite-vec loaded, the query scored *every* row with a scalar `vec_distance_cosine()` over a JOIN (`ORDER BY dist LIMIT`) instead of using the vec0 KNN index — invisible on tiny unit-test corpora | use `embedding MATCH ? AND k = ?` for unfiltered search; keep the scalar scan only for (small) knowledge-filtered sets | **~6,500ms → ~50ms/query (~100×)** on an 18,305-chunk corpus | `(this batch)` |
| + | **`ftsQueryMode` default `and`→`or`** | AND-join collapses recall on multi-term/NL queries | default to `or` (callers can opt into `and`) | see §3 (AND→OR) | `0d3a5fe` |
| + | **embedding pipeline brittle/slow on remote** | corpus + per-query embeds were single-flight (~1.5/s); one transient 429/`fetch failed` aborted a whole index build; no resume | bounded-concurrency corpus pre-warm; resilient retry (8 attempts, jittered backoff, honor `Retry-After`) on *both* corpus and query paths; content-hash cache for query vectors; persistent resumable index dir | remote eval went from *never completing* to reliable; see §4 | `(this batch)` |

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

### 2c. Full matrix across all 3 datasets — Amazon Titan Text v2 (Bedrock)

Same arms, embeddings from **Titan Text v2** (1024-dim) via a local LiteLLM→Bedrock gateway. nDCG@10:

| config | SciFact | NFCorpus | ArguAna |
|---|--:|--:|--:|
| jaccard (lexical baseline) | 0.278 | 0.179 | 0.250 |
| bm25-only-and | 0.017 | 0.192 | 0.000 |
| bm25-only-or | 0.656 | 0.300 | 0.356 |
| vector-only | 0.709 | 0.348 | 0.376 |
| hybrid-weighted-70-30 | 0.533 ⚠ | 0.235 ⚠ | 0.312 ⚠ |
| **hybrid-rrf** | **0.714** | **0.352** | **0.394** |
| hybrid-rrf-or | 0.714 | 0.352 | 0.394 |

*(`evals/results/{scifact,nfcorpus,arguana}-titan-swarmkit.{md,json}`; n = 300 / 323 / 1406 queries.
⚠ = weighted-sum below pure-vector and BM25-OR — see §3.)*

**Cross-model (SciFact): RRF is robust, weighted-sum is not.**

| config | embeddinggemma (768-d) | Titan v2 (1024-d) | Δ |
|---|--:|--:|--:|
| vector-only | 0.702 | 0.709 | +0.007 |
| **hybrid-rrf** | **0.729** | **0.714** | −0.015 |
| hybrid-weighted-70-30 | 0.719 | **0.533** | **−0.186** |

---

## 3. Findings (hypotheses → confirmed)

- **RRF is the best (or tied-best) fusion on every dataset and both embedding models** — SciFact 0.729/0.714, NFCorpus 0.352, ArguAna 0.394. **✅ Applied: RRF is the default fusion** (`hybrid.fusion` default `"rrf"`); raw RRF scores are max-normalized within the result set so the `minScore` threshold stays meaningful.
- **Weighted-sum fusion is fragile across embedding models — the strongest argument for the RRF default.** Weighted-70/30 *helped* on embeddinggemma (SciFact 0.719 > vector 0.702) but *collapsed* on Titan (0.533, **below** both pure-vector 0.709 and BM25-OR 0.656), and underperforms on all 3 Titan datasets (§2c). Weighted-sum mixes max-normalized cosine + BM25, so it depends on the absolute cosine-score distribution, which differs per model (Titan's normalized embeddings cluster cosines differently). RRF is **rank-based and scale-invariant**, so it sidesteps this entirely — hence robust across models.
- **Vector > BM25 on all 3 datasets** (e.g. SciFact 0.709 vs 0.656, NFCorpus 0.348 vs 0.300, ArguAna 0.376 vs 0.356 on Titan) — semantic matching helps; the lift is largest on SciFact (scientific claims).
- **Hybrid-RRF ≥ either signal alone** — RRF adds a small but consistent lift over pure vector (e.g. ArguAna +0.018), and never underperforms a component (unlike weighted-sum).
- **FTS `AND`→`OR` is critical, and the effect scales with query length:** AND degrades to ~0 as queries get longer — ArguAna (full-paragraph queries) **AND 0.000 vs OR 0.356**; SciFact (claims) **0.017 vs 0.656**; NFCorpus (short terms) **0.192 vs 0.300**. OR is now the default.
- `hybrid-rrf` == `hybrid-rrf-or` (both 0.729) — a consistency check confirming the `or` default took effect.
- `bm25-only-and` (0.017 / 0.000) is the broken-AND artifact (now non-default); kept in the matrix to quantify the FTS-mode effect.

---

## 4. Operational notes & lessons

- **Metal is healthy** — standalone embeddinggemma reports `gpu = metal`, 25 layers, **147 embeds/sec**. An earlier apparent "Metal wedge" was a *misdiagnosis*: the real cause was a single long-lived worker that had been repeatedly killed/suspended across Metal-crash aborts and session restarts degrading to CPU *within that process*. A fresh process runs at full speed.
- **Run long jobs under `tmux` + `caffeinate` from the start** (independent server survives Claude restarts; no idle-sleep). Don't let the worker get repeatedly killed/suspended.
- **Resumability works:** persistent `--memory-dir` caches embeddings (content-hash) and a per-config checkpoint skips finished configs — a killed run resumes cheaply. Validated against multiple real session restarts.
- **Local embedding is sequential** (`getEmbeddingFor` one text at a time) — fine on Metal for small corpora, but the dominant cost on large ones. **Follow-up:** batch embedding in the local provider would speed local runs substantially.
- **The per-query search cost was a bug, not a law.** It "dominated wall-clock" because vector search was an O(N) scalar scan — now ~100× faster via the vec0 KNN index (§1 #5). With that fixed, sequential *query embedding* is the remaining per-query cost on remote endpoints (now cached + concurrent for the corpus; queries still embed one-at-a-time in `runQueries`).
- **Remote endpoints work, but mind the provider's rate limit.** Bedrock Titan v2 in this account caps ~600 emb/min; bursting past it triggers 429 storms. The fix was client-side resilience (concurrency 3 + jittered retry + `Retry-After`) plus a **persistent, resumable** embedding cache — so the one-time corpus embedding survives throttling/crashes instead of restarting. Config (`evals/swarmkit/litellm.bedrock.yaml`) signs SigV4 from `~/.aws` — no secrets in-repo. For a faster machine-independent option, see `evals/swarmkit/EMBEDDING-ENDPOINTS.md` (Modal-TEI).
- **Eval throughput optimizations:** BM25/jaccard arms index with `provider: "none"` (they never read vectors); the 4 vector arms **share one per-dataset index** (embed the corpus 1×, not 4×) via a persistent dir + serial resource builds.

---

## 5. Validated vs open

**Validated:** full vector/hybrid matrices on **all 3 datasets × 2 embedding models** (SciFact embeddinggemma + Titan; NFCorpus + ArguAna Titan); BM25 baselines on 3 datasets; all 5 fixes + embedding hardening (unit + integration + `eval:ci` tests, 383 unit pass, + real runs).

**Open / next:**
- **Concurrent query embedding in `runQueries`** — the corpus path is concurrent, but queries still embed one-at-a-time (the slow part of a remote run now; ~12min for ArguAna's 1,406 first-pass query embeds). Easy eval-side win.
- **NFCorpus + ArguAna on embeddinggemma** — only Titan was run for these (the cross-model deltas already hold); a local-embeddinggemma pass would complete the symmetric grid.
- **`Retry-After` is now honored** but minimem could also adopt **adaptive concurrency** (back off globally on sustained 429s) for hands-off remote runs.
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

```bash
# Full matrix on a remote OpenAI-compatible endpoint (here: Bedrock Titan via LiteLLM).
# Embeds the corpus once into a persistent, resumable cache; concurrency 3 stays under the TPS cap.
litellm --config evals/swarmkit/litellm.bedrock.yaml --port 4000 &   # SigV4 from ~/.aws
OPENAI_API_KEY=sk-local MM_EMBED_CONCURRENCY=3 npm run eval -- \
  --dataset arguana --embedding openai:titan-embed-v2 --base-url http://localhost:4000/v1 \
  --ks 1,5,10,20 --out evals/results/arguana-titan-swarmkit.md --json evals/results/arguana-titan-swarmkit.json
# A throttled/crashed run resumes for free (persistent .eval-cache/beir-vec-shared/<dataset>-<model>).
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
| `(this batch)` | **vec0 KNN search (~100×)**; concurrent + retry-hardened + cached embedding (corpus & query); persistent resumable shared index; Bedrock/LiteLLM config; Titan cross-model matrices (SciFact/NFCorpus/ArguAna) |
