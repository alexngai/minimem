# Prior art — S3 (answer-level metrics cannot distinguish forgetting from silence)

Run directly, not via subagent. Date: 2026-08-02.

**Provenance discipline.** Papers marked **[fetched]** were retrieved and read at the linked
URL, with authors and venue confirmed. Papers marked *[snippet]* appeared in search results
only and are **not** yet verified — do not cite these without fetching them first.

## 1. Verdict

**PARTIAL-OVERLAP, and the overlapping part is the part we were treating as the headline.**

The general form of S3 — that output-level unlearning metrics reward refusal and cannot
distinguish non-disclosure from removal — **is published**, explicitly and recently, as a
position paper. What survives is narrower than the claims ledger currently assumes: the
*setting* (retrieval-backed agent memory rather than weight-level unlearning), the
*demonstration on a shipped leaderboard metric* rather than a purpose-built diagnostic, and
the quantification. That is still a contribution. It is not the contribution
`contributions.md` currently describes, and §4.1 needs rewriting before it is defensible.

## 2. Nearest prior work

### 1. Position: The Term "Machine Unlearning" Is Overused in LLMs **[fetched]**
Sangyeon Yoon, Yeachan Jun, Albert No. arXiv 2606.27379 (submitted 2026-05-08).
https://arxiv.org/abs/2606.27379

**This is the strongest pre-emption.** Its abstract states that metrics and benchmarks are
"frequently reused outside their intended scope, **rewarding surface-level non-disclosure**
(e.g., low ROUGE/forget accuracy) even when retraining-equivalence is not tested," and it
argues directly that models can score well "through techniques like refusal while retaining
underlying information." That is S3's general claim, stated as the paper's thesis.

**Does not pre-empt:** the setting is dataset-defined deletion at training level, not
retrieval. It argues the point taxonomically (metrics are misapplied across objectives) and
calls for stricter terminology; it does not exhibit a shipped benchmark whose primary metric
is *optimised* by retaining everything, and has no analogue of an answer-vs-context control.

### 2. MemLeak: Diagnosing Information Leaks in Multimodal Agent Memory **[fetched]**
Kuan Wang, Chao Zhang (Georgia Institute of Technology). arXiv 2606.29788v1 (2026-06-29).
https://arxiv.org/abs/2606.29788

**Closest in setting, and five weeks old.** Evaluates agent memory systems (Long-context,
Naive, Mem0, Letta, Oracle) on whether deleted facts stay recoverable from retained user data,
and argues for **fact-level** rather than **record-level** forgetting. Reports that direct
probing of deletion-capable systems yields <1% recovery while retained correlated text enables
18.3% and retained images 12.0%. Systems that "implement deletion only at the text/record
level" are named as the vulnerable class.

**Does not pre-empt:** it makes no claim that a metric *rewards* not deleting. Its metrics are
leakage rates where lower is better, and it builds its own diagnostic benchmark rather than
showing an existing leaderboard metric inverting. But it occupies our setting, tests the same
system class, and reaches a compatible conclusion by a different route. **Not citing it would
read as not knowing the literature.**

### 3. Position: LLM Unlearning Benchmarks are Weak Measures of Progress **[fetched]**
Pratiksha Thaker, Shengyuan Hu, Neil Kale, Yash Maurya, Zhiwei Steven Wu, Virginia Smith.
IEEE SaTML '25. arXiv 2410.02879. https://arxiv.org/abs/2410.02879

Benign modifications to popular unlearning benchmarks reveal that supposedly unlearned
information remains accessible. Core critique is loose forget/retain dependencies and
ambiguous unlearning targets permitting overfitting to test queries.

**Does not pre-empt:** on fetch, it does *not* make the answer-vs-context or
refusal-vs-forgetting argument specifically. It is the canonical "these benchmarks are weak"
citation and belongs in our related work as the precedent for benchmark-critique-as-position.

### 4. Unlearning Isn't Deletion: Investigating Reversibility of Machine Unlearning in LLMs *[snippet]*
arXiv 2505.16831. https://arxiv.org/abs/2505.16831

Reported to argue that task-level metrics mislead because apparent collapse reflects
reversible suppression rather than deletion, with a representation-level toolkit proposed.
**Verify before citing.** Weight/representation level, so likely orthogonal to our mechanism,
but it is the nearest "suppression is not deletion" framing.

### 5. Others surfaced, unverified *[snippet]*
`Leak@k: Unlearning Does Not Make LLMs Forget Under Probabilistic Decoding` (2511.04934);
`SEPS: A Separability Measure for Robust Unlearning in LLMs` (2505.14832);
`SoK: Machine Unlearning for Large Language Models` (2506.09227). All weight-level. Fetch
before any is cited.

## 3. What survives

Against the four-way split the check was asked to resolve:

| candidate | status |
|---|---|
| (a) general suppression-vs-erasure point | **claimed** — 2606.27379 states it as its thesis |
| (b) a shipped benchmark's PRIMARY metric rewards not-forgetting | **survives** — no located work exhibits an existing leaderboard metric that is *optimised* by retention, validated against that benchmark's own e2e variant |
| (c) the quantification | **survives** — 77.8 answer / 0.0 e2e, 99.7% context presence |
| (d) nothing | no |

Two further things survive that the original framing did not isolate:

**The mechanism is different and strictly more auditable.** In weight-level unlearning,
"retained" means the knowledge persists in parameters and must be inferred through probes. In
our setting the retained content is **directly observable in the prompt** and countable, which
is why we can report 99.7% rather than a probe-recovery rate. The file-backed store is what
makes the observation exact, which is the same argument already logged for S7.

**The finding is adversarial to our own optimisation, not built to be found.** MemLeak
constructs a diagnostic to detect leaks. We hit this while optimising for the leaderboard
metric and were caught by an integrity check. That framing is defensible and worth keeping,
but it is a rhetorical strength, not a novelty claim, and should not be asked to carry weight.

## 4. Must-cite

Regardless of framing: 2606.27379 (pre-empts the general claim), 2606.29788 (same setting,
recent), 2410.02879 (benchmark-critique precedent). Verify and probably cite 2505.16831.

## 5. Consequences for the paper

1. **§4.1 must be rewritten.** It currently presents the answer-vs-silence conflation as a
   discovery. It has to become: this failure is established for weight-level unlearning
   (2606.27379); we show it survives into retrieval-backed memory, where the mechanism is
   entirely different, the retained content is directly observable, and the metric in question
   is a *shipped leaderboard's primary score* rather than a diagnostic.
2. **`contributions.md` S3 needs downgrading** from novel finding to novel *demonstration*,
   with the general form attributed.
3. **The related-work section now has a required block** that does not currently exist in the
   outline: LLM unlearning evaluation critique. This is a real addition to §2 or a new §7.
4. **R1 and S7 gain support rather than losing it.** MemLeak's record-level-vs-fact-level
   distinction is independent corroboration of the erasure decomposition, arrived at by a
   different method on different systems.

## 6. Search log

- `machine unlearning evaluation metrics measure suppression not removal LLM`
- `LLM unlearning benchmark refusal is not forgetting evaluation critique`
- `RAG retrieval memory deletion evaluation context-level versus answer-level leakage benchmark`
- Direct fetches: arxiv.org/abs/2410.02879, arxiv.org/html/2606.29788, arxiv.org/abs/2606.27379

**Bound of this search.** Three query formulations plus three fetches. Not exhaustive. Not yet
covered: ACL Anthology full-text, USENIX Security / IEEE S&P / CCS proceedings, and the
privacy-compliance (GDPR right-to-erasure) literature, any of which could hold a closer
pre-emption. Worth one more pass before submission.
