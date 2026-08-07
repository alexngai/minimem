# Prior art — threat resolutions and the reframe

Follows [`prior-art-S1.md`](prior-art-S1.md), [`prior-art-S2.md`](prior-art-S2.md),
[`prior-art-S3.md`](prior-art-S3.md). Date: 2026-08-02.

---

## Threat 1 — the declassification literature (S1/C3) · **RESOLVED, and C3 downgrades**

**Question.** Does language-based security already formalise the possession argument — that
releasing a redacted view presupposes holding the full secret, making drop-style retrieval
filtering category-incompatible with redaction-expecting checkpoints?

**Answer: the conceptual machinery is entirely present, and has been since 2005. C3 is an
application of the classical model, not a new principle.**

**Sabelfeld & Sands, "Declassification: Dimensions and Principles"**, Andrei Sabelfeld and
David Sands, Chalmers University of Technology / University of Göteborg. Extended version of
the IEEE CSFW 2005 paper (doi 10.1109/CSFW.2005.15), published in JCS. **Read directly** —
text extracted from the PDF with `pypdf` after three fetch attempts failed. Quotes below are
verbatim.

Two dimensions bear on C3, and between them they cover it:

**§2.1 "What"** formalises partial release, which is redaction: *"Partial release guarantees
that only a part of a secret is released to a public domain. Partial release can be specified
in terms of precisely which parts of the secret are released, or more abstractly as a pure
quantity. This is useful, for example, when partial information about a credit card number or
a social security number is used for logging."*

Releasing part of a secret is defined as an operation **on the secret**. Possession is a
structural assumption of the model, not a derived result — which is exactly why nobody states
the possession argument as a finding. In the IFC model the enforcement point *is* the release
point by construction, so a component that filters before possession is not a declassifier at
all, and the question C3 asks cannot arise.

**§2.3 "Where"** is the placement question, twenty years early: *"Where in a system information
is released is an important aspect of information release. By delegating particular parts of
the system to release information, one can ensure that no other (potentially untrusted) part
can release further information."* It distinguishes **level locality** (intransitive
noninterference) from **code locality** (where physically in the code information may leak).

**Consequence for the paper. C3 downgrades from "the strongest surviving S1 contribution" to a
modest applied observation.** The `prior-art-S1.md` verdict that C3 was "not found anywhere" was
correct as a literal search result and wrong as a novelty assessment: it was not found because
it is an assumption of the governing framework rather than a claim anyone needed to make.

What remains defensible, stated narrowly: a class of deployed LLM memory systems enforces
access control at a point that precedes possession, which places them outside the
declassification model entirely, and a shipped benchmark's labels make the resulting failure
measurable. That is worth a paragraph citing Sabelfeld & Sands as the framing, not a
contribution claim.

## Threat 3 (new) — S5 had never been checked · **PARTIAL-OVERLAP**

Run after the reframe, because `contributions.md` flagged S5 as the one supported claim with no
search behind it. It is not clean.

**Policy-Invisible Violations in LLM-Based Agents** — Jie Wu, Ming Gong (Atlassian), arXiv
2604.12177v1, 2026-04-14. **[fetched]** Defines actions that are "syntactically valid,
user-sanctioned, and semantically appropriate, yet still violate organizational policy because
the facts needed for correct policy judgment are hidden at decision time," and states that
"compliance depends on entity attributes, contextual state, or session history absent from the
agent's visible context."

**That is S5's mechanism, published.** Our medical-policy finding is an instance: the policy
requires assignment, and assignment facts are absent from the scaffold.

**The consequence differs, and that is what survives.** Wu & Gong's missing facts cause
*under*-refusal — the agent shares what it should not, because it cannot see the restriction.
Ours cause *over*-refusal, and the benchmark's own utility labels expect an answer on the very
checkpoints its policy requires refusing. Their failure is a leak; ours is a benchmark
contradicting itself.

**BenchGuard: Who Guards the Benchmarks? Automated Auditing of LLM Agent Benchmarks** — arXiv
2604.24955. *[snippet]* An automated auditing framework for agent benchmarks; reports 12
author-confirmed issues in ScienceAgentBench "including fatal errors rendering tasks
unsolvable," and 83.3% agreement with expert-identified issues on BIXBench Verified-50.
**Verify before citing.** This establishes the *class* — benchmark defects that make tasks
unsolvable — as an active research area with tooling. S5 is a hand-found instance in that class.

**Revised S5.** Survives as: the specific demonstration that a *governance* benchmark's shipped
policy is unsatisfiable against *its own utility labels*, with quantification (49 checkpoints;
nurse 0/33, pharmacist 0/23, scheduler 0/42), verifiable from released data with no model run.
The mechanism must be attributed to Wu & Gong and the class to BenchGuard.

## Threat 2 — the "model size is not a factor" claim (S2) · **RESOLVED, favourably**

**Source located and read: FalseReject** (Zhehao Zhang, Weijie Xu, Fanyou Wu, Chandan K. Reddy,
arXiv 2505.08054v2). It states "Model size is Not a Noticeable Factor", reporting no consistent
relationship between parameter count and refusal metrics, with smaller models sometimes
outperforming much larger ones (Llama-3.2-1B at 78.43% compliance vs Llama-3.1-405B at 56.28%).
Tested Llama-3 (1B–405B), Qwen-2.5 (0.5B–32B), Gemma-3 (1B–27B).

**It does not undercut S2 — it disambiguates it.** FalseReject varies **parameter scale within
a family**. S2 varies **model generation across a provider's line**. Confirmed on fetch: the
study "compared parameter scale within families only, not across model generations or different
post-training recipes." That is precisely the axis S2 varies and FalseReject does not test.

**But it forces a relabelling.** S2 currently calls its independent variable "capability".
FalseReject rules out parameter count as the mechanism, so the variable is **model generation**,
or more honestly **post-training recipe**. `PAPER-PLANNING.md` already concedes this
("'capability' is an ordering we assume rather than measure"); there is now a citable reason to
fix the label rather than caveat it.

**A live conflict worth naming rather than hiding.** Hasan & Biswas (arXiv 2605.05427) report
that refusal and compliance tendencies are "stable within model families across generations and
scales". Our three backbones are one provider's line across generations, and we observe
over-refusal moving 2.3% → 16.6%. Our data contradicts theirs. State it directly.

---

## The reframe

### What the prior art actually did to us

Every headline claim survives as a *measurement*, and none survives as a *discovery*:

| claim | the phenomenon | already reported by |
|---|---|---|
| S1 | ACL-filtered retrieval makes withheld evidence indistinguishable from absent evidence | Partial Evidence Bench (2605.05379) |
| S1 | enforcement belongs at output composition, not document access | Zafar et al. (2605.17034) |
| S2 | backbone choice trades utility against governance; the weak model gets high utility | **GateMem's own finding (4)** (2606.18829) |
| S3 | output-level metrics reward non-disclosure, so refusal scores as removal | Yoon, Jun & No (2606.27379) |

### The reframe that follows from it

Do not fight this. The paper gets **stronger** by conceding all four phenomena and relocating
the contribution to the controls, because the concession sets up a sharper thesis than the one
currently in `thesis.md`:

> **The benchmarks' own papers already report these failure modes as observations — and their
> primary metrics then reward the behaviour those observations warn about.**

GateMem reports that long-context prompting often wins on governance, and that its weakest
backbone attains high utility with poor governance. Both are in the paper. Its headline metric,
`compliance_utility_score`, then scores highest for a system that deletes nothing and refuses.
The gap between what a benchmark's authors *noticed* and what their metric *rewards* is the
paper, and it is a claim nobody in the located literature makes.

This framing:

- **Absorbs every pre-emption as support.** Each prior finding becomes evidence that the
  phenomenon is real and known, which makes the metric's failure to penalise it worse, not less
  interesting.
- **Puts the surviving contributions where they belong.** The retrieval-and-prompt-controlled
  isolation (S2), the answer-vs-e2e control on a shipped metric (S3), and the redaction
  possession incompatibility (S1/C3) are all *methodological*, and the thesis is now
  methodological too.
- **Makes the refuted claims load-bearing rather than decorative.** R1 and R4 already show us
  correcting ourselves. Conceding four pre-emptions in the related-work section is the same
  move, and it is what buys the critique its credibility.

### What must change in the drafted material

1. **`thesis.md`** — the thesis sentence changes, per above. Claims 1–6 all demote from
   discovery to controlled measurement.
2. **`contributions.md`** — S1, S2, S3 downgrade from novel finding to novel demonstration.
   Every row needs a prior-art column. **S1/C2 must be narrowed** to drop-style filters or it
   is refutable by SD-RAG (2601.11199).
3. **`draft-s4.md` §4.1** — currently presents the conflation as a discovery. Must open by
   attributing the general form to 2606.27379 and position our contribution as the shipped-
   metric demonstration with the benchmark's own e2e variant as control.
4. **New related-work section.** The outline has no home for LLM unlearning evaluation
   critique, contextual-integrity benchmarks, or the over-refusal literature. This is a real
   addition, not a paragraph.
5. **The Table 3 collision (S2)** must be stated explicitly: our row (85.4 / 19.8 / 10.5) is
   close to GateMem's GPT-5-mini Long-Context Medical row (85.7 / 19.8 / 20.3). Declare the
   sweep as an independent retrieval-controlled run in the text, not a footnote.
6. **The ordering decision reopens.** §3's claims took the heaviest damage; §4's survives best
   and now carries the thesis. Systems-led ordering was chosen before this evidence existed.

### What does not change

The empirical record. Every number in `evals/*/RESULTS.md` stands. Nothing found contradicts a
measurement we made; the prior art contests what those measurements *mean* and who said it
first. The 2×2, the capability curve, the answer-vs-e2e pair and the C1 trade are all intact.
