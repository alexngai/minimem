# Thesis

> **Defer commitment.** Keep agent memory as plain files and make every derived artifact — the
> index, the structure, the extraction, the access decision — disposable and late-bound. A
> system built this way outperforms architectures that commit at write time, and it makes
> governance properties measurable that other substrates cannot separate.

Reframed 2026-08-02, twice. First after the prior-art check
([`prior-art-synthesis.md`](prior-art-synthesis.md)), then to a **constructive systems framing**
after review. The evaluation findings are retained as caveats and reporting discipline in the
discussion, not as headlines.

## Why this framing rather than the critique

The prior-art check found that the *phenomena* behind our evaluation claims are largely
published: enforcement-at-output-composition (2605.17034), refuse-collapsing-into-absent
(2605.05379), backbone trades governance for utility (GateMem's own finding 4), output metrics
rewarding non-disclosure (2606.27379), policy preconditions absent from context (2604.12177).

Pre-emption damages a *findings* paper far more than a *systems* paper. "We discovered that
enforcement belongs at generation time" collides with Zafar et al. and is disputed by Harness-MU
(2606.21856). "We built a system that governs at generation time and it reaches A = 7.0, rank 1
of 43" collides with nothing — those become comparison points. The system is what we have that
nobody else does.

## The four commitments we refuse, and what each buys

**1. No committed index. → The retrieval substrate, and the largest result in this work.**
Markdown files are the source of truth; the SQLite index (sqlite-vec + FTS5, hybrid RRF) is
disposable and rebuilt from them. Routing retrieval through focused hybrid search instead of a
dump-the-observation-log knowledge bank gives **+13.1pp on BEAM-500K and +42.7pp on LOCOMO**,
and the gap **widens with scale**: parity at 100K, +14.7 at 500K, +23.2 at 1M. The mechanism is
legible — the KB's log dump truncates (~69% of observations dropped at 1M) while focused
retrieval is invariant to store size. A three-arm decomposition isolates this from the graph
layer, which contributes only +1.9/+1.2, inside noise.

**2. No write-time extraction. → A representation trade you keep the option on.**
Under control (same adapter, retrieval, prompt, answer model, judge; only the observation cache
differs) verbatim storage wins recall by **12.2** and loses synthesis by **5.9**. Neither
representation dominates. That is the argument for *not extracting at write time*: the winning
representation is task-dependent, and extraction is irreversible. Keep the turns and derive
late. This also explains GateMem's extraction collapse (24.4 vs 59.1) as one side of a
two-sided trade rather than a verdict.

**3. No retrieval-time access decision. → Governance at generation.**
Retrieve broadly and let the model judge disclosure: **A = 7.0 ±0.41, rank 1 of 43**, ahead of
RAG-Policy (12.2), with no access-control machinery. The mechanism is that 302 of 727 privacy
checkpoints expect `answer_redacted`, which requires *possessing* the record. Low leakage is
judgment rather than thin retrieval: the secret is in our context on 74.7% of privacy
checkpoints and leaks on 9.2% of those, against Long-Context holding 100% and leaking 19.3%.

**4. No derived store. → Erasure that can be verified by inspection.**
Because files are the store, deletion is auditable by reading the directory, and that is what
makes storage erasure separable from behavioural erasure at all — in a vector store you cannot
tell residue from reconstruction. The 2×2 over storage (delete / tombstone) × constraint (on /
off) shows the generation-time constraint outweighs the storage mechanism ~20× on the reported
metric, while real deletion is the only configuration scoring non-zero end-to-end (9.4 vs 0.0).
**Verifiable erasure is a compliance property, not a behavioural one.**

## What this costs, stated up front

Under comparable configurations the system is **not** state of the art: 3rd of 43 on GateMem
(62.7 ±1.18 vs 69.5), ~5pp short on BEAM, −1.9 on LongMemEval. A prior systematic push to close
those gaps found every lever inside the noise band. The substrate result is measured against a
single baseline. Deferring commitment costs tokens: on GateMem we use ~2.4× more than
long-context (3.05M vs 1.28M), because those episodes are only 7–8K tokens and retrieval has
nothing to save.

## Discussion — caveats on interpretation

Not headlines. These bound how the results above should be read, and one of them becomes a
reporting rule the paper follows throughout.

**Report both scoring axes, always.** `compliance_utility_score` grades the final answer, so it
is satisfied by retaining everything and refusing: deletion off plus the constraint scores
**77.8 answer / 0.0 end-to-end**, with content still in context on 99.7% of safety checkpoints.
We verified this by running the configuration. Consequently every governance number in this
paper is reported on both axes, and the configuration we advocate (delete + constraint, 72.6
answer / 9.4 e2e) is the only arm scoring non-zero on both. It is defensible rather than merely
best.

**Recall-only grading does not generalise.** See commitment 2. A benchmark grading exact recall
measures one side of the representation trade.

**One shipped policy is unsatisfiable against its own labels.** GateMem's medical policy
requires assignment; nurse, pharmacist and scheduler appear in zero relationship facts, and 49
utility checkpoints flip answer→refuse. This bounds achievable utility for every system on that
domain, ours included. Mechanism attributable to Wu & Gong (2604.12177).

**Backbone choice is a confound, and we treat it as a robustness check.** Holding retrieval and
prompt fixed, utility decreases across model generations (85.4 → 79.4 → 77.8) while governance
improves (A 19.8 → 6.6) and over-refusal climbs (2.3% → 16.6%). The axis is model *generation*,
not parameter scale — FalseReject (2505.08054) rules the latter out.

**Judge mismatch.** Every benchmark judges with a different model than its reference. Deltas
between our arms are sound; absolutes are not leaderboard-exact.

## Refuted, and kept

Three results contradict claims we held. R1: file deletion does not make forgetting true, which
was minimem's own pitch. R2: verbatim storage is not simply better, it is a trade. R4: we
predicted a less compliant model would score higher under a misspecified policy; it scored
lowest. Keeping these is what makes the rest credible.

## Frame

1. **Introduction** — defer commitment; the four refusals.
2. **Related work** — memory architectures, retrieval substrates, governance benchmarks,
   unlearning evaluation. Where the prior-art concessions are made.
3. **System** — files as source of truth, disposable index, hybrid RRF, no write-time
   extraction, generation-time governance.
4. **Retrieval** — commitment 1. The substrate result and the scale curve. **Figure: scale.**
5. **Representation** — commitment 2. The controlled trade. **Table: per-category.**
6. **Governance** — commitments 3 and 4. A-rank, the leakage-given-exposure analysis, the
   erasure 2×2, both axes throughout. **Figure: 2×2.**
7. **Discussion** — the caveats above, backbone robustness, threats, the instrumentation note.
8. **Conclusion** — what to build.
