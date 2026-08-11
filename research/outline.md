# Outline

Section-by-section, with the specific evidence and figure each part carries. Numbers here
are the verified ones; anything unresolved is marked ⏳.

> **Venue is an open decision and it changes the shape.** Sections are marked **[core]**
> (survives a 4-page workshop cut) or **[full]** (needs 8–9pp). Written assuming a general
> ML/NLP venue; a systems or privacy venue would reorder §3 and §4.

---

## Title candidates

1. *Memory Governance Is a Generation-Time Problem* — leads with the systems claim
2. *What Memory Benchmarks Measure When They Measure Forgetting* — leads with the critique
3. *Forgetting Without Erasing: What Agent-Memory Benchmarks Actually Score* — leads with the
   sharpest single result

Prefer 3 if the metric finding is the headline; 1 if the design finding is.

## Abstract (draft)

> Agent memory systems are increasingly evaluated on governance — whether they answer the
> right principal, redact the right detail, and forget on request. We evaluate a file-based
> memory system across four benchmarks and report two sets of findings, one about systems
> and one about their evaluation. On systems: access control is best implemented at
> generation time rather than as a retrieval filter, reaching the lowest access-control
> violation rate on the GateMem leaderboard (7.0%, rank 1 of 43) with no access-control
> machinery, because 302 of 727 privacy checkpoints require *possessing* a record in order
> to redact it. Structural deletion, by contrast, contributes little to behavioural
> forgetting: in a 2×2 over storage mechanism and generation-time constraint, the constraint
> outweighs the architecture roughly twentyfold. And across three backbones on identical
> retrieval, utility *decreases* monotonically with model capability while governance
> improves — capability buys caution, not competence. On evaluation: the benchmark's primary
> metric grades the final answer, so a system that deletes nothing and refuses instead scores
> best (77.8) while scoring zero on the benchmark's own end-to-end variant, with deleted
> content present in context on 99.7% of safety checkpoints. Separately, a shipped access
> policy is unsatisfiable against its own labels, flipping 49 utility checkpoints to refusal;
> and recall-only grading turns a two-sided representation trade (−12.2 recall for +5.9
> synthesis) into an apparent law. Several findings contradict our own system's design
> claims.

*Weak spots in this draft: it's long, and "two sets of findings" is a hedge — a stronger
version commits to the evaluation critique and demotes the systems results to evidence.*

---

## §1 Introduction **[core]**

Frame: governance evaluation is new, growing, and the metrics are load-bearing for claims
people are already making. Our contribution is that several of those claims don't survive a
control.

Land the three-sentence version of the thesis, then preview the self-undermining results —
that's what buys attention early.

## §2 Setup **[core]**

- Benchmarks: GateMem (multi-principal governance, MGS = U×(1−A)×(1−F)), LongMemEval_S,
  BEAM, LOCOMO. One paragraph each, with what each *grades*.
- System under test: Markdown files as source of truth, disposable SQLite index
  (sqlite-vec + FTS5), hybrid RRF retrieval, no write-time extraction.
- **Competence evidence, not the claim**: **55.1 ±0.29 comparable on GateMem under the matched
  `gpt-4o` judge** (62.7 ±1.18 under gpt-4.1; rank withdrawn — see RESULTS.md),
  93.0% LongMemEval (Mastra 94.87%), 72.7% BEAM-500K, 79.3% LOCOMO.
- **State the judge mismatch here, not in limitations.** Every benchmark uses a different
  judge from its reference. Inter-arm deltas are sound; absolutes are not leaderboard-exact.

## §3 Governance is a generation-time property **[core]**

**§3.1 Access control belongs at generation time.**
The structural argument first: 302/727 privacy checkpoints expect `answer_redacted`, which
requires possessing the record. A retrieval filter leaves nothing to redact *and* collapses
`refuse` into `no_memory`. Then the result: **A = 7.0 ±0.41, rank 1 of 43**, next best
RAG-Policy 12.2 — a system built around a policy layer.
→ **Table 1**: A across leaderboard methods, ours highlighted.

**§3.2 Low leakage is judgment, not thin retrieval.**
The deflationary explanation, measured and rejected: the secret is in our prompt context on
**74.7%** of privacy checkpoints and leaks in **9.2%** of those; Long-Context holds it 100%
and leaks 19.3%. Household is the honest exception at 50.7% held.

**§3.3 Storage erasure is not the forgetting mechanism.** **[full]**
The 2×2. Constraint ~20× the architecture on the reported metric.
→ **Figure 1**: 2×2 heat/bar — delete vs tombstone × guard on/off.

**§3.4 Capability buys governance, not utility.**
Monotonic across three backbones on identical retrieval. The weakest model is the most
*useful*. Saturates at the top.
→ **Figure 2** (strongest visual): U, A, F, over-refusal vs backbone. U slopes *down* while
A and F slope down too — the crossing story in one panel.

## §4 What the benchmarks measure **[core]**

**§4.1 The primary metric cannot distinguish forgetting from silence.**
Deleting nothing is optimal (78.1 ±0.29 gpt-4.1 / **71.9 matched**, +2.4 over SOTA) and scores 0.0 e2e; content in context on
99.7% of safety checkpoints. Only real deletion scores e2e (9.4).
→ **Figure 3**: paired bars, MGS answer vs MGS e2e, three configs. The 77.8/0.0 pair is the
paper's single most legible image.
Frame as: *a system can climb this leaderboard by not forgetting* — and note we found it by
trying to optimise, not by looking for it.

**§4.2 Recall-only grading turns a trade into a law.**
−12.2 recall / +5.9 synthesis, controlled (same adapter, retrieval, prompt, judge; only the
observation cache differs). Carried by `single-session-assistant` +38.2 and `multi-session`
−20.6.
→ **Table 2**: per-category, both arms.
This *explains* the GateMem extraction collapse (24.4 vs 59.1) rather than contradicting it.
⏳ budget control (verbatim at coverage-matched k=32) still running — needed before quoting
the exchange rate; the two category effects stand without it.

**§4.3 A shipped policy is unsatisfiable against its own labels.** **[full]**
Medical policy requires assignment; nurse (0/33), pharmacist (0/23), scheduler (0/42) appear
in zero relationship facts. 49 utility checkpoints flip answer→refuse.
→ **Table 3**: role × in-scaffold × refused.
Verifiable from released data alone — the one claim needing no run of ours.

## §5 Threats **[core]**

Judge mismatch (§2), n per claim, the ~10-point prompt contribution to the tuned GateMem
figure, scale selection (GateMem episodes are 7–8K tokens, so Long-Context is a no-retrieval
oracle). Keep the refuted-prediction table here or in §6 — it reads as strength, not weakness.

## §6 Implications **[core]**

- **Build**: govern at generation time; don't filter retrieval; expect capability to buy
  caution, so serve retrieval-QA cheaply and governance expensively.
- **Measure**: report answer-level *and* end-to-end; grade both recall and synthesis or say
  which you're grading; check policies are satisfiable against your own labels.
- **Stop claiming**: that structural deletion produces forgetting.

---

## Figure/table inventory

| # | content | source | status |
|---|---|---|---|
| F1 | 2×2 erasure: storage × constraint | `gm-{hybrid,del-ng,tomb,tomb-ng}` | ready |
| F2 | capability curve, U/A/F/over-refusal × 3 backbones | `gm-{weak2,weak-r2,weak-r3,hybrid*,sol*}` | ready |
| F3 | MGS answer vs e2e, 3 configs | `gm-{nodelguard,hybrid,tomb}` | ready (⏳ n=1 → 3) |
| T1 | access-control violation across leaderboard | `docs/assets/leaderboard.json` + ours | ready |
| T2 | C1 per-category, both arms | `evals/longmemeval/results/c1-*.json` | ready |
| T3 | unsatisfiable policy: role × scaffold × refusals | GateMem checkpoints | ready |
| T4 | refuted predictions (ours and the field's) | `contributions.md` | ready |

## Can't be written yet

- Exchange-rate sentence in §4.2 → needs the budget control.
- §4.1's headline as a *replicated* number → needs S3 at n=3.
- Any leaderboard-exact absolute → needs judge-matched runs (blocking, see
  `open-before-submission.md`).
