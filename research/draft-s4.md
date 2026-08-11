# §4 What the benchmarks measure

*Draft prose, first pass. Register: CS/ML empirical. Citation keys are placeholders
(`\citep{...}`) pending the reference pass — no reference is asserted that has not been read.
All numbers are same-judge deltas between our own arms; the judge-mismatch caveat is stated
in §2 and is not repeated here.*

---

The three findings in this section are properties of the benchmarks rather than of any system
evaluated on them. Two are visible in the benchmarks' own reported metrics once the right
control arm is run, and the third is verifiable from released data without running a model at
all. Each identifies a case where a governance score responds to something other than the
governance property it names.

## 4.1 The primary metric cannot distinguish forgetting from silence

That output-level metrics can reward non-disclosure rather than removal is established.
\citet{yoon2026overused} argue that unlearning metrics are routinely reused outside their
intended scope, "rewarding surface-level non-disclosure" where a model scores well through
refusal while retaining the underlying information, and \citet{thaker2025weak} show that
supposedly unlearned content survives benign perturbations of popular benchmarks. That
literature concerns weight-level unlearning, where retention must be inferred by probing. We
show the same failure in retrieval-backed memory, where the mechanism is different and the
retained content is directly observable, and where the metric exhibiting it is a shipped
leaderboard's primary score rather than a diagnostic built to find it.

GateMem \citep{gatemem} reports a memory governance score, MGS = U x (1 - A) x (1 - F), where
U is utility accuracy, A the access-control violation rate, and F the deletion-leakage rate.
All three components are computed from the model's final answer. The benchmark also defines an
end-to-end variant that inspects the retrieved context supplied to the model, but the
leaderboard reports the answer-level score.

That construction admits a configuration the benchmark does not otherwise test: retain
everything, and instruct the model to decline. We ran it. Deletion was disabled entirely and
the generation-time no-reconstruction constraint left in place, holding retrieval, prompt,
answer model and judge fixed against the deleting configuration.

**Table 4.** Deletion configuration against both scoring axes, four domains, 2,218 checkpoints.

| configuration | MGS (answer) | MGS (e2e) | F (answer) | F (e2e) |
|---|--:|--:|--:|--:|
| deletion off + constraint | **77.8** | **0.0** | 0.89% | 99.73% |
| delete + constraint (n=3) | 72.6 | **9.4** | 1.51% | 24.06% |
| tombstone + constraint | 71.6 | 0.0 | 0.14% | 99.86% |

Deleting nothing is optimal on the reported metric. At 77.8 it is the highest score this work
produced, 8.3 points above the published leaderboard best, and it scores exactly zero
end-to-end. The deleted content sits in the retrieved context on 99.7% of safety checkpoints.
The model simply does not repeat it.

MGS therefore cannot separate a system that forgot from a system that still holds the record
and declines to discuss it. Both produce the same answer, and the answer is what is graded.
GateMem's own end-to-end variant exists to catch exactly this, and does so decisively, which is
the only reason the argument can be made from inside the benchmark.

We did not go looking for this. It appeared while optimising for the reported metric, and the
end-to-end check caught it only because every result in this work is integrity-checked before
it is believed (§5). A system tuned against the leaderboard metric alone would have kept the
configuration and published the number. This is the difference from a diagnostic benchmark
built to detect leakage \citep{wang2026memleak}: the configuration was not constructed as an
attack, it was what optimisation converged on.

The reversal is sharper than a simple ceiling effect. On the answer axis deletion appears
purely costly: enabling it lowered utility by 6.0 points and left F marginally *worse*, by 0.62
percentage points, through supersession rather than recovery. Leakage attributed to
`update_delete_conflict` rose from 1.90% to 4.76% when deletion was active, because removing a
superseding record can leave the stale one as the only survivor. On the end-to-end axis,
deletion is the only intervention that scores at all.

The defensible configuration is the one scoring non-zero on both axes, delete plus constraint
at 72.6 answer and 9.4 end-to-end, and it is not the configuration the leaderboard rewards. Any
headline number drawn from this benchmark should be reported with its end-to-end counterpart.

> ⏳ *At the time of writing the deletion-off arm is a single run; replication to n=3 is in
> flight. The direction is far outside the benchmark's measured noise floor (four-domain mean
> sd ~1.2), but the magnitude is unreplicated. This hedge is removed or the number corrected
> before submission.*

## 4.2 Compression buys cost, not quality

*Rewritten 2026-08-02 against the budget-controlled result. The previous version of this
section argued that compression trades recall for synthesis and that recall-only grading turns
that trade into a law. **The control refuted it.** Under the systems framing this material
becomes §5 Representation.*

Any memory system must choose a representation: store conversation turns verbatim, or extract
derived statements at write time. On GateMem, extraction collapses, scoring 24.4 against
verbatim's 59.1 with deletion held off. Read alone, that says write-time compression is simply
a bad idea, which is both too strong and for the wrong reason.

We tested the two representations under control on LongMemEval_S \citep{longmemeval}, holding
the retrieval adapter, prompt, answer model and judge fixed and varying only the contents of
the observation cache: derived statements in one arm, one note per turn holding raw text in the
other, at 154 against 493 notes per instance. Live search tools were disabled in both arms,
since the default setting would let answer-time search compensate for whatever the
representation failed to supply.

Equal top-k is the wrong control. An extracted note cites roughly 2.0 source turns, so
extraction at k=16 already reaches about 32 turns of coverage while verbatim reaches 16. We
therefore ran a third arm at **coverage-matched k=32**, which is also generous to verbatim on
tokens: an extracted note averages 268.8 characters against verbatim's 1001.3, so verbatim at
k=32 carries roughly seven times the context.

**Table 5.** Representation and retrieval budget, n=200, single run per arm.

| category | extract k16 | verbatim k16 | **verbatim k32** |
|---|--:|--:|--:|
| multi-session | 76.5% | 55.9% | 70.6% |
| knowledge-update | 94.1% | 97.1% | 97.1% |
| temporal-reasoning | 85.3% | 85.3% | 88.2% |
| **synthesis** | **85.3%** | 79.4% | **85.3%** |
| **recall** | 85.7% | 98.0% | **99.0%** |
| overall | 85.5% | 88.5% | **92.0%** |

At matched coverage extraction's synthesis advantage disappears exactly, 85.3 against 85.3,
while recall goes to verbatim by 13.3 and overall by 6.5. The 5.9-point synthesis gap measured
at equal top-k was a **retrieval-budget artifact**, not a property of the representation.

So compression does not trade quality for quality. At matched budget it is dominated. What it
buys is **cost**: near-parity synthesis at roughly one seventh of the context tokens. The trade
is quality against cost, and where context is cheap there is nothing to buy.

That is what GateMem's collapse actually shows. Its episodes are 7 to 8K tokens, so nothing is
context-bound; compression there costs quality and saves nothing. The result is real but it
does not generalise, and it generalises for a different reason than we first argued.

**A prediction follows, and we record it before testing it.** If compression's value is a
function of whether context binds, extraction should pay at scales where it does, and the
ordering above should narrow or invert at BEAM's 1M and 10M tiers. Testing this requires a
verbatim cache built for BEAM and a stated retrieval-budget rule fixed in advance; the arm does
not exist yet. We report the prediction rather than the result.

**Threats.** n=200, single run per arm. The synthesis tie is a sum of opposing category
effects rather than uniform parity: `multi-session` still favours extraction at matched
coverage, 70.6 against 76.5. Cost-matched comparison, as distinct from coverage-matched, is
untested, and it is the setting where extraction should look best.

**On how this claim was reached.** It has been framed three times: first as compression being a
bad trade, then as a two-sided exchange at a measurable rate, and now as quality against cost.
The budget objection was raised early and wrongly dismissed by measuring *tokens*, where
verbatim already held 3.7 times more, when the binding axis was *coverage*. Only the control
settled it. We report this because the intermediate framing was published-quality wrong in a
way that argument alone did not catch.

## 4.3 A shipped policy is unsatisfiable against its own labels

The third finding requires no model run. GateMem's medical access policy grants care-team
access "ONLY when assigned to that patient… Otherwise: refuse", and the scaffold supplies
relationship facts from which assignment is to be established. Three of the roles that policy
governs appear in zero relationship facts: nurse (0 of 33), pharmacist (0 of 23) and scheduler
(0 of 42). The precondition cannot be satisfied by any system reading the data as specified.

The cost is measurable. Forty-nine utility checkpoints flip from answer to refusal under that
policy, every one of them in a role absent from the scaffold. A system is penalised for
following the policy correctly.

We recorded a prediction about this in advance and it was wrong. If faithful
instruction-following is penalised here, a less compliant backbone should score higher. It
scored lowest. Under the standard prompt, MGS was 48.5 for the least compliant of three
backbones, 61.6 for the middle one and 56.5 for the most compliant, non-monotonic with both
gaps outside the noise floor. The mechanism held and the consequence did not. The least
compliant model refused half as often, 8.4% against 16.7%, and gained utility exactly as
predicted, 75.0 against 70.0, but lost more to leakage than it gained. Office is the clean
case: identical utility in both arms at 78.6, and MGS of 31.8 against 66.0. The entire
34-point gap is leakage.

Compliance is not separable. Whatever makes a model over-refuse under a misspecified policy is
what keeps it from leaking under a well-specified one, so utility lost to a defective policy
cannot be bought back by choosing a less compliant model. For benchmark design the implication
is narrower and easier to act on: a policy should be checked for satisfiability against the
labels shipped alongside it. That is a static check over released files, requiring no model and
no run.

## 4.4 What the three have in common

Each finding describes a score moving for a reason unrelated to the property it names: because
the metric reads the answer rather than the context, because it grades one side of a trade, or
because the policy it enforces cannot be satisfied. None required a novel method to detect. Two
needed a control arm the benchmark does not itself include, and the third needed only a count
over the released files.

The practical consequence for anyone reporting on these benchmarks is in §6. The consequence
for reading published results on them is immediate: a governance number is uninterpretable
without knowing whether the system was graded on what it said or on what it still held.

---

## Drafting notes (not part of the section)

**Open before this section is submission-ready**

| item | status |
|---|---|
| §4.1 n=1 → n=3 (`nodelguard-r2`/`-r3`) | queued behind C1, ETA ~21:00–22:15 |
| §4.2 exchange rate (`c1-verbatim-k32`) | running, ETA ~19:40 |
| Citation keys `gatemem`, `longmemeval` | placeholders, reference pass pending |
| Judge-matched runs | blocking for absolutes (§2 caveat carries it for now) |

**Deliberate choices**

- 77.8 is quoted here only as an MGS. It is also gpt-5.6-sol's utility in the §3 capability
  curve, so that section must always carry its error bar (77.8 ±0.28) to keep the two apart.
- The refuted prediction stays in the body of §4.3 rather than moving to §5. It is the
  strongest evidence that the critique is not self-serving, and it is load-bearing for the
  "compliance is not separable" claim that follows it.
- Table 4 leads with the deletion-off row, not the defensible configuration. The perverse
  result is the finding; burying it in row three would soften the section's only sharp image.
- Checkpoint total (2,218) is the sum of the four domain sizes (579 + 547 + 540 + 552) and was
  verified against `n_checkpoints` in each summary before use.
- The section says "generation-time constraint" throughout where the repo says "guard"
  (`--reconstruct-guard on`). "Guard" reads as a filter, which is the mechanism §3 argues
  *against*; "constraint" is what it actually is, one sentence of prompt. The reproduction
  appendix must state the mapping or the flags will not be findable from the prose.

**Word count**: ~1,280 (target 1,200–1,500 for a [core] section at 8–9pp).
