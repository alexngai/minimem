# Prior-art novelty check: S1

**Claim under test (S1):** Access control for a shared agent-memory store belongs at
generation time, not at retrieval time. Filtering retrieval by the asker's
authorization is actively counterproductive. The mechanism: a large fraction of
privacy checkpoints in multi-principal memory benchmarks expect a REDACTED ANSWER,
which requires the system to POSSESS the record in order to withhold its specifics.
A retrieval-side filter leaves nothing to redact, and additionally collapses
"refuse" into "no memory found", which is a different and wrong response.
Empirically, retrieving broadly and letting the language model make the disclosure
judgment achieves the lowest access-control violation rate on a 43-method
leaderboard, beating systems built around explicit policy layers, with no
access-control machinery at all.

**Date of search:** 2026-08-02
**Scope:** arXiv, ACL Anthology (indirect), general web. See §5 for bounds.
**Excluded by instruction (already logged by the team):** MemClaw / "Governed Shared
Memory for Multi-Agent LLM Systems" (arXiv:2606.24535); RAG-unlearning
insufficiency work (2410.15267, 2607.27539, 2506.14576).

---

## 1. Verdict

**PARTIAL-OVERLAP.**

S1 is a conjunction of five separable claims whose novelty status differs sharply,
so a single verdict understates the picture. Decomposing:

- **C1** — the prescription: enforcement belongs at generation time, not retrieval time
- **C2** — the strong form: retrieval-side filtering is *actively counterproductive*
- **C3** — mechanism-A: redaction presupposes possession; a retrieval filter leaves nothing to redact
- **C4** — mechanism-B: retrieval filtering collapses "refuse" into "no memory found"
- **C5** — the empirical result: broad retrieval + LLM judgment attains the lowest
  access-control violation rate on a 43-method leaderboard with no AC machinery

**C4 is fully pre-empted** — an entire benchmark paper exists for exactly that
failure mode, reporting that silent filtering is catastrophically unsafe.
**C1 is pre-empted in the RAG setting** by a paper that explicitly relocates
enforcement from document access to output composition, though for an unrelated
reason (generator fabrication, not redaction). **C2 in its unqualified form is
contradicted** by a published system that performs redaction *at retrieval time*
by sanitizing chunks in place rather than dropping them — so S1's mechanism holds
only against drop-style filters and is refutable as currently worded. **C5 survives
in its specifics** but its *spirit* is already in the GateMem abstract, which
reports that long-context prompting (no retrieval filter, no AC machinery) "often
yields the best governance score." **C3 is the one component I could not find
anywhere**, and it is the strongest surviving contribution — though see §5 for why
its novelty should be treated as provisional.

| Component | Status |
|---|---|
| C1 — enforce at generation, not retrieval | Pre-empted in RAG, different rationale |
| C2 — retrieval filtering *counterproductive* | Not pre-empted, but **contradicted** by SD-RAG |
| C3 — redaction presupposes possession | **Not found — survives** |
| C4 — collapses refuse → "no memory found" | **Fully pre-empted** |
| C5 — no-AC system tops 43-method leaderboard | Survives in specifics; spirit partly in GateMem |

---

## 2. Nearest prior work

Ranked most-threatening first. Read-status is marked on every entry.

### [1] Partial Evidence Bench: Benchmarking Authorization-Limited Evidence in Agentic Systems

- **Authors:** Krti Tallam
- **arXiv:** 2605.05379v1
- **URL:** https://arxiv.org/abs/2605.05379v1
- **Status: READ** (abstract verbatim + full HTML)

**What it claims:** A deterministic benchmark (72 tasks across due diligence,
compliance audit, and security incident response) over ACL-partitioned corpora,
measuring whether a system presents an authorization-truncated answer as though it
were complete. From the abstract: "silent filtering is catastrophically unsafe
across all shipped families, while explicit fail-and-report behavior eliminates
unsafe completeness without collapsing the task into trivial abstention."

**Pre-empts S1?** **Yes — pre-empts C4 outright.** The operational finding is
precisely S1's second mechanism: ACL-filtered retrieval renders withheld evidence
indistinguishable from absent evidence. Quoted from the paper: "the visible
evidence can be coherent enough to support a polished synthesis even when it is
materially incomplete." Baseline silent filtering scores unsafe-completeness of
1.000 across all incomplete-task instances.

**What it does NOT pre-empt:** Its remedy is the opposite of S1's — it *keeps* ACL
filtering and adds a structured gap report ("fail_and_report blocks when policy
requires blocking and otherwise emits a fully structured gap report"). It never
argues for relocating enforcement to generation time, never makes the
possession-for-redaction argument, and evaluates single-turn agentic reasoning over
provided documents — not memory systems, and not a leaderboard. Its own results are
framed as preliminary, with noted transport and provider-dependency issues.

### [2] SD-RAG: A Prompt-Injection-Resilient Framework for Selective Disclosure in Retrieval-Augmented Generation

- **Authors:** Aiman Al Masoud, Marco Arazzi, Antonino Nocera
- **arXiv:** 2601.11199
- **URL:** https://arxiv.org/html/2601.11199v1
- **Status: READ** (full HTML)

**What it claims:** Selective disclosure enforced *during retrieval* by sanitizing
chunks rather than dropping them — via extractive redaction (entity masking) and
periphrastic redaction (constrained paraphrase). Quoted: "The redacted context is
hence passed to the final generation model, which only receives the minimal,
sanitized data required to perform its task."

**Pre-empts S1?** **No — but it CONTRADICTS C3 and C2 as worded, and is the paper
most likely to be used against S1 in review.** It demonstrates that retrieval-time
enforcement *can* redact. Therefore "a retrieval-side filter leaves nothing to
redact" is true only of *drop-style* filters, not sanitize-style ones. It also
argues the opposite of C1, on prompt-injection grounds: constraints must be
enforced pre-generation so that generation "remain[s] robust even under adversarial
prompting."

**Results:** up to 58% privacy improvement over baseline; 0.779 privacy score under
prompt injection vs 0.199 for baseline; 3–8% completeness cost (0.598 vs 0.689);
~1–2s added latency.

**Note:** It does *not* discuss the failure mode where filtering collapses into
refusal-indistinguishability; it assumes sufficient relevant chunks survive
redaction.

### [3] Harness-MU: A Safe, Governed, and Effective Harness for Multi-User LLM Agents

- **Authors:** Wangxuan Fan, Xiaoyu Nie, Zhongxiang Dai
- **arXiv:** 2606.21856
- **URL:** https://arxiv.org/abs/2606.21856
- **Status: READ** (full abstract verbatim; PDF body extraction failed)

**What it claims:** The direct negation of S1's prescription, in the same problem
setting. Quoted from the abstract: "governance constraints — who is authorized,
what is restricted, and whose instructions take precedence — are deterministic
runtime variables that should be enforced by execution hooks rather than entrusted
to the LLM." Reports privacy preservation "across all access-control attacks" on
the Muses-Bench benchmark, outperforming baseline by 0.28–0.39 in utility score and
improving instruction-following accuracy by up to 48.9 percentage points.

**Pre-empts S1?** **No** — it performs no retrieval-vs-generation timing analysis,
draws no redaction/refusal distinction, and evaluates on a different benchmark
(Muses-Bench, not GateMem). But it is a same-year, same-setting claim that
deterministic external enforcement beats model judgment. S1 cannot be published
without directly confronting it.

### [4] Privacy Policy Enforcement Guardrails for Data-Sensitive Retrieval-Augmented Generation

- **Authors:** Osama Zafar, Alexander Nemecek, Yiqian Zhang, Wenbiao Li,
  Debargha Ganguly, Vikash Singh, Vipin Chaudhary, Erman Ayday
- **arXiv:** 2605.17034v2 [cs.LG], 31 May 2026
- **URL:** https://arxiv.org/html/2605.17034v2
- **Status: READ** (full HTML)

**What it claims:** A two-layer output-side privacy defense — Layer 1 catches direct
identifiers via regex/NER; Layer 2 detects quasi-identifier cluster leakage using a
dual one-class density estimator with a calibrated abstention region.

**Pre-empts S1?** **Partially — this is the closest pre-emption of C1**, and it
states the generation-time thesis explicitly. Quoted: "In a RAG system, the object
exposed to the user is a generated answer... the privacy enforcement problem,
therefore, moves from document access to output composition." And: "defenses
earlier in the pipeline (corpus curation, retrieval-side filtering, prompt-level
constraints) are complementary, but cannot catch what the generator produces de
novo through synthesis or fabrication."

**What it does NOT pre-empt:** The rationale is entirely different — retrieval
filtering is *incomplete* against fabrication, never *counterproductive*. No
possession argument. Its output actions are flag (sanitize or re-prompt) / safe
(pass through) / abstain (escalate to human review), with no theoretical
distinction between redaction and refusal. Not a multi-principal memory setting.

### [5] GateMem: Benchmarking Memory Governance in Multi-Principal Shared-Memory Agents

- **Authors:** NOT CAPTURED — I did not retrieve the author list and will not
  reconstruct it. Retrieve before citing.
- **arXiv:** 2606.18829
- **URL:** https://arxiv.org/abs/2606.18829
- **Status: READ** (full abstract verbatim). PDF fetch was lossy; any claim about
  the paper *body* below is low-confidence and flagged.

**What it claims (abstract, verbatim):** "Memory benchmarks for LLM agents largely
assume single-user settings... We introduce GateMem, a benchmark for
multi-principal shared-memory agents. GateMem jointly evaluates utility for
legitimate long-horizon requests with state updates, access control across
contextual authorization boundaries, and agent-facing active forgetting after
explicit deletion requests. It spans medical, office, education, and household
domains, with long-form multi-party episodes, incremental memory injection, hidden
checkpoints, structured judging, and leak-target annotations. Across diverse
baselines and backbone models, no method simultaneously achieves strong utility,
robust access control, and reliable forgetting. Long-context prompting often yields
the best governance score at high token cost, while retrieval-based and
external-memory methods reduce cost yet still leak unauthorized or deleted
information."

**Pre-empts S1?** **Partially pre-empts C5's spirit.** "Long-context prompting often
yields the best governance score" is already a published statement that a method
with no retrieval filter and no access-control machinery wins on governance. S1's
C5 must be differentiated from this explicitly.

**What it does NOT do** (verified by targeted fetch against the abstract): it
reports no redacted-vs-refusal checkpoint split, lists no action labels in the
abstract, makes no counterproductivity argument, and draws no possession inference.

**LOW-CONFIDENCE / SNIPPET-LEVEL:** A search snippet indicated the benchmark uses
expected actions "refuse or answer_redacted" for access-control checkpoints. This is
consistent with the abstract's "leak-target annotations" but was NOT confirmed in
the body. Verify directly before relying on it — this detail is load-bearing for C3.

### [6] CIMemories: A Compositional Benchmark for Contextual Integrity of Persistent Memory in LLMs

- **Authors:** Niloofar Mireshghallah, Neal Mangaokar, Narine Kokhlikyan,
  Arman Zharmagambetov, Manzil Zaheer, Saeed Mahloujifar, Kamalika Chaudhuri
- **arXiv:** 2511.14937v1
- **URL:** https://arxiv.org/html/2511.14937v1
- **Status: READ** (full HTML)

**What it claims:** Evaluates whether LLMs appropriately control information flow
from persistent memory based on task context, with memories represented as text
prefixed to the current conversation. Frontier models show up to 69% attribute-level
violations, accumulating with use.

**Key numbers:** GPT-4o at 14.8% violations but only 43.9% completeness; Qwen-3 32B
at 57.6% completeness and 69.1% violations. GPT-5 violations rise 0.1% → 9.6% as
usage goes from 1 to 40 tasks, reaching 25.1% when the same prompt runs 5 times.
"Models correctly identify relevant information domains but cannot discern necessary
versus unnecessary details within those domains." And: "Models overgeneralize,
sharing everything or nothing rather than making nuanced, context-dependent
decisions."

**Pre-empts S1?** **No** — it proposes no enforcement mechanism at either stage and
tests no retrieval-side filtering; it evaluates model behavior *given* full memory
access. But it is the **strongest empirical objection to S1's prescription
generalizing**: it measures exactly S1's proposed regime (retrieve broadly, let the
model judge) and finds it fails badly at granular disclosure judgment.

### [7] PiSAs: Benchmarking Contextual Integrity in Multi-User Agentic Systems

- **Authors:** Shubham Gupta, Nazanin Mohammadi Sepahvand, Abhinav Kumar,
  Cem Subakan, Spandana Gella, Pierre-André Noël, Perouz Taslakian,
  Valentina Zantedeschi, Eugene Bagdasarian
- **arXiv:** 2607.05318v1
- **URL:** https://arxiv.org/html/2607.05318
- **Status: READ** (abstract + fetched analysis of body)

**What it claims:** A benchmark for unintentional privacy leaks in multi-user LLM
agent systems, using dual contextual-integrity annotations marking task
appropriateness and per-user visibility. Memory improves task completeness by 5–10
points but migrates violations into memory: "total visibility violations rise from
36–47% to 63–90%." Concludes that "data and agent partitioning is not a sufficient
mitigation strategy."

**Pre-empts S1?** **No.** It supports only a weak version of C2 — *insufficiency*,
not counterproductivity. No retrieval-vs-generation comparison, no redaction/refusal
distinction, no possession argument.

---

## 3. What survives

**C3 — the possession argument — is unclaimed.** Across all 19 queries, no paper
argues that a redacted-answer requirement logically presupposes the system holding
the record, and therefore that drop-style retrieval filtering is
category-incompatible with redaction-expecting checkpoints. Partial Evidence Bench
is the nearest miss and frames the problem *epistemically* — the answerer cannot
know what it is missing — rather than as *possession* — the answerer cannot redact
what it does not hold. These are genuinely distinct arguments. **Caveat: treat this
novelty as provisional until the declassification sweep in §5 is run.**

**C5's quantification is unclaimed** — the A-metric-specific,
43-method-leaderboard-ranked result showing a no-AC-machinery system beats systems
built around explicit policy layers. This must be defended against GateMem's own
"long-context prompting often yields the best governance score," which is the same
shape of finding. The differentiators must be stated explicitly in the paper:
(i) the access-control violation rate **A** specifically, not the composite
governance score MGS; (ii) leaderboard rank against **externally submitted** methods
including explicit policy layers, not merely the benchmark paper's own baselines.

**C2 survives only if narrowed** to: "*drop-style / ACL-partition* retrieval
filtering is counterproductive *on redaction-expecting checkpoints*." SD-RAG is a
published, empirically validated counterexample to the unqualified claim. Leaving
C2 unqualified invites rejection from any reviewer who knows that paper.

**C1 and C4 should be presented as confirmation, not contribution.** C4 in
particular should cite Partial Evidence Bench as having established it, with S1's
contribution reframed as the extension from single-turn enterprise document
retrieval to multi-principal agent memory. C1 should cite Zafar et al. as prior
statement of the generation-time thesis in RAG, with S1's contribution being the
distinct rationale and the memory setting.

---

## 4. Must-cite

Priority order. Items 1–7 were READ; items 8–10 are SNIPPET-ONLY and flagged.

1. **arXiv:2605.05379** — *Partial Evidence Bench* (Krti Tallam) — establishes C4.
   Omitting it is the single largest exposure in the paper. **READ.**
2. **arXiv:2601.11199** — *SD-RAG* (Al Masoud, Arazzi, Nocera) — the counterexample
   to C2/C3 as worded; must be explicitly distinguished. **READ.**
3. **arXiv:2606.21856** — *Harness-MU* (Fan, Nie, Dai) — the opposing thesis in the
   same setting. **READ (abstract).**
4. **arXiv:2605.17034** — *Privacy Policy Enforcement Guardrails* (Zafar et al.) —
   prior statement of C1. **READ.**
5. **arXiv:2511.14937** — *CIMemories* (Mireshghallah et al.) — strongest evidence
   against generation-time judgment scaling. **READ.**
6. **arXiv:2607.05318** — *PiSAs* (Gupta et al.) — partitioning-insufficiency in
   multi-user agents. **READ.**
7. **arXiv:2606.18829** — *GateMem* — the benchmark itself; its long-context finding
   must be distinguished from C5. **READ (abstract only).**
8. **arXiv:2405.05175** — *AirGapAgent: Protecting Privacy-Conscious Conversational
   Agents*, ACM CCS 2024 — https://arxiv.org/abs/2405.05175 — context minimization,
   the intellectual opposite of "retrieve broadly." Search results attribute a
   94%→45% protection degradation under single-query context hijacking vs 97% with
   air-gapping, and list first authors as Bagdasarian and Yi.
   **SNIPPET ONLY — abstract not fetched. Verify author list and figures.**
9. **arXiv:2408.02373** — *Operationalizing Contextual Integrity in Privacy-Conscious
   Assistants* — the CI-for-assistants anchor. **SNIPPET ONLY — no authors captured.**
10. **arXiv:2305.14888** — *Privacy Implications of Retrieval-Based Language Models*,
    EMNLP 2023 — https://aclanthology.org/2023.emnlp-main.921/ — kNN-LMs leak more
    from the private datastore than parametric models; the foundational "broad
    retrieval carries a privacy cost" result, and a direct tension with S1's
    prescription. **SNIPPET ONLY — no authors captured; Princeton-affiliated per
    search results.**

---

## 5. Search log

19 queries; 8 fetches of abstract or full text.

### Queries run

1. generation-time vs retrieval-time access control agent memory LLM
2. permission-aware retrieval augmented generation access control RAG arXiv
3. redaction versus refusal privacy benchmark LLM assistant selective disclosure
4. contextual integrity LLM assistant memory information flow privacy
5. "retrieval filtering" insufficient privacy LLM "the model" policy enforcement point
6. multi-user shared memory LLM agent access control benchmark violation rate leaderboard
7. redaction requires possession cannot redact what you did not retrieve privacy RAG argument
8. GateMem leaderboard access control violation rate best method no access control machinery
9. "generation-time" access control LLM memory instead of retrieval-time enforcement paper
10. LLM as reference monitor policy decision point model enforces authorization agent
11. access control filtered retrieval hurts utility over-refusal agent memory empirical study
12. "partial answer" OR "redacted answer" access control checkpoint agent memory benchmark withhold specifics
13. "silent filtering" unsafe access control retrieval agent "no results" versus withheld
14. "retrieve broadly" OR "unfiltered retrieval" let the language model decide disclosure privacy memory outperforms filtering
15. Muses-Bench multi-user LLM agent access control benchmark
16. AirGapAgent context minimization privacy conscious agent restrict data to task
17. access control should not be enforced by retrieval filter LLM decides disclosure counterproductive privacy agent memory 2026
18. long-context prompting best access control no retrieval filter memory agent governance outperforms policy layer
19. aclanthology privacy-aware retrieval selective disclosure memory access control refusal redaction

### Fetched (READ)

- 2605.17034v2 (HTML) — full
- 2607.05318 (HTML) — full
- 2606.18829 (abstract page) — abstract verbatim; PDF fetch lossy
- 2511.14937v1 (HTML) — full
- 2605.05379v1 (abstract page + HTML) — full
- 2606.21856 (abstract page) — abstract verbatim; PDF body extraction failed
- 2601.11199v1 (HTML) — full
- 2512.12856 (PDF) — **EXTRACTION FAILED**, structural data only, **NOT ASSESSED**

### Bounds, gaps, and things NOT established

**Highest-value untried vocabulary: "declassification."** Query 12 was the
highest-yield query and surfaced the top threat, which means near-miss prior art
likely hinges on exact terminology. The programming-languages / language-based-
security literature on *declassification policies* is the most plausible home for a
pre-LLM formulation of the possession argument (C3) — the redact-vs-drop distinction
is native to that field. **C3's novelty should be treated as PROVISIONAL until that
sweep is run.** Other untried phrasings worth a follow-up pass: "need-to-know
retrieval", "information flow control LLM", "purpose limitation RAG", "mandatory
access control agent memory", "sanitization vs suppression".

**Venue coverage is uneven — NOT ESTABLISHED.** No site-restricted searches were run
against ACL Anthology, USENIX Security, IEEE S&P, or ACM CCS. Coverage of those
venues came only indirectly through general web results. Conference papers without
arXiv preprints are underrepresented, and I cannot claim the security-venue
literature was adequately swept.

**Unassessed adjacent paper.** arXiv:2512.12856, *Forgetful but Faithful: A
Cognitive Memory Architecture and Benchmark for Privacy-Aware Generative Agents*
(author listed in search results as Saad Alqithami — SNIPPET-LEVEL confidence only).
Two fetch attempts returned PDF structural data rather than text. Topically adjacent
enough to require a manual read before submission. Saved PDF at:
`/Users/alexngai/.claude/projects/-Users-alexngai-GitHub-minimem/31756da7-08de-45cb-8e4a-88b6e2b6a9f7/tool-results/webfetch-1785713119788-0pnife.pdf`

**One attribution I could not resolve — UNVERIFIED.** A search snippet contained the
sentence that integrating requester and access-policy metadata into retrieval
"improves safety by reducing unauthorized disclosures, but often at the cost of
lower utility due to more conservative information filtering", plus a claim that
retrieval-based systems "may over-refuse authorized requesters" and that
access-control systems "may reveal protected information through natural-language
responses even when taking redacted actions." This is the closest thing I saw to a
published weak form of C2. I could NOT determine whether it originates in GateMem
(2606.18829) or in one of the surveys. **Locate the source before relying on it — it
materially affects how novel C2's framing is.**

**Snippet-only, NOT verified — do NOT cite without independent confirmation.**
I have titles and URLs but did not confirm content for any of the following:
FragFuse (2606.15609); MemLineage (2605.14421); CI-Work (2604.21308);
RedactionBench (2606.18782); PrivacyAlign (2606.21710); AgentLeak (2602.11510);
"When Should Memory Stay Silent" / RBI-Eval (2606.06055); CalBench (2605.09823);
ARBITER (2512.20535); "Beyond Similarity: Trustworthy Memory Search for Personal AI
Agents" (2606.06054); Permission-Aware RAG (ResearchGate / Seoul National University
listing, no arXiv ID found); "Integrating Access Control with Retrieval-Augmented
Generation: A Proof of Concept for Managing Sensitive Patient Profiles" (ACM SAC
2025, doi 10.1145/3672608.3707848).

**Negative result worth recording.** The security-practitioner consensus surfaced
repeatedly across queries 5, 10, and 13 — OWASP RAG Security Cheat Sheet, Microsoft
agent knowledge-retrieval guidance, and commercial authorization vendors — runs
directly opposite to S1: authorization filtering should happen *before* retrieval,
and post-retrieval filtering is described as a dangerous anti-pattern. This is not
peer-reviewed prior art and does not pre-empt S1. But it establishes that S1 is
contrarian against deployed practice as well as against Harness-MU, which
strengthens the novelty case while raising the evidentiary bar the paper must clear.
