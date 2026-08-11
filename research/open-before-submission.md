# Open before submission

Rewritten 2026-08-02 after the prior-art check. Ordered by what stops the paper, not by effort.

---

## Tier 0 — Decisions only you can make

Nothing below Tier 0 can be sequenced until these land.

### 0.1 Section ordering · **REOPENED**
Systems-led (§3 first) was chosen before the prior-art result. §3's claims took the heaviest
damage; §4's survives best and now carries the reframed thesis. Either order is defensible; the
current one is now the harder case to argue.

### 0.2 Whether to quote leaderboard-relative absolutes at all · **changed by the matched judge**
Judge matching is now done for GateMem and impossible for BEAM (§1.1). That resolves the
blocking status but sharpens the decision: under the reference judge **no "beats SOTA" claim
survives** (tuned 67.8 vs SOTA 69.5; comparable 55.1). GateMem absolutes are now quotable and
*worse*; BEAM absolutes are permanently directional. Every surviving finding is delta-shaped, so
dropping cross-paper absolutes still costs little — but it is no longer a way to avoid an
unresolved threat, it is a presentational choice about which honest number to lead with.

### 0.3 Whether to report the tuned GateMem figure
Lean: comparable-only (62.7 ±1.18) in the body, tuned (72.6 ±1.22) in an appendix, with the
~10-point prompt contribution stated. Unchanged by the prior-art work.

---

## Tier 1 — Blocking. No number ships without these.

### 1.1 Judge matching · **RESOLVED — GateMem done, BEAM permanently impossible**

**GateMem: done.** Predictions re-scored under `gpt-4o`, GateMem's own reference judge
(`paper_main.yaml`, `paper_matrix.yaml`). Full analysis in `evals/gatemem/RESULTS.md`.

| config | gpt-4.1 | **gpt-4o (matched)** | Δ |
|---|--:|--:|--:|
| tuned | 72.6 ±1.22 | **67.8 ±0.93** | −4.9 |
| comparable (standard prompt) | 62.7 ±1.18 | **55.1 ±0.29** | −7.6 |
| deletion-off + guard | 78.1 ±0.29 | **71.9 ±0.55** | −6.2 |

**Every leaderboard comparison was mismatched in our favour by 5–8 MGS. No "beats SOTA" claim
survives.** Against SOTA 69.5: tuned −1.7 (was +3.1), comparable −14.4 (was −6.8).

Two findings came out of the hygiene rather than out of looking for them, and both belong in
the paper:

1. **The judge effect is not uniform.** U and over-refusal are judge-*invariant*; `A` and `F`
   roughly double. **The axes GateMem exists to measure are exactly the ones whose scores
   depend on who judges.** Same species as the answer-vs-e2e gap.
2. **gpt-4o's extra flags are mostly ungrounded.** 29 gpt-4o-only flags on the tuned arm
   (15:1 asymmetry vs gpt-4.1), of which **86% have no leak target in the answer text** —
   refusals like *"I can't confirm or discuss the clinical reason"* scored as leaks. gpt-4o
   infers leakage from the act of declining. Stricter *and* noisier: ~4–6 real catches against
   25–51 unsupported ones. Report both judges; tune the prompt toward neither.

**BEAM: impossible, and permanently.** `gpt-4.1-mini` is EOL and inaccessible — confirmed
2026-08-09, consistent with the earlier Azure probe (`SKU 'GlobalStandard' is not supported`
for the whole 4o/4.1-mini/nano family) and with the retirement wave that took `gpt-4o` out of
ChatGPT on 2026-02-13.

This is no longer our limitation. **Neither benchmark's reference judge is obtainable by
anyone** — including their authors, and including a reviewer attempting reproduction. Frame it
as a property of the benchmarks:

> The reference judges for both benchmarks are retired models. Exact reproduction of their
> published absolutes is no longer possible for any party. We report same-judge deltas between
> our own arms, which are unaffected, and treat all cross-paper absolutes as directional.

That is the paper's own thesis applied to itself: §4.1 argues a metric can be structurally
unable to measure what it claims; a benchmark whose judge has evaporated is the same failure at
the protocol layer.

**What still holds:** every inter-arm delta — the +28.3 substrate delta, the erasure 2×2, the
capability curve, the C1 budget control, the answer-vs-e2e pair. All same-judge.

**What is now permanently directional:** "~5pp short on BEAM", and the 58.3-vs-64.1 Hindsight
comparison (already three-protocol confounded — their Gemini answerer *and* Gemini judge).

**Still worth doing, and now the only durable form of judge validation:** replicate GateMem's
Table 9 for our judge. They validated `gpt-4o` against human adjudication (MGS |Δ| 0.42,
field-level κ 0.937–1.000) on a stratified sample of 579 checkpoint-output pairs. Validating
against *ground truth* does not decay when a model retires. Protocol is fully specified in
their appendix.

⚠ **Consequence not yet propagated.** Numbers elsewhere in the repo and in the drafts are still
gpt-4.1-judged. Anything quoted against the leaderboard must move to the matched figures, and
the S3 headline in particular (78.1 → **71.9** matched) appears in `thesis.md`,
`contributions.md`, `draft-s4.md` and `PAPER-PLANNING.md`.

Also still to propagate: **S1's rank-1 survives but narrows** (A 7.0 → 11.1 ±0.08 vs
RAG-Policy 12.2; margin 5.2 → **1.1**), and the capability curve survives inverted and
monotonic (U 86.2 → 77.8 → 76.1). Both are stated in `evals/gatemem/RESULTS.md` under "What
survives matched judging" and neither has reached the drafts.

### 1.2 The GateMem Table 3 collision · **presentational, and serious**
Our capability row (U 85.4 / A 19.8 / F 10.5) sits close to GateMem's GPT-5-mini Long-Context
Medical row (85.7 / 19.8 / 20.3). A reviewer who notices and is not told will wonder whether we
re-ran anything. Requires an explicit in-text declaration that the sweep is an independent
retrieval-controlled run, not a footnote.

### 1.3 S3 replication to n=3 · **DONE**
Replicated: **78.1 ±0.29** (77.8 / 78.1 / 78.3), e2e **0.0** in all three reps, every domain
checkpoint-verified. Under the matched `gpt-4o` judge: deletion-off **71.9 answer / 0.0 e2e**,
delete+guard **67.8 / 9.2**. **The contrast survives matched judging intact** — it is a
contrast between axes, not a level, so the judge shift moves both arms together and leaves the
finding untouched.

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
