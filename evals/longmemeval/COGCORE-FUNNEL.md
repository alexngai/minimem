# Cognitive-Core LongMemEval Funnel

Goal: evaluate cognitive-core configurations quickly enough to tune and debug
each layer before spending on 60-question or full-500 LongMemEval runs.

## Fixed Controls

Keep these fixed across comparable arms unless the run is explicitly testing
one of them:

- `k=16`
- same sampled question ids across arms
- same answer prompt version
- same extraction cache version
- same extraction chunking and fact cap
- same local retrieval backend where possible
- for `cogcore-system*`, reserve a small ExperienceMemory tail budget
  (`min(4, floor(k/4))`) so episodic sessions supplement rather than displace
  KnowledgeBank evidence
- ExperienceMemory tuning knobs are part of the run config:
  `experienceGranularity`, `experienceChunkTurns`, `experienceEmbedding`,
  `experienceScope`, `experiencePoolSize`, `experienceSlots`, and optional
  `experienceMinScore`
- one expensive cogcore arm per process when native/local embedding listener
  accumulation appears

Every run should write enough detail to debug misses:

- question id, category, question, gold, candidate answer, judge result
- retrieved note ids and short excerpts
- retrieved channel, source rank/score, final rank, and selection policy
- gold evidence coverage by turn/session id, including missing evidence ids
- matching extracted facts for failed questions
- evolution action counts and relevant actions for failed questions
- token/call/wall-clock cost by arm

## Stage 0: Harness Prep

Before new benchmark runs, make the harness suitable for diagnosis:

- Add answer-prompt v3 for count/list/state questions: enumerate evidence first,
  then answer; do not collapse return + replacement pickup unless explicitly
  cancelled.
- Add `--details-out` or equivalent JSONL detail dumps.
- Add `--debug-all` for concentrated debugging runs when we need matching
  extraction/evolution traces on successful rows too.
- Add `--retrieval-only` so memory/retrieval configs can be compared without
  answer/judge calls; in that mode, `accuracy` means all labelled evidence
  turns were covered by the retrieved context.
- Add config metadata to result files: prompt version, cache version, chunk size,
  fact cap, evolve `maxNotes`, arms, and question ids.
- Keep extraction/evolve caches keyed by all config values that can affect output.

Stop condition: the existing six-question category smoke is reproducible and
failed questions can be diagnosed without a one-off trace script.

## Stage 1: Micro Set

Purpose: catch broken configs and obvious regressions.

Sample:

- `--per-category 1`
- six questions total, one per LongMemEval category

Arms:

- `local`
- `cogcore-hybrid`
- `cogcore-system`

Debug/tune allowance:

- Tune prompt wording if a failure reproduces with gold evidence in context.
- Tune retrieval mix/top-k only if evidence is absent from retrieved context.
- Tune extraction only if the cache lacks answer-bearing facts.
- Do not tune on more than the six micro questions before rerunning the full
  micro set.

Promotion gate:

- `cogcore-system` is not worse than `cogcore-hybrid` overall.
- No category has an obvious systemic regression.
- Runtime and tokens are acceptable enough for an 18-question hard set.

## Stage 2: Targeted Hard Set

Purpose: test the categories cognitive-core should improve.

Sample:

- 12 to 18 questions total
- oversample `multi-session`, `temporal-reasoning`, and `knowledge-update`

Arms:

- `local`
- `cogcore-hybrid`
- `cogcore-system`
- `cogcore-system-evolve`

Debug/tune allowance:

- Tune one variable at a time.
- If evolve fails to help, inspect whether it saw the needed notes; adjust
  `maxNotes` or prefiltering before changing the answer prompt.
- If experience retrieval fails, compare session-level experience hits against
  KnowledgeBank hits for the same question.
- Use `--retrieval-only` first when testing ExperienceMemory granularity,
  embedding, scope, or score gates; run full QA only after a config improves
  evidence coverage without adding obvious distracting context.
- Tune ExperienceMemory one axis at a time: granularity first (`session` vs
  `chunk`), then hash embedding, then score gate.
- If memory has all evidence but answer is wrong, treat it as answer synthesis
  and update prompt/schema rather than memory retrieval.

Promotion gate:

- Best cogcore-system variant beats or clearly changes the failure profile of
  `cogcore-hybrid` on hard categories.
- The same miss is not being repeatedly caused by harness prompt ambiguity.
- Cost estimate for n=60 is acceptable.

## Stage 3: Balanced Decision Set

Purpose: choose the full-500 candidate arms.

Sample:

- `--per-category 10`
- about 60 questions

Arms:

- `local`
- `cogcore-hybrid`
- best `cogcore-system*` variant from Stage 2

Debug/tune allowance:

- No broad prompt or extraction rewrites after inspecting this set.
- Allow only mechanical fixes, cache-key fixes, and clear bug fixes with reruns.
- Any new modeling idea goes back to Stage 1.

Promotion gate:

- Pick at most two arms for full 500.
- Run full 500 only after the chosen arm has stable cache behavior, no active
  native listener/process leaks, and detail dumps for failures.

## Candidate Configuration Groups

| group | arm | hypothesis |
|---|---|---|
| raw read baseline | `local` | raw-turn hybrid retrieval plus the answer prompt is the floor |
| semantic memory | `cogcore-hybrid` | extracted facts plus raw turns in KnowledgeBank improves over raw retrieval |
| full memory read | `cogcore-system` | ExperienceMemory plus KnowledgeBank improves multi-session and temporal recall |
| write-time synthesis | `cogcore-system-evolve` | evolution over the full memory store pre-links facts that answer multi-hop/state questions |
| task-state memory | `cogcore-system-actions` | explicit pending-action/state extraction solves count/update questions |

`cogcore-system-actions` should be tested only after `cogcore-system` is stable;
it is a new modeling layer, not a default subsystem toggle.

## Current Interpretation Of The 0a995998 Miss

The failed six-question smoke miss was not a simple missing-memory failure.

- extracted facts contained the blazer pickup and Zara boot return/pickup facts
- raw-turn retrieval surfaced enough evidence
- evolution created Zara-related merge/link actions
- the answerer collapsed return + replacement pickup into one item/action

This makes answer-prompt v3 and a true ExperienceMemory+KnowledgeBank arm the
next useful tests before increasing sample size.
