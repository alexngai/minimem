# Eval harness setup — `swarmkit-eval` provenance

**Why this file exists.** `node_modules/swarmkit-eval` is a symlink to a sibling checkout, and
its `dist/` is **gitignored and built locally**. Nothing records which branch produced the build
you are running against. That already caused one silent failure (below), and it is the same
class as the four instrumentation bugs in the methodology note.

## Current setup (updated 2026-08-03)

```
minimem/node_modules/swarmkit-eval  ->  ../../swarmkit-beam-eval/src/eval
                                        (git worktree, branch `eval-main-plus-beam-tests`)
```

**`origin/main` now carries every harness.** PRs #13 (gatemem-adapter) and #14
(agentenv-provider) landed upstream, and BEAM is on main too, so the hand-merged
`eval-all-harnesses` branch is obsolete. The live branch is now:

```
origin/main (6d3fdc9)  +  one cherry-picked commit: BEAM test coverage
```

The single local commit is `test(eval): BEAM loader + rubric judge coverage`, which is not
yet upstream. Everything else comes straight from main. The main `GitHub/swarmkit` checkout
is untouched and still on `agentenv-provider`.

Verified after the update: all 10 harness exports present (`loadBeam`, `beamJudgeQuestion`,
`BEAM_DIMENSIONS`, `loadGateMem`, `loadGateMemDomains`, `loadLongMemEval`, `loadLocomo`,
`episodesById`, `queriesByEpisode`, `writePredictionsJsonl`), 446 exports total, **386 tests
passing / 0 failing**, BEAM suite 24/24.

## Why the worktree was needed originally

The harnesses used to be split across branches with **no single branch running everything**:

| branch | BEAM | GateMem | LongMemEval / LOCOMO |
|---|:--:|:--:|:--:|
| `agentenv-provider` (main checkout) | ✗ | ✗ | ✓ |
| `beam-eval` | ✓ | ✗ | ✓ |
| `gatemem-adapter` | ✗ | ✓ | ✓ |
| **`origin/main` (now)** | **✓** | **✓** | **✓** |

That split is resolved upstream. The worktree is still worth keeping — it isolates the eval
build from whatever branch the main checkout is on, which is what caused the stale-`dist`
problem below.

## Keeping it current

```bash
cd /Users/alexngai/GitHub/swarmkit-beam-eval
git fetch origin
git rebase origin/main            # local commit is just the BEAM tests
cd src/eval && npm install && npm run build
```

Re-verify exports and tests after every rebuild — `dist/` is gitignored, so a stale build is
invisible until something asks it for a symbol it lacks.

## The failure this exposed — worth carrying into the paper's methods note

Before this setup, the symlink pointed at the main checkout on `agentenv-provider`, and
`import('swarmkit-eval')` returned `loadGateMem` **even though GateMem source does not exist on
that branch.** The reason: `dist/` was built at some earlier point while `gatemem-adapter` was
checked out, and was never rebuilt after the branch switch.

So the GateMem runs were executing a **stale build whose source was not on the checked-out
branch**. The results appear sound — every run was checkpoint-verified and the S3 replication
is tight at 78.1 ±0.29 — but nothing in the run record tied a result to the source that
produced it. BEAM, meanwhile, had been silently unrunnable for days; the failure only surfaced
when something actually tried to import `BEAM_DIMENSIONS`.

**Fifth instrumentation lesson, same shape as the other four**: a build artifact that outlives
its source is indistinguishable from a correct one until something demands a symbol it lacks.

## Rebuild

```bash
cd /Users/alexngai/GitHub/swarmkit-beam-eval/src/eval && npm install && npm run build
```

`tsc` reports ~17 pre-existing type errors (`fetch` / `Response` / `RequestInit` not found — a
`@types/node` lib config issue on the branch, not something this setup introduced). It emits JS
regardless and all exports resolve. **Do not read a clean build as a precondition.**

## Rollback

```bash
cd /Users/alexngai/GitHub/minimem/node_modules
rm swarmkit-eval && ln -s ../../swarmkit/src/eval swarmkit-eval
```

To remove the worktree entirely:

```bash
cd /Users/alexngai/GitHub/swarmkit && git worktree remove ../swarmkit-beam-eval
```

## Recommended hygiene

Any eval run that matters should log the resolved harness provenance alongside its config
banner — at minimum the symlink target and the branch/commit of the worktree it points at.
Runs are already checked for `n_checkpoints`; the build behind them is currently unchecked.
