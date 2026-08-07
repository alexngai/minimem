# Contributions — supported, refuted, untested

Sorted by what the evidence actually carries. Per-claim threats live in
[`../docs/PAPER-PLANNING.md`](../docs/PAPER-PLANNING.md); this is the paper-facing summary.

> **Revised 2026-08-02 after the prior-art check.** Every supported claim was downgraded from
> *discovery* to *controlled demonstration*. The phenomena are largely known; the controls are
> ours. See [`prior-art-synthesis.md`](prior-art-synthesis.md) and the per-claim reports.
> **Nothing in the empirical record changed** — no measurement was contradicted.

## Supported

| # | claim | key evidence | n | prior art status |
|---|---|---|---|---|
| **S0** | **The retrieval substrate outperforms a deployed memory architecture, and the gap widens with scale** — *now the headline claim* | **+13.1pp BEAM-500K, +42.7pp LOCOMO** over the cognitive-core KB baseline; scale curve parity@100K → +14.7@500K → +23.2@1M; mechanism is KB log-dump truncation (~69% dropped at 1M) vs size-invariant focused retrieval; three-arm decomposition isolates it from the graph (+1.9/+1.2, inside noise) | mean-3 @BEAM; 300q @LOCOMO | **NOT CHECKED.** "Hybrid beats vector-only" is well established (see novelty constraints). The claim here is a *system result against a deployed baseline*, not a technique claim — but no search has been run. **Highest-priority gap now that this leads** |
| S1 | **Access control belongs at generation time, not retrieval** | A **7.0 ±0.41, rank 1 of 43** with no ACL machinery; next best RAG-Policy 12.2. Mechanism: 302/727 privacy checkpoints expect `answer_redacted`, which requires possessing the record | n=3 | **HEAVILY CONSTRAINED.** The prescription is pre-empted in RAG (2605.17034); the refuse-collapses-into-absent mechanism is pre-empted outright (2605.05379); the "filtering is counterproductive" form is **contradicted** by SD-RAG (2601.11199), which redacts at retrieval time. Survives: the possession *incompatibility*, and the A-metric rank against externally submitted methods. Must confront Harness-MU (2606.21856), which argues the opposite thesis |
| S2 | **Model generation buys governance, not utility** | U *decreases* 85.4→79.4→77.8 (~12 sd) while A 19.8→6.6, F 10.5→0.9, over-refusal 2.3%→16.6%; monotonic on every axis; saturates at 5.5→5.6-sol | n=3/cell | **PARTIAL.** GateMem's own finding (4) already reports the weak-backbone-high-utility observation. Survives: the retrieval-and-prompt-controlled isolation, over-refusal as the *cross-backbone* mechanism, the routing consequence. **Contradicts GateMem Table 3** (strongest model has highest utility there). Axis relabelled from "capability" — FalseReject (2505.08054) rules out parameter scale |
| S3 | **The primary metric cannot distinguish forgetting from silence** | deletion off + guard = **78.1 ±0.29 answer / 0.0 ±0.00 e2e** (+5.4, 6.1 sd), content retained on 99.7 ±0.00% of safety checkpoints; only real deletion scores e2e (9.2 ±0.22) | **n=3** | **PARTIAL, best-surviving.** The general form is published (2606.27379: metrics "reward surface-level non-disclosure"). Survives: demonstration on a *shipped leaderboard's primary metric* against the benchmark's own e2e variant, the quantification, and that retained content is directly observable rather than probe-inferred. MemLeak (2606.29788) is same-setting and must be cited |
| S4 | **Compression trades recall for synthesis** | recall 85.7 vs **98.0** (verbatim +12.2); synthesis **85.3** vs 79.4 (extraction +5.9); carried by `single-session-assistant` +38.2 and `multi-session` −20.6 | n=1 | close to a reproduction; see novelty constraints below |
| S5 | **A shipped policy is unsatisfiable against its own labels** | nurse/pharmacist/scheduler in **zero** relationship facts; 49 utility checkpoints flip answer→refuse | data-verifiable | **UNCHECKED against prior art.** No search was run for this claim. Likely clean, but that is an assumption |
| S6 | **Low leakage is judgment, not thin retrieval** | secret in context on **74.7%** of privacy checkpoints, leaked in **9.2%** of those; Long-Context holds 100%, leaks 19.3% | n=3, 4 domains | **CONTESTED.** CIMemories (2511.14937) measures this exact regime — retrieve broadly, let the model judge — and finds it fails at granular disclosure, up to 69% attribute-level violations. Our result is domain-limited; household is already the exception at 50.7% held |
| S7 | **Verifiable erasure is a compliance property** | only real deletion scores non-zero e2e (9.4 vs 0.0 for tombstone and no-deletion) | n=1 | MemLeak's record-level vs fact-level distinction is independent corroboration by a different method |

## Refuted — publish as such

| # | claim | what killed it |
|---|---|---|
| R1 | "File deletion makes forgetting true" (**minimem's own pitch**) | 2x2: constraint outweighs architecture ~20x on the reported metric (0.81 vs 5.68 delete; 0.00 vs 7.03 tombstone) |
| R2 | "Verbatim storage is better" | S4 — it is a trade, not a win |
| R3 | "Aggressive deletion improves utility" (earlier finding, n=28, 1 episode) | Tightening deletion recovered office **+15.6 U** and household **+16.3 U** at zero F cost |
| R4 | "A less compliant model scores higher under a misspecified policy" (**our prediction**) | It scored **lowest** (48.5 vs 61.6/56.5). Mechanism held, consequence did not |
| R5 | "Retrieval beats long-context on tokens" (GateMem) | We use ~2.4x MORE (3.05M vs 1.28M); episodes are only 7–8K tokens |
| R6 | "The graph layer carries the retrieval win" | Substrate +13.1/+42.7 vs graph +1.9/+1.2 (inside noise) |
| **R7** | **"S1/S2/S3 are novel findings"** (**our framing, held until today**) | **The prior-art check. All three are known phenomena; what is ours is the controls. This is the reframe, and it belongs in the paper as one of the self-corrections** |

## Untested — keep out

Git auditability, human editability, portability, multi-agent sharing. All plausible, none
measured. The WAL work validated four concurrent processes do not corrupt the index — that is
engineering validation, not a result. **Multi-agent is deprioritised**: no adoptable
benchmark exists (MemoryArena is multi-session single-agent; MemClaw's harness is not public),
and the concurrency problem is already formalised elsewhere (2606.17182).

## Novelty constraints

- **S4/R6 are close to reproductions.** Memanto (2604.22085), MemDelta (2606.29914),
  RAG-vs-GraphRAG (2502.11371), "Same Ranking, Different Winner" (2605.24060).
- **S7's general form is published** — "record deletion is insufficient" appears in
  2410.15267, 2607.27539, 2506.14576 — but attributed to *embedding residue* and *weight
  influence*, neither of which applies to a store rebuilt from files. What survives is the
  **decomposition** and the quantification.
- **MemClaw (2606.24535) already names temporal supersession** and stale propagation. Our
  supersession findings are **measurement, not problem-identification**, and must cite it.
- **S1/C3's novelty is provisional.** The declassification literature (Sabelfeld & Sands,
  CSFW 2005) was not readable with available tools. The *placement* question is twenty years
  old and the "where" dimension is prior framing. Requires a human read before submission.
- **S5 has never been prior-art checked.** The one supported claim with no search behind it.

## Required citations, by claim

Consolidated from the three reports. Everything below was READ unless marked.

| claim | must cite |
|---|---|
| S1 | 2605.05379 (Partial Evidence Bench), 2601.11199 (SD-RAG), 2606.21856 (Harness-MU), 2605.17034 (Zafar et al.), 2511.14937 (CIMemories), 2607.05318 (PiSAs) |
| S2 | 2606.18829 (GateMem, finding 4 + Table 3 + Fig. 3b), XSTest (NAACL 2024, *snippet*), 2405.20947 (OR-Bench), 2306.09479 (Inverse Scaling, *snippet*), 2606.14476, 2605.05427, 2605.22672, 2510.10452, 2505.08054 (FalseReject) |
| S3 | 2606.27379 (Overused), 2606.29788 (MemLeak), 2410.02879 (Weak Measures), 2505.16831 (*snippet, verify*) |

**Snippet-only entries must be fetched before they appear in a bibliography.** The three
reports each carry an explicit unverified list; none of those may be cited as-is.
