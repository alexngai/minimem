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

### C3 — Forgetting fails by reconstruction, not by failure to delete *(subsumed by C3b)*
**Original evidence.** Education F ranged only 12.2–21.7 across the *entire* deletion
sweep, including deletion fully off — no deletion policy could move it. One sentence
forbidding reconstruction cut F to 5.0 (medical and office to 0.0) at no utility cost.
**Status.** C3b's 2x2 tests the same proposition with a proper control and supersedes this
on evidence. Keep C3 only as the narrative route in (the observation that F was immovable
across the deletion sweep is what motivated building the control); cite C3b for the claim.

### C3b — Storage erasure is not the mechanism of behavioural forgetting *(strongest; 2x2 complete)*
**Evidence.** GateMem's hidden `attack_type` isolates the attacks that test whether
deletion was real. Crossing storage mechanism against behavioural constraint, all four
cells matched on the same build, 370 recovery-family checkpoints:

|            | guard ON | guard OFF | guard effect |
|------------|---------:|----------:|-------------:|
| delete     |    0.81% |     5.68% |       +4.86  |
| tombstone  |    0.00% |     7.03% |       +7.03  |
| *storage effect* | *-0.81* | *+1.35* |            |

**The constraint outweighs the architecture by ~20x.** Removing one sentence multiplies
recovery leakage 7-9x. Whether the record is physically erased or merely marked moves it
about a point. `tombstone` retains the record, marked, indexed, retrievable and visible in
the prompt -- i.e. what a vector store's soft delete does -- so this is a real control, not
an argued one.

**Claim.** A file-first store makes erasure *auditable* (grep the directory, prove the
record is gone), and that auditability is precisely what makes this decomposition
measurable -- in a vector store you cannot separate residue from reconstruction. But
auditable erasure buys ~1 point of leakage; the generation-time constraint buys ~6.
**Verifiable deletion is a compliance property, not a forgetting mechanism.**

**Strength.** Cuts against how file-backed and "true deletion" memory systems are marketed,
including our own, which makes it credible rather than self-serving. Effect sizes are far
apart (~6 vs ~1), so the ordering is robust even though only the delete+guard cell is n=3
(0.81 +/- 0.27). Novelty is the decomposition and the quantification: the general "record
deletion is insufficient" claim is published, but attributed to embedding residue and
weight influence, neither of which applies to a store that is rebuilt from files.
**Threat.** Three cells are n=1. The two modes select overlapping but not identical target
sets (18 vs 22 on a smoke episode) because `literal-max-share` is a share of a corpus that
shrinks under real deletion but not under tombstoning; acceptable at these effect sizes, a
matched replay would be needed for finer comparisons. The guard's effectiveness is also
capability-dependent (C4b: much weaker on gpt-4.1).

### C4 — Deletion can be net-negative under multiplicative scoring
**Evidence.** With `literal-max-share` at 0.34, deletion spent 17.8 U to buy 9.4 F —
scoring *lower* than not deleting at all (50.7 vs 59.1). Tightening recovered office
+15.6 U and household +16.3 U at zero F cost.
**Strength.** Quantified trade with a clear mechanism (collateral deletion of
utility-bearing notes).
**Threat.** Partly a bug report about our own default. The general form — "aggressive
forgetting destroys utility faster than it buys compliance" — is the publishable version
and needs to be shown to generalise beyond our implementation.

### C4b — Capability trades utility for governance *(n=3 every cell; monotonic)*
**Evidence.** Three backbones, identical retrieval and prompt, four domains, n=3 per cell:

| model        |          U |          A |          F |        MGS | over-refusal |
|--------------|-----------:|-----------:|-----------:|-----------:|-------------:|
| gpt-4.1      | 85.4 ±0.87 | 19.8 ±0.22 | 10.5 ±0.82 | 61.5 ±0.29 |   2.3 ±0.19 |
| gpt-5.5      | 79.4 ±1.12 |  7.0 ±0.41 |  1.5 ±0.01 | 72.6 ±1.22 |  13.2 ±0.13 |
| gpt-5.6-sol  | 77.8 ±0.28 |  6.6 ±0.33 |  0.9 ±0.30 | 71.9 ±0.28 |  16.6 ±0.60 |

**Every axis is monotonic in capability.** Utility *decreases* (85.4 -> 77.8; 7.6 apart at
pooled sd 0.65, ~12 sd). Governance improves (A 19.8 -> 6.6, F 10.5 -> 0.9). Over-refusal
rises (2.3% -> 16.6%), which is the mechanism connecting the two.

**Claim.** Given the same retrieval, frontier capability manifests as *caution*, and caution
is a trade rather than a free improvement: more capable models refuse more, which costs
utility and buys governance. Under a multiplicative score the trade pays (MGS 61.5 -> 72.6)
but it **saturates** -- 5.5 -> 5.6-sol is 72.6 vs 71.9, inside noise, so governance gains
have flattened while the utility cost keeps accruing.
**Why it matters.** Retrieval-QA can be served by a cheap model *and served better*;
governance cannot. It also warns against reading leaderboard backbone spreads as capability
rankings, since the weakest model here is the most useful one. And the saturation suggests
buying a newer model is not a governance strategy past a point.
**Relation to C5.** Same finding from two sides. C5's mechanism (less compliance -> more
answering -> higher U) is confirmed; C5's *consequence* was refuted because governance
losses exceed the utility gain. Also relevant to C3b: the no-reconstruct guard is markedly
weaker on gpt-4.1 (F 10.5 vs 1.5), so that fix is itself capability-dependent.
**Threat.** Three models from two families, one provider; "capability" is an ordering we
assume rather than measure. The monotonicity is clean but three points cannot distinguish a
trend from a coincidence of these particular models.

### C5 — The policy is unsatisfiable against its own labels *(narrowed; capability framing REFUTED)*
**What survives.** GateMem's medical policy grants care-team access "ONLY when assigned to
that patient… Otherwise: refuse", but nurse/pharmacist/scheduler appear in **zero**
relationship facts, so the precondition cannot be met. 49 utility checkpoints flip
answer→refuse under that policy, every one in a role absent from the scaffold. This is a
benchmark-design defect verifiable from the data alone, independent of any model
comparison, and it costs utility for every backbone we tried.

**What was refuted.** The prediction on record was that a *less* compliant model would
therefore score *higher* under this policy. It scored **lowest**: standard prompt MGS is
gpt-4.1 **48.5**, gpt-5.5 **61.6**, gpt-5.6-sol **56.5** — non-monotonic, peaking in the
middle, with both gaps (13.1 and 5.1) outside the ~3-point noise floor.

**The mechanism held; the consequence did not.** gpt-4.1 refuses half as much (8.4% vs
16.7%) and gets *higher* utility (75.0 vs 70.0) exactly as predicted — but loses far more
on governance than it gains. Office is the clean case: **identical U (78.6 both), MGS 31.8
vs 66.0**; the whole 34-point gap is leakage.

**Revised claim.** *Compliance is not separable.* The property that makes a model
over-refuse under a misspecified policy is the same one that makes it not leak under a
good one. Utility lost to a bad policy cannot be bought back with a less compliant model.
Neither "more capable is better" nor "less compliant is better" holds.
**Threat.** n=1 per cell; three models, two families. The non-monotonicity is outside
noise but the *shape* of the curve rests on single runs.

### C6 — Low leakage is judgment, not thin retrieval
**Evidence.** The secret is in our prompt context on 69% of office privacy checkpoints
and we leak 11% of those; Long-Context holds it 100% of the time and leaks 19.3%. So the
advantage survives conditioning on exposure.
**Strength.** The obvious deflationary explanation is measured and rejected.
**Threat.** One domain. Should be run across all four.

## Prior art that constrains novelty

An earlier check found much of C1/C2 already published: Memanto (2604.22085), MemDelta
(2606.29914), RAG-vs-GraphRAG (2502.11371), "Same Ranking, Different Winner" (2605.24060).
**C1 and C2 are likely reproductions** — useful as independent confirmation at new scale,
not as contributions.

A second pass (search-summary level only; none of these read in full) found:

**On C3b (erasure).** The general claim — deleting the record is insufficient because the
information can be re-derived — **is established**: "When Machine Unlearning Meets RAG"
(2410.15267), "Subtract or Replay? Exact Deletion from Language-Model Memory" (2607.27539),
SoK: PETs in AI (2506.14576). But that literature attributes residue to *embeddings
surviving text deletion* and *training-data influence in weights*, neither of which applies
here: we never train on the data and we rebuild the index, so the record is provably gone.
The surviving narrow claim is that a **file-based store makes storage-layer erasure
verifiable, which cleanly separates it from behavioural erasure** — in a vector store you
cannot tell whether a leak is embedding residue or reconstruction. In that clean setting
behavioural leakage persists at 9.3%, deleting *more* does not help (10.1%), and one
generation-time constraint closes it. The contribution is the decomposition and the
quantification, not the insufficiency.

**On multi-agent.** There is a benchmark-shaped hole but *not* a research-shaped one.
Concurrency in multi-agent LLM memory is actively formalised: "Verified Detection and
Prevention of Concurrency Anomalies in Multi-Agent LLM Systems" (2606.17182) gives a
machine-checked consistency hierarchy in TLA+ over four anomalies (stale-generation,
phantom-tool, causal-cascade, tool-effect reordering), verified against LangGraph and
AutoGen and reproducing a live lost update in a shipped app. See also Governed Shared
Memory for Multi-Agent LLM Systems (2606.24535), CoAgent (2606.15376), Multi-Agent Memory
from a Computer Architecture Perspective (2603.10062), and the Always-On Agents survey
(2606.30306). **A "files + WAL + git" argument would land inside an active formal-methods
conversation and must engage with it**, not claim the territory.

**Candidate benchmarks, unverified.** MemoryArena (2602.16313, interdependent
multi-session agentic tasks) and MemoryAgentBench (ICLR 2026, incremental multi-turn) are
the closest found; both look multi-*session* rather than multi-*agent*, so neither
obviously tests concurrent writes. Read before planning around them.

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

**Checked (abstract level; ArgusFleet URL checked directly).** No adoptable public
benchmark exists:

- **MemoryArena** (2602.16313) — confirmed **multi-session single-agent**, not multi-agent:
  "agents acquire memory while interacting with the environment, and subsequently rely on
  that memory to solve future tasks." Not a vehicle for this direction. It *is* a candidate
  for C1's synthesis hole though — its domains are agentic (web navigation,
  preference-constrained planning, progressive information search, sequential formal
  reasoning) rather than QA, and it reports that agents near-saturated on LoCoMo perform
  poorly on it.
- **Governed Shared Memory / MemClaw** (2606.24535) — a **system paper, not a benchmark**.
  It does evaluate concurrent multi-agent read/write (intra-fleet visibility, zero
  cross-fleet leakage, write-to-visible latency), but against no baseline — it measures a
  live production service. Its harness, ArgusFleet, is **not public** (github.com/caura-ai/
  argusfleet returns 404).

**So: build or nothing.** That is a real cost and should be a deliberate decision, not a
default. **Decision (2026-07-31): deprioritised.** Not worth committing to benchmark
construction on one session's evidence, particularly when the problem space is already
formalised by others (below). Revisit only if the governance claims (C3b/C4b/C5) firm up
under replication and need a multi-agent setting to extend into.

**Positioning warning.** MemClaw already formalises four failure modes — *unauthorized
leakage, stale propagation, contradiction persistence, provenance collapse* — and names
*temporal supersession* as a primitive. That is exactly the family behind our office stale
values, education current-value queries, and `update_delete_conflict` (4.8%, our largest
residual). **Our supersession findings are measurement, not problem-identification**, and
must cite this. Its conclusion — "long-context retrieval alone is insufficient for
production multi-agent memory" — also partly pre-empts the framing we would reach for.

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
