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

## 4.2 Recall-only grading turns a trade into a law

A second grading choice converts a two-sided trade into an apparent law. Any memory system must
choose a representation: store conversation turns verbatim, or extract derived statements from
them. On GateMem, extraction collapsed, scoring 24.4 against verbatim's 59.1 with deletion held
off. Read alone, that result says write-time compression is a bad idea.

It is not. We tested the two representations under control on LongMemEval_S \citep{longmemeval},
holding the retrieval adapter, prompt, answer model and judge fixed and varying only the
contents of the observation cache: derived statements in one arm, one note per turn holding raw
text in the other, at 154 against 493 notes per instance for a 3.2:1 compression ratio. Live
search tools were disabled in both arms, since the default setting would let answer-time search
compensate for whatever the representation failed to supply.

**Table 5.** Representation against question type, n=200, single run.

| | extracted | verbatim | |
|---|--:|--:|---|
| recall (n=98) | 85.7% | **98.0%** | verbatim **+12.2** |
| synthesis (n=102) | **85.3%** | 79.4% | extraction **+5.9** |
| overall | 85.5% | 88.5% | |

Neither representation dominates. Two categories carry the effect and both are mechanistically
legible. `single-session-assistant` questions ask what the *assistant* said; extraction
paraphrases those turns into third-person statements and the original wording is gone, giving
61.8% against verbatim's 100.0%. `multi-session` questions require assembling evidence across
sessions, and verbatim floods retrieval at a fixed top-k so the relevant turns fall below the
cut, giving 76.5% against 55.9%. Two further categories are level to within a point, which
rules out a global shift.

This explains the GateMem result rather than contradicting it. GateMem grades exact recall of
amounts, dates and identifiers, so it measures one side of a two-sided trade and reports it as
a verdict on representation. We had drawn that conclusion ourselves before running the control,
and would have published half a trade as a general finding.

The general form is worth stating plainly. A benchmark that grades only one side of a design
trade will report that trade as a law, and systems tuned against it converge on one side for
reasons that do not survive contact with a benchmark grading the other.

> ⏳ *One objection remains open. The verbatim arm carries 3.2x more notes at the same top-k, so
> part of its synthesis loss could be retrieval budget rather than representation. Measured at
> the prompt the asymmetry runs the other way, since an extracted note averages 268.8 characters
> against verbatim's 1001.3, so equal top-k already hands verbatim roughly 3.7x more context.
> The real asymmetry is coverage: an extracted note cites about 2.0 source turns. A
> coverage-matched arm (verbatim at k=32) is running. The two category effects do not depend on
> it; the aggregate exchange rate does, and is not quoted until it lands.*

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
