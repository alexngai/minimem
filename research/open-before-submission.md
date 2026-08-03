# Open before submission

Rewritten 2026-08-02 after the prior-art check. Ordered by what stops the paper, not by effort.

---

## Tier 0 — Decisions only you can make

Nothing below Tier 0 can be sequenced until these land.

### 0.1 Section ordering · **REOPENED**
Systems-led (§3 first) was chosen before the prior-art result. §3's claims took the heaviest
damage; §4's survives best and now carries the reframed thesis. Either order is defensible; the
current one is now the harder case to argue.

### 0.2 Whether to quote leaderboard-relative absolutes at all
Judge mismatch is unresolved and unscheduled (§1.1 below). The alternative is to drop absolutes
and let inter-arm deltas carry the paper. Every surviving finding is delta-shaped, so this costs
a rank claim already abandoned and removes the only blocking item with no owner.

### 0.3 Whether to report the tuned GateMem figure
Lean: comparable-only (62.7 ±1.18) in the body, tuned (72.6 ±1.22) in an appendix, with the
~10-point prompt contribution stated. Unchanged by the prior-art work.

---

## Tier 1 — Blocking. No number ships without these.

### 1.1 Judge matching · **investigated 2026-08-02; user taking gpt-4o access**

**The exposure is narrower and better-bounded than previously recorded.**

*What the GateMem paper actually specifies* (read from full text): "All baselines are evaluated
under the same checkpoint order, backbone configuration, and judge-based protocol" and "Primary
results are computed from GPT-4o judge labels." Judge runs at temperature 0.0, 4096-token
budget. **gpt-4o is the sole judge for all 43 methods**, so our `gpt-4.1` is the single
uncontrolled variable in that comparison. Note GPT-4o-**mini** appears throughout their paper
as a *backbone*, not a judge — do not confuse the two.

*Why this matters less than it looks — their Table 9.* They validated the judge against human
adjudication on a stratified sample of 579 labeled checkpoint-output pairs:

| metric | judge | human | \|Δ\| |
|---|--:|--:|--:|
| U | 53.33 | 53.33 | 0.00 |
| A | 59.38 | 58.33 | 1.04 |
| F | 23.86 | 23.86 | 0.00 |
| MGS | 16.50 | 16.92 | **0.42** |

Field-level: action correctness 100% (κ=1.000), utility 99.0% (κ=0.976), access leakage 99.0%
(κ=0.978), deletion leakage 97.7% (κ=0.937). The judging task is heavily constrained — the
judge receives hidden grading fields including expected action, judge specification and leak
targets, so it is structured label extraction rather than open-ended assessment.

**MGS moves 0.42pp between gpt-4o and humans. Our gap to SOTA is 6.8pp.** Judge choice cannot
account for a gap sixteen times larger than the judge's own disagreement with ground truth.

*Model availability, probed directly.* Azure (deploymentless inference) serves `gpt-4.1`,
`gpt-5`, `gpt-5-mini`, `gpt-5.5`, `gpt-5.6-sol`. The entire 4o/4.1-mini/nano family returns
`SKU 'GlobalStandard' is not supported`. AWS Bedrock's OpenAI line starts at GPT-5.4 (5.4, 5.5,
5.6 Sol/Terra/Luna, Codex, gpt-oss) and carries no 4o-era model; it does offer a full Claude
lineup, useful for cross-family sensitivity. `gpt-4o` left ChatGPT on 2026-02-13 with API
access retained at announcement, so the OpenAI API is the only parity route.

**Status: user is arranging gpt-4o access.** Two things remain worth doing regardless, because
they do not depend on gpt-4o and do not decay when it retires:

1. **Replicate their Table 9 for our judge.** Protocol is fully specified in their appendix:
   stratified sample, two annotators using the same hidden grading fields, adjudication on
   conflict, and leakage counted only when the assistant confirms or reconstructs (user guesses
   alone do not count). Validating against ground truth beats matching another model.
2. **Record the reproducibility point.** GateMem's reference judge is a retiring model, so exact
   reproduction of their published numbers has a shelf life. That is a defect in the benchmark,
   not in our setup, and it is the strongest argument for same-judge deltas. Worth one sentence.

*BEAM is separately constrained*: a faithful re-judge needs a full re-run, because each of the
three samples regenerates the answer and only the last reaches `--details-out` (see the
correction note in `evals/beam/RESULTS.md`).

### 1.2 The GateMem Table 3 collision · **presentational, and serious**
Our capability row (U 85.4 / A 19.8 / F 10.5) sits close to GateMem's GPT-5-mini Long-Context
Medical row (85.7 / 19.8 / 20.3). A reviewer who notices and is not told will wonder whether we
re-ran anything. Requires an explicit in-text declaration that the sweep is an independent
retrieval-controlled run, not a footnote.

### 1.3 S3 replication to n=3 · *in flight*
77.8 answer / 0.0 e2e is the paper's most quotable number and is n=1. `nodelguard-r2`/`-r3`
queued behind C1.

### 1.4 Snippet-only citations must be fetched before they enter a bibliography
The three reports each carry an explicit unverified list. Load-bearing ones: **XSTest**
(NAACL 2024), **Inverse Scaling** (2306.09479), **2505.16831**, **BenchGuard** (2604.24955).
Roughly a dozen more sit in the do-not-cite bucket. Fabricated or misattributed citations are
the one error class that is fatal on discovery.

---

## Tier 2 — Structural work the reframe created

### 2.1 A related-work section that does not exist yet
The outline has no home for LLM unlearning-evaluation critique, contextual-integrity
benchmarks, the over-refusal literature, or declassification. This is where the four
concessions get made. Estimated 800–1,200 words, and it is now load-bearing: the thesis
*requires* the prior work to exist.

### 2.2 §3 must be rewritten, not edited
- **S1/C2 must be narrowed** to drop-style filters or SD-RAG (2601.11199) refutes it as worded.
- **S1/C3 downgrades to a framing paragraph** citing Sabelfeld & Sands, not a contribution.
- **S1 must confront Harness-MU** (2606.21856), which argues the opposite thesis in our setting.
- **S2 relabels its axis** from "capability" to model generation; FalseReject (2505.08054) rules
  out parameter scale, and Hasan & Biswas (2605.05427) will be used to argue post-training
  recipe. Both need answering in text.
- **S6 is contested** by CIMemories (2511.14937), which measures our proposed regime and finds
  it fails at granular disclosure. Household (50.7% held) is already our own exception.

### 2.3 §4.3 must attribute its mechanism
S5's mechanism belongs to Wu & Gong (2604.12177); the class belongs to BenchGuard. What
survives is the specific self-contradiction and the quantification. Currently drafted as though
the finding is ours outright.

---

## Tier 3 — Prior-art coverage still missing

The check is meaningfully incomplete. Stated plainly so nobody mistakes three reports for a
systematic review.

| gap | why it matters |
|---|---|
| **ACL Anthology** — not covered for any claim | S2's agent tried and the domain filter did not hold; S1 never attempted it. A human search for "over-refusal" + "backbone" is ten minutes |
| **USENIX Security / IEEE S&P / ACM CCS** — no direct search | S1 is a security claim. Conference papers without arXiv preprints are invisible to what we ran |
| **OpenReview / NeurIPS / ICLR / ICML full text** — reached only via general web | Standard venue for exactly this work |
| **S4 and S7 not re-checked** | Both carry prior-art notes from an *earlier* search that predates their controlled forms |
| **S6 not systematically checked** | Contested by one paper found incidentally while checking S1 |
| **Non-English literature** | Not covered |

Three claims were checked properly. Four were not.

---

## Tier 4 — Strengthening, not blocking

- **C1 budget control** — *in flight*, unblocks the −12.2/+5.9 exchange-rate sentence. The two
  large category effects (+38.2, −20.6) stand without it.
- **Close the remaining n=1 cells** — three of the four C3b 2×2 cells.
- **Replicate S4** (n=200, single run).
- **A mediation analysis for S2's mechanism.** Over-refusal as the cross-backbone link is
  currently co-movement, not mediation. It is the cleanest unclaimed piece of S2 and deserves
  better than correlation.

---

## Explicitly not doing

- **Chasing comparable SOTA.** No identified path on GateMem or BEAM; a prior systematic push
  found every lever in the noise band. The one unclaimed gain (education, ~+5 mean) lands short.
- **`literal-max-share` sweep.** C4's inversion means the interesting axis is answer-vs-e2e, not
  deletion breadth.
- **Building a multi-agent benchmark.** Deprioritised; see `contributions.md`.

---

## Methodology note to carry into the write-up

Four bugs in this work were caught by **instrumentation, not by results looking wrong**: a
vacuous context metric, JSON parse failures silently becoming refusals, a `--deletion tombstone`
flag that ran as `off`, and double-counted deletions. Three were silent no-ops that scored
plausibly. Every run now emits a config banner and every result is checked for `n_checkpoints`
against domain size before being believed.

**A fifth belongs with them, from today.** Three prior-art subagents each completed substantial
searches and then returned one-word sign-offs; one reported "Report delivered" with nothing
delivered and no file on disk. The failure was invisible from the outside — the work was real,
the delivery was not. It was caught by checking the filesystem rather than trusting the report.
Same lesson as the other four, in a different medium, and it is the honest reason to trust the
rest.
