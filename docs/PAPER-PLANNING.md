# Paper planning — claims, evidence, and threats

Working notes for deciding what (if anything) is publishable. Organised as claims with
the evidence behind them and the reason each might not survive review. Not a draft.

## Result inventory

| benchmark | scale | our number | comparison point |
|---|---|--:|---|
| GateMem | ~7–8K tok/episode | **61.6** standard prompt / 72.0 tuned | SOTA 69.5 (Long-Context/Deepseek) |
| BEAM | 500K–1M tok | 72.7% (500K) | +13pp over cogcore KB baseline |
| LOCOMO | 10 conv | 79.3% | +43pp over cogcore KB baseline |
| LongMemEval_S | full 500 | 93.0% (full pipeline), ~84% (retrieval alone) | Mastra 94.87% |

See `evals/gatemem/RESULTS.md`, `evals/beam/RESULTS.md`, `evals/locomo/RESULTS.md`.

## Candidate claims, strongest first

### C1 — Write-time compression is a bad trade when the task is exact recall
**Evidence.** GateMem, de-confounded with deletion off: extracted observations 24.4 MGS
vs verbatim turns 59.1, over-refusal 55.6%. Extraction compressed 186 turns to ~20
observations and destroyed the exact tokens/amounts/dates that are graded. Same direction
on BEAM/LOCOMO: hybrid retrieval over verbatim beat the KB observation-dump by +13/+43pp.
**Strength.** Large, far outside noise, and consistent across three benchmarks.
**Threat.** Every benchmark cited grades *exact recall*. The claim as stated is nearly
tautological unless we test the converse — that compression *helps* synthesis. Untested.
This is the single biggest hole.

### C2 — The retrieval substrate, not the architecture on top of it, carries the result
**Evidence.** Three-arm decomposition on BEAM/LOCOMO: substrate +13.1/+42.7, graph layer
+1.9/+1.2 (inside noise). On GateMem, no baseline uses hybrid fusion at all — the paper
config pins `retrieval_backend: embedding`, and ReMeM switches between lexical and
semantic rather than fusing.
**Strength.** Replicated across benchmarks; the correction of our own earlier
mis-attribution strengthens rather than weakens it.
**Threat.** "Hybrid retrieval beats vector-only" is well established (see prior art
below). The novel part is only that *deployed memory systems don't do it*, which is an
observation about the field, not a technique.

### C3 — Forgetting fails by reconstruction, not by failure to delete
**Evidence.** Education F ranged only 12.2–21.7 across the *entire* deletion sweep,
including deletion fully off — deletion policy could not move it. One sentence forbidding
reconstruction cut F to 5.0 (medical and office to 0.0) at no utility cost.
**Strength.** Clean mechanism, large effect, cheap intervention.
**Threat.** n=1 per cell. Needs replication before it can be asserted.

### C3b — Storage-layer erasure does not imply behavioural erasure *(strongest candidate)*
**Evidence.** GateMem's hidden `attack_type` field isolates the attacks that exist to test
whether deletion was real. With structural file deletion but **no** prompt guard, the
recovery family still leaks: `post_delete_recovery` **12/129 = 9.3%**,
`split_reconstruction` 2.4%, `post_delete_direct` 6.1% — 5.9% overall. Deleting *more*
aggressively does not help (loose deletion: 6.2%). Adding one generation-time sentence
takes the family to **0.5%** — `post_delete_recovery` and `split_reconstruction` both to
**0/129 and 0/126**. A 12x reduction the architecture never delivered.
**Why it matters.** minimem's own selling point is that file deletion makes `no_memory`
*true* rather than claimed — and it does, at the storage layer: you can grep the directory
and prove the record is gone, which a tombstoned vector store cannot offer. But the
information stays derivable from surviving context, so **auditable record-deletion is
necessary and not sufficient**. Closing the gap is a generation-time constraint, not a
storage property.
**Strength.** Cuts *against* our own architecture's marketing claim, which makes it
credible rather than self-serving; mechanism isolated at the attack-type level; the
residual (`update_delete_conflict`, 4.8%) is coherently the supersession family seen in
office and education.
**Threat.** n=1. We have no per-attack-type baseline numbers (the leaderboard publishes
aggregate F only), so the comparison to other systems is currently absolute, not relative.
Novelty vs the machine-unlearning / RAG-unlearning literature is unchecked.

### C4 — Deletion can be net-negative under multiplicative scoring
**Evidence.** With `literal-max-share` at 0.34, deletion spent 17.8 U to buy 9.4 F —
scoring *lower* than not deleting at all (50.7 vs 59.1). Tightening recovered office
+15.6 U and household +16.3 U at zero F cost.
**Strength.** Quantified trade with a clear mechanism (collateral deletion of
utility-bearing notes).
**Threat.** Partly a bug report about our own default. The general form — "aggressive
forgetting destroys utility faster than it buys compliance" — is the publishable version
and needs to be shown to generalise beyond our implementation.

### C5 — Instruction-following is penalised when instructions are misaligned with labels
**Evidence.** GateMem's medical policy grants care-team access "ONLY when assigned to
that patient… Otherwise: refuse", but nurse/pharmacist/scheduler appear in **zero**
relationship facts — the precondition is unsatisfiable. Under that prompt a newer model
complies more faithfully and scores **worse**: −5.1 mean, medical −16.1, over-refusal
11.9%→29.5%. Backbone effect is an interaction (+0.7 under our prompt, −5.1 under
theirs), not a main effect.
**Strength.** Genuinely surprising, mechanistically traced to specific checkpoints, and
it is a claim about *evaluation design* rather than about our system — which makes it
harder to dismiss as self-serving.
**Threat.** Two models is a thin basis for "capability" claims; could be a conservatism
difference rather than compliance. The weak-backbone arm (gpt-4.1) tests this directly —
if a *less* capable model scores *higher* under the standard prompt, the claim firms up
considerably.

### C6 — Low leakage is judgment, not thin retrieval
**Evidence.** The secret is in our prompt context on 69% of office privacy checkpoints
and we leak 11% of those; Long-Context holds it 100% of the time and leaks 19.3%. So the
advantage survives conditioning on exposure.
**Strength.** The obvious deflationary explanation is measured and rejected.
**Threat.** One domain. Should be run across all four.

## Prior art that constrains novelty

An earlier literature check found much of the above already published: Memanto
(2604.22085), MemDelta (2606.29914), RAG-vs-GraphRAG (2502.11371), and "Same Ranking,
Different Winner" (2605.24060). **C1 and C2 are likely reproductions**, valuable as
independent confirmation but not as contributions. If there is a paper here, it is more
likely built on **C3, C4 and C5** — findings about *governance* evaluation (forgetting,
the U/F trade, and label-instruction misalignment) rather than about retrieval quality.

Re-verify this before committing; the check predates this session's findings.

## Multi-principal vs multi-agent — an architectural argument with NO evidence

Logged explicitly so it does not drift into the paper as though it were measured.

**What we have tested is multi-principal**: one memory store, one writer, many *askers*
with different roles and entitlements. That is what GateMem measures, and it is well
covered.

**What we have not tested is multi-agent**: many agents both reading and writing shared
memory, concurrently. Untested properties include concurrent writes and lost updates,
cross-agent contamination (one agent's write poisoning another's retrieval), read-your-
writes consistency and staleness across agents, provenance of an entry to its writing
agent, and whether shared memory measurably beats per-agent isolated memory on a task
requiring coordination.

The file-first substrate has a plausible story here — sharing is a directory, concurrency
is WAL, history is git, scoping is paths — and the WAL/`busy_timeout` work did validate
that four concurrent processes do not corrupt the index. **That is engineering
validation, not a research result**, and none of our four benchmarks exercises concurrent
writes at all. Do not put this argument next to measured claims.

Open question under investigation: whether any published benchmark covers this, or whether
a minimum credible one would have to be built.

## Threats to validity, applying to everything above

1. **n=1.** Every arm is a single run against a measured ~3-point noise floor. "1st of
   43" is a tie, not a win. Only office (+11.0 over best-on-board) is clearly outside it.
2. **Judge mismatch.** We judge with `gpt-4.1`; the GateMem paper uses `gpt-4o`, BEAM's
   reference is `gpt-4.1-mini`. Deltas between our arms are sound; absolutes are not
   leaderboard-exact.
3. **Prompt confound.** ~10 of the tuned points are prompt, not memory. Handled by
   reporting both numbers, but it must stay handled.
4. **Scale selection.** GateMem episodes are 7–8K tokens, so Long-Context is a
   no-retrieval oracle and every memory system on that board is handicapped. Our
   retrieval story is strongest at BEAM's 500K–1M, where the comparison set is thinner.
5. **Synthesis untested.** See C1. Nothing here measures abstraction or aggregation.

## Highest-value next work

- **Replication.** 3x the two headline configs. Converts most claims from "suggestive" to
  "measured" and is pure compute.
- **The synthesis experiment.** Three arms (verbatim / derived+summaries / both) at fixed
  context budget, per-question paired comparison. Directly attacks C1's biggest hole.
  Measured groundwork: of 31,381 cached observations, 28.3% cite a single turn, 67.2%
  stay within one session, and only **4.4% join across sessions** — so the layer that
  exists to provide synthesis almost never crosses the boundary LongMemEval's
  `multi-session` questions are built on.
- **Weak-backbone arm** for C5.
- **Education's categorical-credential refusal** — ~19pp of one domain, traced, unfixed.
