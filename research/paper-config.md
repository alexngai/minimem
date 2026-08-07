# Paper Configuration Record

Pipeline Phase 0. Confirmed decisions in **bold**; defaults I selected are marked *(default)*
and are the ones to push back on.

| field | value |
|---|---|
| paper type | Empirical evaluation paper. The system is the instrument, not the subject. |
| discipline | CS / ML / NLP |
| venue class | **General ML/NLP, full paper (8–9pp)** |
| framing | **Systems-led. §3 before §4; title candidate 1, "Memory Governance Is a Generation-Time Problem"** |
| citation format | ACL-style author-year *(default)* — most citations are arXiv preprints, which author-year handles more readably than numeric |
| language | English only *(default)* — the skill defaults to a bilingual zh-TW + EN abstract; not conventional for this venue, so dropped |
| abstract | 150–250 words, English |
| body length | ~6,500–8,000 words excluding references |
| existing materials | `thesis.md`, `outline.md`, `contributions.md`, `open-before-submission.md`, `PAPER-PLANNING.md` (claims ledger), three empirical records, §4 drafted |
| Stage 1 status | **prior-art re-check for S1/S2/S3 running** |

## Section plan (systems-led, as chosen)

| § | content | status | cut if 4pp? |
|---|---|---|---|
| 1 | Introduction | not drafted | core |
| 2 | Setup: benchmarks, system under test, judge-mismatch statement | not drafted | core |
| 3.1 | Access control belongs at generation time (S1) | not drafted | core |
| 3.2 | Low leakage is judgment, not thin retrieval (S6) | not drafted | full |
| 3.3 | Storage erasure is not the forgetting mechanism (R1, the 2×2) | not drafted | full |
| 3.4 | Capability buys governance, not utility (S2) | not drafted | core |
| 4.1 | The metric cannot distinguish forgetting from silence (S3) | **drafted** | core |
| 4.2 | Recall-only grading turns a trade into a law (S4) | **drafted** | core |
| 4.3 | A shipped policy is unsatisfiable against its own labels (S5) | **drafted** | full |
| 4.4 | What the three have in common | **drafted** | core |
| 5 | Threats + the instrumentation methods note | not drafted | core |
| 6 | Implications: build / measure / stop claiming | not drafted | core |

All [full] sections stay at 8–9pp. The figure inventory (F1–F3, T1–T4) is unchanged.

## One consequence of the systems-led choice, and how it gets handled

`outline.md:43` flags the current abstract as hedging: "two sets of findings" is weaker than
committing to the critique. Systems-led ordering makes that hedge *easier* to fall into,
because the systems results genuinely do come first.

This is fixable in drafting rather than by reordering. The abstract should run the systems
findings as **setup** and the metric critique as **payoff**, in that order, without ever
announcing that there are two kinds of finding. Same section order, committed framing. Flagged
here so the abstract pass does not quietly restore the hedge.

## Open items carried into Stage 2

| item | blocks | expected |
|---|---|---|
| `nodelguard-r2`/`-r3` (S3 to n=3) | §4.1 hedge removal | tonight, ~21:00–22:15 |
| `c1-verbatim-k32` | §4.2 exchange-rate sentence | tonight, ~19:40 |
| Prior-art S1/S2/S3 | novelty claims in §3.1, §3.4, §4.1 | in flight |
| Judge-matched runs | **every absolute in §2** | not scheduled — decision needed |

The last one is the only one with no owner. It is listed as blocking in
`open-before-submission.md` and nothing currently schedules it.
