# Contributions — supported, refuted, untested

Sorted by what the evidence actually carries. Per-claim threats live in
[`../docs/PAPER-PLANNING.md`](../docs/PAPER-PLANNING.md); this is the paper-facing summary.

## Supported

| # | claim | key evidence | n |
|---|---|---|---|
| S1 | **Access control belongs at generation time, not retrieval** | A **7.0 ±0.41, rank 1 of 43** with no ACL machinery; next best RAG-Policy 12.2. Mechanism: 302/727 privacy checkpoints expect `answer_redacted`, which requires possessing the record | n=3 |
| S2 | **Capability buys governance, not utility** | U *decreases* 85.4→79.4→77.8 (~12 sd) while A 19.8→6.6, F 10.5→0.9, over-refusal 2.3%→16.6%; monotonic on every axis; saturates at 5.5→5.6-sol | n=3/cell |
| S3 | **The primary metric cannot distinguish forgetting from silence** | deletion off + guard = **77.8 answer / 0.0 e2e**, content in context on 99.7% of safety checkpoints; only real deletion scores e2e (9.4) | n=1 → replicating |
| S4 | **Compression trades recall for synthesis** | recall 85.7 vs **98.0** (verbatim +12.2); synthesis **85.3** vs 79.4 (extraction +5.9); carried by `single-session-assistant` +38.2 and `multi-session` −20.6 | n=1 |
| S5 | **A shipped policy is unsatisfiable against its own labels** | nurse/pharmacist/scheduler in **zero** relationship facts; 49 utility checkpoints flip answer→refuse | data-verifiable |
| S6 | **Low leakage is judgment, not thin retrieval** | secret in context on **74.7%** of privacy checkpoints, leaked in **9.2%** of those; Long-Context holds 100%, leaks 19.3% | n=3, 4 domains |
| S7 | **Verifiable erasure is a compliance property** | only real deletion scores non-zero e2e (9.4 vs 0.0 for tombstone and no-deletion) | n=1 |

## Refuted — publish as such

| # | claim | what killed it |
|---|---|---|
| R1 | "File deletion makes forgetting true" (**minimem's own pitch**) | 2x2: constraint outweighs architecture ~20x on the reported metric (0.81 vs 5.68 delete; 0.00 vs 7.03 tombstone) |
| R2 | "Verbatim storage is better" | S4 — it is a trade, not a win |
| R3 | "Aggressive deletion improves utility" (earlier finding, n=28, 1 episode) | Tightening deletion recovered office **+15.6 U** and household **+16.3 U** at zero F cost |
| R4 | "A less compliant model scores higher under a misspecified policy" (**our prediction**) | It scored **lowest** (48.5 vs 61.6/56.5). Mechanism held, consequence did not |
| R5 | "Retrieval beats long-context on tokens" (GateMem) | We use ~2.4x MORE (3.05M vs 1.28M); episodes are only 7–8K tokens |
| R6 | "The graph layer carries the retrieval win" | Substrate +13.1/+42.7 vs graph +1.9/+1.2 (inside noise) |

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
  **decomposition** (a file store makes storage erasure verifiable, which is what lets
  storage and behavioural erasure be separated at all) and the quantification.
- **MemClaw (2606.24535) already names temporal supersession** and stale propagation. Our
  supersession findings are **measurement, not problem-identification**, and must cite it.
- Re-check prior art against **S1/S2/S3** specifically — the earlier search predated them.
