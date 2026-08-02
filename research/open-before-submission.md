# Open before submission

## Blocking — no number should be quoted without these

1. **Judge-matched runs.** Every benchmark uses a different judge from its reference:
   GateMem `gpt-4.1` vs the paper's `gpt-4o`; BEAM `gpt-4.1` vs reference `gpt-4.1-mini`;
   LOCOMO uses the mem0 "J" convention, not an author-official metric. **Deltas between our
   own arms are sound; absolutes are not leaderboard-exact.** This can move numbers either
   direction and is measurement hygiene, not improvement.
2. **Decide whether to report the tuned GateMem figure at all.** Lean: comparable-only
   (62.7 ±1.18) in the body, tuned (72.6 ±1.22) in an appendix, with the ~10-point prompt
   contribution stated. Reporting only the tuned number invites a comparison it does not
   support.
3. **Replicate S3.** The paper's most quotable number (77.8 answer / 0.0 e2e) is n=1.
   *In flight.*

## Strengthening — closes the objections a reviewer leads with

4. **C1 budget control.** *In flight* — verbatim at coverage-matched k=32. The stated
   objection ("verbatim carries 3.2x more notes") is about the store and is already refuted
   at the prompt: an extracted note is 268.8 chars vs verbatim's 1001.3, so equal top-k hands
   verbatim ~3.7x *more* context. The real asymmetry is coverage — extraction cites ~2.0
   source turns per note, ~7x more coverage-per-token — and that is the mechanism behind its
   synthesis win.
5. **Close the remaining n=1 cells**: three of the four C3b 2x2 cells.
6. **Replicate S4** (n=200, single run).

## Optional — expands scope rather than defending it

7. **The layered arm** — verbatim + observations + summaries at fixed budget, per-question
   paired. Groundwork measured: of 31,381 cached observations, 28.3% cite a single turn,
   67.2% stay within one session, only **4.4% join across sessions** — so the layer meant to
   supply synthesis rarely crosses the boundary `multi-session` questions are built on.
8. **Education's categorical-credential refusal** — ~19pp of one domain, traced
   (`campus_it` refuses 24/27 with the required token *present in context*), unfixed. Raises
   a score; defends no claim.
9. **Full 35-conversation BEAM** — firms absolutes, no reason to expect improvement.

## Explicitly not doing

- **Chasing comparable SOTA.** No identified path on GateMem or BEAM; the prior systematic
  push found every lever in the noise band. The one unclaimed gain (#8) still lands short.
- **`literal-max-share` sweep.** C4's inversion means the interesting axis is answer-vs-e2e,
  not deletion breadth — a sweep would map the wrong curve.
- **Building a multi-agent benchmark.** Deprioritised; see `contributions.md`.

## Methodology to carry into the write-up

Four bugs this work produced were caught by **instrumentation, not by results looking
wrong**: a vacuous context metric, JSON parse failures silently becoming refusals, a
`--deletion tombstone` flag that ran as `off`, and double-counted deletions. Three were
silent no-ops that scored plausibly. Every run now emits a config banner (mode, guard state,
model, prompt length) and every result is checked for `n_checkpoints` against domain size
before being believed. Worth a short methods note — it is also the honest reason to trust
the rest.
