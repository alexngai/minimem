# LOCOMO benchmark harness

Head-to-head evaluation of **minimem + [cognitive-core](https://github.com/alexngai/cognitive-core)** against other open-source memory systems on the [LOCOMO](https://github.com/snap-research/locomo) long-term conversational-memory benchmark.

> **Claim under test:** on LOCOMO, minimem + cognitive-core (memory-only) matches or beats mem0 and Letta on answer accuracy at competitive cost — reproducibly, from this repo.

## The fair-fight principle

Every system shares the **same base LLM (Azure GPT-5.5)** for both memory extraction *and* final answer generation, and the **same judge**. The only thing that varies between arms is the memory layer. Each system is wrapped in a common `MemorySystemAdapter` (`adapters/types.ts`) so orchestration and cost accounting are identical.

### Arms

| Arm | Memory layer | Notes |
|---|---|---|
| `minimem+cogcore` | cognitive-core `MemorySystem` (semantic/knowledge memory ON, **learning + playbook/skill-extraction channels OFF**), minimem as retrieval backend | the system we're promoting |
| `mem0` | pinned OSS `mem0ai` (JS SDK), self-hosted vector store | competitor |
| `letta` | pinned OSS Letta server (Docker), TS client | competitor |
| `minimem-alone` | raw minimem retrieval, no extraction | baseline — quantifies what cognitive-core's extraction adds |

cognitive-core already depends on minimem, so `minimem+cogcore` is the stack working as designed.

## Dataset

`locomo10.json` (snap-research/locomo, ~2.8 MB) — 10 multi-session conversations, **1986 QA pairs** across 5 categories. Downloaded + cached on first run (`cache/`, gitignored).

Verified distribution (`npx tsx evals/locomo/dataset.ts`):

| Category | id | Count | Scored? |
|---|---|---|---|
| single-hop | 4 | 841 | ✅ |
| temporal | 2 | 321 | ✅ |
| multi-hop | 1 | 282 | ✅ |
| open-domain | 3 | 96 | ✅ |
| adversarial | 5 | 446 | ❌ excluded from headline accuracy (LOCOMO/mem0 convention) |

Sessions/conversation: 19–32; 5882 turns total.

## Metrics (`metrics.ts`)

- **Accuracy** — LLM-as-judge correctness, per category and overall (adversarial excluded), with **bootstrap 95% CIs** (seeded, reproducible).
- **Cost axis** — token totals/means and latency **p50/p95** for both ingest and answer phases. Reported alongside accuracy, never accuracy alone (mem0-paper convention).

## Judge (`judge.ts` — next increment)

LLM-as-judge using Azure GPT-5.5. Because the answer model and judge share a family, the judge is **validated against a small human-labeled sample** and its agreement rate reported; the judge score is treated as a lower bound.

## Rigor checklist

- Pinned competitor versions (recorded in results).
- Seeded; run over all 10 conversations.
- Bootstrap CIs, not point estimates.
- Test set scored once; no tuning against it.
- Cost axis always reported with accuracy.

## Configuration

Azure GPT-5.5 credentials come from the environment (see `~/.zshrc`):

```
AZURE_API_KEY  AZURE_OPENAI_API_KEY  AZURE_API_BASE  AZURE_API_VERSION
```

## Layout

```
evals/locomo/
├── dataset.ts     # download + cache + typed loader  (DONE)
├── types.ts       # raw + normalized schema, adapter + result contracts  (DONE)
├── metrics.ts     # accuracy, cost, bootstrap CIs  (DONE)
├── adapters/      # one per arm  (TODO)
├── judge.ts       # LLM-as-judge + human-label validation  (TODO)
├── run.ts / cli.ts# orchestration, resumable cache  (TODO)
├── results/       # committed JSON + Markdown  (TODO)
└── cache/         # dataset cache (gitignored)
```

## Running

```bash
# load Azure GPT-5.5 creds, then:
npx tsx evals/locomo/run.ts --conversations 1 --questions 30 --topk 8 \
  --out evals/locomo/results/dryrun.json
```

Flags: `--conversations N`, `--questions N` (0 = all, stratified sample), `--systems a,b`, `--topk N`, `--seed N`, `--out path`.

## Dry-run findings (conv-26, 30 stratified Q, minimem-alone)

| Metric | Value |
|---|---|
| Overall accuracy (excl. adversarial) | 62.5% (15/24), 95% CI [41.7, 79.2] |
| single-hop | 100% (6/6) |
| open-domain | 83.3% (5/6) |
| temporal | 66.7% (4/6) |
| **multi-hop** | **0% (0/6)** |
| adversarial (refusal) | 0/6 |
| Cost | ~827 tok/q (594 answer + 233 judge); completion ~59 tok/call |

Takeaways:
- **Token cost is trivial:** full LOCOMO ≈ 1.64M tok/arm, ~6.6M tokens for 4 arms.
- **Wall-clock is the constraint:** ~7s/call sequential → the full 4-arm run (~15.9k calls) is ~30h. **The runner needs request concurrency before the full run.**
- **multi-hop 0%** is the retrieval-only ceiling — the gap cognitive-core's extraction/knowledge layer is expected to close. This is the baseline the `minimem+cogcore` arm must beat.
- Adversarial refusal is low in `natural` answer mode; may need a refusal-aware prompt for category 5.

## Status

- [x] Dataset loader + cache, verified against real data
- [x] Normalized types + adapter/result contracts
- [x] Metrics (accuracy, cost, bootstrap CIs)
- [x] Judge (mem0 J-judge, verbatim) + answer prompt
- [x] Azure GPT-5.5 client (reasoning-model aware, usage accounting)
- [x] `minimem-alone` adapter + runner + **dry run** (real cost estimate)
- [x] Bounded-concurrency question pool (`--concurrency`, ~6-7x speedup)
- [x] `cogcore-retrieval` adapter (cognitive-core KnowledgeBank + injected minimem SearchProvider, BM25 or local-embedding hybrid)
- [ ] `cogcore-memory` adapter (LLM extraction → entity consolidation, playbooks off)
- [ ] `mem0`, `letta` adapters
- [ ] Human-label validation of the judge
- [ ] Full 10-conversation run + published results (JSON+MD)

## Embeddings

This Azure resource has no embeddings deployment and no OpenAI/Gemini keys are
present, so the shared embedder is **minimem's local model** (`--embeddings local`,
default; `none` = BM25). Swappable for a hosted provider later.

## The cogcore arms use OUR minimem

cognitive-core is used memory-only (no playbooks / learning pipeline). Rather
than let it use its own bundled minimem, we inject the repo's minimem as
cognitive-core's `SearchProvider` (`MinimemSearchProvider`), so the arm is
genuinely "this minimem + cognitive-core".

Next gate: build `cogcore-memory` (extraction arm), then run the ladder.
