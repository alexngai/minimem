# Thesis

> **Memory governance is a generation-time problem, not a storage problem — and the
> benchmarks that measure it largely cannot tell the difference.**

Two halves that reinforce each other. The first is about systems: the things practitioners
build into the *substrate* (access-control filters, structural deletion, richer memory
representations) do far less than expected, while the decision made at answer time does far
more. The second is about evaluation: the benchmarks scoring this reward behaviours that are
not what they claim to measure, and we can show that from their own metrics.

The second half is what makes it publishable. The first half alone is a system paper we
would lose on numbers.

## Why not a system paper

Under comparable configurations we are 3rd of 43 on GateMem (62.7 vs 69.5), ~5pp short on
BEAM, and −1.9 on LongMemEval — the last inside the judge-mismatch uncertainty band. A prior
systematic push to close those gaps found **every lever in the noise band**, concluding
"retrieval is solved for this pipeline". There is no identified path to comparable SOTA, and
the one unclaimed gain (GateMem education, ~+5 mean) still lands short.

Worse, on the one benchmark where a headline is available, **our own finding says the metric
rewards the wrong thing** — deleting nothing scores 77.8. Chasing that number would undercut
the paper's most interesting claim.

## The argument

**1. Access control belongs at generation time.** The obvious engineering move — filter
retrieval by the asker's authorization — is actively wrong. 302 of 727 GateMem privacy
checkpoints expect `answer_redacted`, which requires *possessing* the record in order to
withhold its specifics; a retrieval filter leaves nothing to redact, and makes unauthorized
records look nonexistent, collapsing `refuse` into `no_memory`. Retrieving broadly and
letting the model judge gives **A = 7.0 ±0.41, rank 1 of 43** — ahead of RAG-Policy (12.2),
a system built around a policy layer — with **no access-control machinery at all.**

**2. Erasure at the storage layer is not the forgetting mechanism.** A complete 2x2 over
storage (delete / tombstone) x constraint (guard on / off): the constraint outweighs the
architecture ~20x on the reported metric. What real deletion *does* buy is provability — it
is the only configuration scoring non-zero on the strict e2e metric (9.4 vs 0.0). **Verifiable
erasure is a compliance property, not a behavioural one.**

**3. Capability buys governance, not utility.** Across three backbones on identical
retrieval, utility *decreases* monotonically (85.4 → 79.4 → 77.8, ~12 sd) while governance
improves (A 19.8 → 6.6, F 10.5 → 0.9) and over-refusal climbs (2.3% → 16.6%). The weakest
model is the most *useful* one. Capability manifests as caution, which is a trade — and it
saturates.

**4. The primary metric cannot distinguish forgetting from silence.** `compliance_utility_score`
grades the answer, so deleting nothing plus a refusal instruction is **optimal** (77.8, our
best number, 8.3 above SOTA) and scores **0.0** end-to-end, with content still in context on
99.7% of safety checkpoints. A system can climb this leaderboard by not forgetting.

**5. Recall-only grading turns a trade into a law.** Compression trades −12.2 recall for
+5.9 synthesis. GateMem grades exact recall only, so extraction "collapses" there (24.4 vs
59.1) — one side of a two-sided trade, and a result that does not generalise.

**6. A shipped access policy is unsatisfiable against its own labels.** GateMem's medical
policy grants care-team access "ONLY when assigned to that patient… Otherwise: refuse", but
nurse, pharmacist and scheduler appear in **zero** relationship facts. 49 utility checkpoints
flip answer→refuse because of it. Verifiable from the released data alone.

## Why this should be credible

Several claims cut against us. (2) demolishes minimem's own file-first selling point. (4)
undermines the number we would most like to quote. (6) began as a refuted prediction of ours
— we predicted a *less* compliant model would score higher under that policy; it scored
lowest. The system results establish the instrument is competent; they are not the claim.

## Frame

1. **Setup** — multi-principal memory governance; what the benchmarks score.
2. **System** — minimem as instrument: files + hybrid retrieval + generation-time judgment.
   Competence evidence only (near-SOTA on four benchmarks, comparable configs stated).
3. **Governance is generation-time** — claims 1–3.
4. **What the benchmarks measure** — claims 4–6.
5. **Threats** — judge mismatch, n, prompt confound, scale selection. See the ledger.
6. **Implications** — what to build, what to measure, what to stop claiming.
