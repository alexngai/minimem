# Prior-art novelty check — S2

**Claim under test (S2):** "Given identical retrieval, model capability buys governance but COSTS utility, and
the trade saturates. Across three backbones on identical retrieval and prompt, task utility DECREASES
monotonically with capability (85.4 → 79.4 → 77.8) while governance improves (access-control violations
19.8 → 6.6, deletion leakage 10.5 → 0.9) and over-refusal climbs (2.3% → 16.6%). The weakest model is the
MOST USEFUL one. Over-refusal is the mechanism linking the two. Practical consequence: retrieval-QA can be
served by a cheap model and served BETTER, while governance cannot; and buying a newer model stops being a
governance strategy past a point."

**Search date:** 2026-08-02. **Reading tiers used below:** `READ: FULL TEXT`, `READ: ABSTRACT`,
`SNIPPET ONLY`, `UNVERIFIED`.

---

## 1. Verdict

**PARTIAL-OVERLAP.**

Every component of S2 has published prior art, but no single work found here states the composite claim under
retrieval-controlled conditions. The safety↔over-refusal trade is mature and well-instrumented (XSTest,
OR-Bench). The alignment-tax literature establishes that safety training costs task capability. Inverse
scaling establishes that capability can be anti-correlated with graded task performance. Most seriously, the
**GateMem benchmark paper itself — which S2 appears to build on — already defines the identical over-refusal
metric, contains a numbered finding titled "Backbone choice changes the utility–risk trade-off," and observes
that its weakest backbone "often attains high utility but suffers from much higher active-forgetting failures
and access-control violations."** That is the weak-model-is-more-useful observation, in the memory-governance
setting, already in print. Separately, arXiv:2606.14476 publishes the structurally identical shape —
capability monotonically buys a compliance-like behavior while costing task utility — one setting over, in
tool deference. What survives is narrow but real: the retrieval-and-prompt-controlled isolation of capability
as sole variable, the monotone *utility decline*, over-refusal as the identified *cross-backbone* mechanism,
saturation, and the routing consequence. The dominant risk to flag is that S2's monotonicity **contradicts**
GateMem's own Table 3 as well as POLAR-Bench and MuPPET; novelty by contradiction is legitimate but shifts the
burden of proof onto this paper, and n=3 backbones is two comparisons carrying the word "monotonic."

---

## 2. Nearest prior work

Ranked most-threatening first.

### [1] GateMem: Benchmarking Memory Governance in Multi-Principal Shared-Memory Agents
- **Authors:** Zhe Ren, Yibo Yang, Yimeng Chen, Zijun Zhao, Benshuo Fu, Zhihao Shu, Bingjie Zhang, Yangyang Xu, Dandan Guo, Shuicheng Yan
- **Venue/ID:** arXiv:2606.18829 (preprint, June 2026)
- **URL:** https://arxiv.org/abs/2606.18829
- **Reading tier:** `READ: FULL TEXT` — PDF fetched and text extracted (24 pages); all quotes below are verbatim from that extraction.
- **What it claims:** Shared-memory governance is unsolved — across baselines and backbones, no method
  simultaneously achieves strong utility, robust access control, and reliable forgetting.
- **Pre-empts S2? SUBSTANTIALLY — this is the paper to beat.**
  - Defines S2's mechanism metric exactly: *"To monitor overly conservative behavior, we also track the
    over-refusal rate OR = 1/N_u Σ_{n∈C_u} 1[â_n ≠ answer]."*
  - Has a numbered finding **"(4) Backbone choice changes the utility–risk trade-off"**: *"Stronger backbones
    such as GPT-5.4 and Deepseek-V4-Pro substantially improve the best observed governance scores… Gemini-2.5-
    Flash-Lite often attains high utility but suffers from much higher active-forgetting failures and
    access-control violations."*
- **Does NOT pre-empt:** (a) **Monotonicity** — its Table 3 Medical/Long-Context utility by backbone is
  GPT-5.4 **91.4**, Deepseek-V4-Pro 87.1, GPT-5-mini 85.7, Llama-4-Maverick 85.2, Gemini-2.5-Flash-Lite 84.8,
  GPT-4o-mini 64.8. The *strongest* model has the *highest* utility; no monotone decline exists in its data.
  (b) **Over-refusal across backbones** — Fig. 3(b) is method-wise on a single backbone (GPT-4o-mini):
  Long-Context 24.8, Naive RAG 44.8, Policy RAG 63.3, A-Mem 57.6, Mem0 41.9, ReMeM-I 51.9, ReMeM-S 55.2. The
  conclusion drawn is about *methods*, not capability. (c) Saturation. (d) The routing consequence.
- **Presentational hazard:** S2's reported row (85.4 / A=19.8 / F=10.5) sits close to GateMem's GPT-5-mini
  Long-Context Medical row (85.7 / 19.8 / 20.3). The paper must state explicitly that its sweep is a new,
  retrieval-controlled run, or a reviewer will read it as an undeclared restatement of Table 3.

### [2] When the Tool Decides: LLM Agents Defer Blindly to Graph Neural Network Tools, and Stronger Backbones Defer More
- **Authors:** Zhongyuan Wang, Pratyusha Vemuri
- **Venue/ID:** arXiv:2606.14476
- **URL:** https://arxiv.org/abs/2606.14476
- **Reading tier:** `READ: ABSTRACT`
- **What it claims:** Agent agreement with tool output rises monotonically with backbone capability
  (0.60 → 0.98 from 1.5B to 7B), and *"the cost of deference does not shrink as capability grows and grows
  where alternatives emerge."*
- **Pre-empts S2? ON STRUCTURE, NOT SUBJECT.** It publishes the exact rhetorical shape of S2 — capability
  monotonically buys a compliance-like behavior while costing task utility — one setting over (tool deference,
  not memory governance; deference, not refusal). S2 cannot claim the *shape* of the finding as novel.
- **Unresolved discrepancy:** a search snippet rendered this as agreement that *"saturates near 1,"* but the
  fetched abstract makes no saturation claim. **The saturation attribution is UNVERIFIED.** If S2 claims
  saturation as a novel contribution, this paper must be read in full first.

### [3] OR-Bench: An Over-Refusal Benchmark for Large Language Models
- **Authors:** Jiaxing Cui, Wei-Lin Chiang, Ion Stoica, Cho-Jui Hsieh
- **Venue/ID:** ICML 2025 (poster 46052); arXiv:2405.20947
- **URL:** https://icml.cc/virtual/2025/poster/46052
- **Reading tier:** `READ: ABSTRACT` (ICML poster page fetched)
- **What it claims:** 80k prompts across 10 rejection categories; measures over-refusal in 32 LLMs across 8
  model families and reports a trade-off between safety and helpfulness.
- **Pre-empts S2? PARTIALLY.** It pre-empts "over-refusal rises with safety across models," a large part of
  S2's mechanism. It does not measure task utility at fixed retrieval, is not agentic or memory-based, and
  does not order models by capability.
- **Caveat:** the widely quoted Spearman correlation of 0.878 between safety score and over-refusal came from
  a **search snippet, not the fetched page — treat that number as UNVERIFIED**; the qualitative claim is
  verified.

### [4] The Refusal–Compliance Tradeoff: A Large-Scale Safety Behavior Audit of Large Language Models
- **Authors:** Alif Al Hasan, Sumon Biswas
- **Venue/ID:** arXiv:2605.05427
- **URL:** https://arxiv.org/abs/2605.05427
- **Reading tier:** `READ: ABSTRACT`
- **What it claims:** Audits 21 open-weight models over 4 benchmarks; argues refusal rates are a poor safety
  proxy, and that *"refusal and compliance tendencies are stable within model families across generations and
  scales,"* i.e. post-training objectives shape safety behavior more than architecture or model size.
- **Pre-empts S2? NO — but it directly attacks S2's independent variable.** This is the paper a reviewer will
  use to reframe "capability" as "post-training recipe." Must be cited and rebutted head-on.

### [5] Is Capability a Liability? More Capable Language Models Make Worse Forecasts When It Matters Most
- **Authors:** Nick Merrill, Jaeho Lee, Ezra Karger
- **Venue/ID:** arXiv:2605.22672
- **URL:** https://arxiv.org/abs/2605.22672
- **Reading tier:** `READ: ABSTRACT`
- **What it claims:** Inverse scaling in distributional forecasting on superlinear-growth / tail-risk
  structure; both model scale and post-training contribute independently; the failure is upper-tail
  extrapolation and is explicitly *not* refusal or hedging.
- **Pre-empts S2? NO.** Closest published "more capable → worse on the graded task" result, so it is a strong
  framing precedent, but the task, mechanism, and setting all differ.

### [6] Inverse Scaling: When Bigger Isn't Better
- **Authors:** Ian McKenzie, Alexander Lyzhov, et al. (full author list not captured)
- **Venue/ID:** TMLR 2023; arXiv:2306.09479
- **URL:** https://arxiv.org/abs/2306.09479
- **Reading tier:** `SNIPPET ONLY` — existence strongly corroborated by four independent results (arXiv abs
  page, NSF PAGES record, Semantic Scholar, NASA ADS). I did not fetch the abstract.
- **What it claims:** Empirical inverse scaling on 11 datasets from the Inverse Scaling Prize; four proposed
  causes (preference to repeat memorized sequences, imitation of undesirable training patterns, easy distractor
  tasks, misleading few-shot demonstrations).
- **Pre-empts S2? NO.** Establishes the phenomenon class S2 belongs to. None of its four causes is
  over-refusal; no retrieval or governance task.

### [7] POLAR-Bench: A Diagnostic Benchmark for Privacy-Utility Trade-offs in LLM Agents
- **Authors:** Qiaoyuan Zheng, Yiqu Yang, Qi Gao, Imanol Schlag
- **Venue/ID:** arXiv:2605.19127
- **URL:** https://arxiv.org/abs/2605.19127
- **Reading tier:** `READ: ABSTRACT`
- **What it claims:** Frontier models withhold over 99% of protected attributes, while smaller open-weight
  models in the 1–30B range score notably worse, the weakest leaking over half.
- **Pre-empts S2? NO — and points the opposite way.** Same governance-improves-with-capability direction as
  GateMem, with no utility inversion and no over-refusal metric. Closest tier-comparison paper in S2's setting
  that nonetheless leaves S2's core claim open, while raising S2's burden of proof.

### [8] XSTest: A Test Suite for Identifying Exaggerated Safety Behaviours in Large Language Models
- **Authors:** Paul Röttger, Hannah Kirk, Bertie Vidgen, Giuseppe Attanasio, Federico Bianchi, Dirk Hovy
- **Venue/ID:** NAACL 2024
- **URL:** https://aclanthology.org/2024.naacl-long.301/
- **Reading tier:** `SNIPPET ONLY` — existence strongly corroborated (canonical ACL Anthology URL plus the
  first author's GitHub repository both returned independently). I did not fetch either.
- **What it claims:** 250 safe and 200 unsafe prompts diagnosing models that refuse clearly safe prompts when
  they resemble unsafe ones.
- **Pre-empts S2? NO.** Originates the exaggerated-safety construct S2 depends on; no capability ordering, no
  utility metric, no memory setting.

### [9] MuPPET: A Benchmark for Contextual Privacy of LLM Assistants in Multi-Party Conversations
- **Authors:** Elena Sofia Ruzzetti, Cornelius Emde, Sangdoo Yun, Seong Joon Oh, Martin Gubri
- **Venue/ID:** arXiv:2606.23217
- **URL:** https://arxiv.org/abs/2606.23217
- **Reading tier:** `READ: ABSTRACT`
- **What it claims:** Frontier models are vulnerable on contextual privacy and smaller open-weight models more
  so; existing contextual privacy defences *"offer only partial protection, degrade utility, and do not resolve
  the underlying party-tracking problem."*
- **Pre-empts S2? NO.** Establishes defence→utility cost, but attributes it to the defence, not to backbone
  capability. Points opposite to S2 on the governance axis.

### [10] Steering Over-refusals Towards Safety in Retrieval Augmented Generation
- **Authors:** Utsav Maskey, Mark Dras, Usman Naseem
- **Venue/ID:** arXiv:2510.10452
- **URL:** https://arxiv.org/abs/2510.10452
- **Reading tier:** `READ: ABSTRACT`
- **What it claims:** Context arrangement/contamination, query and context domain, and harmful-text density
  trigger refusals even on benign queries in RAG; proposes SafeRAG-Steering, a model-agnostic embedding
  intervention.
- **Pre-empts S2? NO.** The one found paper placing over-refusal specifically in the retrieval setting, and
  therefore the closest prior work to "over-refusal is what costs you retrieval utility" — but it runs **no
  backbone comparison**, so the capability axis is untouched.

### [11] Cross-Generational Transfer of Adversarial Attacks Reveals Non-Monotonic Safety Alignment in LLMs
- **Authors:** NOT CAPTURED — **UNVERIFIED**
- **Venue/ID:** arXiv:2606.00813
- **URL:** https://arxiv.org/abs/2606.00813
- **Reading tier:** `READ: ABSTRACT` (authorship unverified)
- **What it claims:** Attack success rates across Gemma generations are 45.5% → 68.7% → 33.9% (Gemma 2 → 3 →
  4), i.e. safety alignment across generations is non-monotonic.
- **Pre-empts S2? NO — but it bounds S2.** Direct counter-evidence to any *general* monotonicity-in-capability
  claim. S2 must scope its monotonicity to its three backbones and its specific metrics.

### [12] SafeSearch: Do Not Trade Safety for Utility in LLM Search Agents
- **Authors:** NOT CAPTURED — **UNVERIFIED**
- **Venue/ID:** arXiv:2510.17017
- **URL:** https://arxiv.org/abs/2510.17017
- **Reading tier:** `READ: ABSTRACT` (authorship unverified)
- **What it claims:** Search agents become less safe than their base models when retrieving; proposes a
  finetuning approach that maintains QA performance comparable to a utility-only finetuned agent.
- **Pre-empts S2? NO.** Single 7B model, no capability sweep, no over-refusal metric. Relevant only as
  retrieval-setting safety/utility framing.

### [13] Tradeoffs Between Alignment and Helpfulness in Language Models (with Steering Methods)
- **Authors:** NOT CAPTURED — **UNVERIFIED**
- **Venue/ID:** arXiv:2401.16332
- **URL:** https://arxiv.org/abs/2401.16332
- **Reading tier:** `SNIPPET ONLY` — the arXiv ID appeared consistently across two independent searches; not
  fetched.
- **What it claims:** An alignment-versus-helpfulness frontier under representation-engineering steering.
- **Pre-empts S2? NO.** The canonical intervention-level "you cannot have both" citation.

### UNVERIFIED — do not cite without independent checking

- **The most important unresolved item in this search.** A search summary asserted that *"model size is not a
  noticeable factor when analyzing over-refusal across varying scales."* If real, this **directly contradicts
  S2's claim that over-refusal climbs with capability.** I attempted attribution to FalseReject
  (arXiv:2505.08054, `READ: ABSTRACT`) and could not confirm — its abstract contains no such statement.
  Candidate alternatives seen in results but not fetched: arXiv:2511.19009 ("Understanding and Mitigating
  Over-refusal for Large Language Models via Safety Representation"), arXiv:2602.12092 ("DeepSight: An
  All-in-One LM Safety Toolkit"). **This should be chased down before S2 is written up.**
- "What Is the Alignment Tax?" arXiv:2603.00047 — one result title attributed it to "Robin Young"; could not
  confirm the paper exists as described.
- "Explaining and Breaking the Safety-Helpfulness Ceiling via Preference Dimensional Expansion"
  arXiv:2605.11679 — snippet only.
- Alignment-tax numerics quoted in a search summary (OpenLLaMA-3B, reward 0.16→0.35 costing 16 points SQuAD
  F1, 17 points DROP F1, 5.7 BLEU) appeared with **no attributable source paper**. Do not use.
- A "See-Saw" safety-versus-over-rejection finding (Qwen3-VL-8B ranking first on Safety and worst on
  Over-rejection), possibly arXiv:2601.10527 — directionally supports S2's mechanism, source unconfirmed.

---

## 3. What survives

**Pre-empted — concede and cite:**

- Safety training ⇒ over-refusal — [8] XSTest, [3] OR-Bench.
- Safety ⇒ utility cost in general — [13], alignment-tax literature.
- Capability ⇒ worse on some graded tasks — [6] Inverse Scaling, [5] Merrill et al.
- Governance improves with backbone strength **in this exact benchmark** — [1] GateMem, [7] POLAR-Bench,
  [9] MuPPET.
- Over-refusal as a diagnostic in agent memory governance, under the **identical operational definition** —
  [1] GateMem §3.3 and Fig. 3(b).
- The general *shape* "capability buys compliance-like behavior but costs utility, monotone in backbone
  strength" — [2] arXiv:2606.14476.

**Unclaimed, in descending order of defensibility:**

1. **The memory/retrieval-specific setting under strict control.** Holding retrieval *and* prompt identical
   while varying only the backbone isolates capability as the sole independent variable. GateMem's backbone
   comparison confounds this — it varies backbone across seven different memory methods and reports the
   composite MGS, not a controlled utility curve. **This is the methodological contribution and the safest
   thing to lead with.**
2. **Over-refusal as the *cross-backbone* linking mechanism** (2.3% → 16.6%). GateMem establishes that
   over-refusal explains *method*-level utility loss; nothing found establishes that it explains
   *capability*-level utility loss. Cleanest unclaimed piece — but it needs a mediation-style analysis rather
   than co-movement, and it is directly exposed to the unattributed "model size is not a noticeable factor"
   claim above.
3. **The "a cheaper model serves retrieval-QA better *and* cheaper" consequence.** The routing literature
   (RouteLLM and successors) routes on difficulty and quality, not on a governance-versus-utility split. No
   found work proposes splitting these two axes across backbones. Unclaimed.
4. **Monotonic utility decline** (85.4 → 79.4 → 77.8). Not reported anywhere found — but novel *because it
   contradicts* [1], [7], and [9]. n=3 is two comparisons; [4] will be used to argue the ordering is a
   post-training artifact rather than a capability effect. Recommend reporting it as monotone *in this sweep*,
   pre-registering the capability ordering, and adding backbones or seeds if at all possible.
5. **Saturation of the governance return.** No prior work found makes this claim in the memory-governance
   setting. **Weakest of the five**, because [2] may already claim saturation in the deference setting —
   resolve that before asserting novelty. The general "scaling shows diminishing returns" discourse is blog-
   and press-level, not citable for this claim.

---

## 4. Must-cite

Negligent to omit:

- **[1] GateMem** (arXiv:2606.18829) — the benchmark. Its finding (4) and Fig. 3(b) must be cited **and
  explicitly distinguished**; not doing so reads as an undeclared restatement.
- **[8] XSTest** (Röttger et al., NAACL 2024) — origin of the over-refusal construct.
- **[3] OR-Bench** (Cui et al., ICML 2025) — the cross-model safety↔over-refusal result.
- **[6] Inverse Scaling** (McKenzie et al., TMLR 2023) — names the phenomenon class.
- **[2] When the Tool Decides** (arXiv:2606.14476) — the same claim shape one setting over; omitting it would
  look like avoidance.
- **[4] Refusal–Compliance Tradeoff** (Hasan & Biswas, arXiv:2605.05427) — the strongest published objection to
  the capability framing.
- **[5] Is Capability a Liability?** (Merrill et al., arXiv:2605.22672) — closest capability-is-a-liability
  precedent.
- **[10] Maskey et al.** (arXiv:2510.10452) — over-refusal in RAG specifically.

Strongly recommended:

- **[7] POLAR-Bench** and **[9] MuPPET** — both point the other way on the governance axis; citing them
  strengthens rather than weakens the retrieval-controlled framing.
- **[11] arXiv:2606.00813** — bounds how broadly the monotonicity claim may be stated.

---

## 5. Search log

Queries 1–14 were general web searches. Queries 15–16 were domain-restricted to `aclanthology.org` and were
**added later, at the coordinator's request**, after the initial sweep.

1. `over-refusal exaggerated safety benchmark stronger models refuse more false refusal`
2. `inverse scaling more capable models perform worse task utility safety tradeoff`
3. `alignment tax safety helpfulness tradeoff RLHF capability monotonic degradation utility`
4. `agent memory access control violation deletion leakage benchmark model capability comparison`
5. `RAG retrieval QA smaller model outperforms larger model identical retrieval context over-refusal`
6. `"over-refusal" OR "over-conservative" retrieval-augmented generation memory privacy utility tradeoff backbone model scale`
7. `"stronger models" safety "less helpful" monotonic across model generations fixed task benchmark helpfulness declines`
8. `"capability does not" buy safety governance "newer model" not a safety strategy saturation over-refusal mechanism`
9. `XSTest exaggerated safety behaviours test suite Röttger identifying exaggerated safety NAACL 2024`
10. `over-refusal rate increases with model capability newer model generations over-rejection see-saw safety benchmark GPT-5 Gemini 3`
11. `privacy-aware assistant benchmark stronger model better privacy worse helpfulness ConfAIde PrivacyLens over-refusal capability`
12. `"Inverse Scaling Prize" McKenzie "When Bigger Isn't Better" TMLR eleven tasks larger models worse`
13. `"diminishing returns" model capability safety compliance saturates buying bigger model not a safety strategy agent governance`
14. `route retrieval QA to cheaper model governance to stronger model heterogeneous model routing memory agent cost`
15. *(ACL sweep, added later)* `over-refusal backbone model capability utility tradeoff retrieval agent` — restricted to `aclanthology.org`
16. *(ACL sweep, added later)* `stronger LLM lower task utility over-refusal safety helpfulness across model scale` — restricted to `aclanthology.org`

**Direct fetches:** `arxiv.org/abs/` for 2605.05427, 2606.18829, 2605.22672, 2510.10452, 2605.19127,
2606.23217, 2606.00813, 2606.14476, 2510.17017, 2505.08054; `arxiv.org/pdf/2606.18829` (**full text extracted
and read**); `alphaxiv.org/abs/2606.18829v1`; `icml.cc/virtual/2025/poster/46052`; `aclanthology.org/search`
(**failed** — see below).

### Coverage bounds — stated plainly

- **ACL Anthology coverage is WEAK, and should be treated as NOT ESTABLISHED.** The sweep was run as
  requested, but the two domain-restricted queries returned predominantly arXiv results — the domain filter did
  not hold — with a single genuine Anthology hit ("Building Helpful-Only Large Language Models," Findings of
  IJCNLP 2025, not pursued as it concerns helpful-only model construction rather than capability sweeps). A
  direct fetch of the Anthology search endpoint failed because results are rendered client-side via Google
  Custom Search. **A human-run Anthology search for "over-refusal" + "backbone" is worth ten minutes and would
  materially tighten this report.**
- **NeurIPS / ICLR / ICML and OpenReview full-text were not queried directly**, only reached through general
  web search. ICML was touched only via the OR-Bench poster page.
- **Non-English literature was not covered.**
- **Only GateMem was read in full.** Ten papers were read at abstract level; two entries rest on search
  snippets with strong multi-source corroboration; five items sit in the explicit UNVERIFIED bucket.
- **The single most consequential open item** is the unattributed claim that model size is not a noticeable
  factor in over-refusal across scales. If it is real and well-supported, it undercuts S2's stated mechanism.
  It should be resolved before the S2 section is written.
- Extracted GateMem full text, from which all [1] quotations and Table 3 figures are taken, was written to
  `/private/tmp/claude-501/-Users-alexngai-GitHub-minimem/31756da7-08de-45cb-8e4a-88b6e2b6a9f7/scratchpad/gatemem.txt`
  (session scratchpad; may not persist).
