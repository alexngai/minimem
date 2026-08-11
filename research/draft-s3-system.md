# §3 System

*Draft prose. Register: CS/ML empirical. Citation keys are placeholders pending the reference
pass; no reference is asserted that has not been read. Restructured 2026-08-04 against the
prior-art check — see [`prior-art-S0.md`](prior-art-S0.md) and
[`prior-art-synthesis.md`](prior-art-synthesis.md).*

---

The system under test is a memory store for conversational agents. Its design follows a single
rule: **keep the source, and make everything derived from it disposable and late-bound.**
Concretely, that means four refusals. Do not commit to an index, to an extracted
representation, to a retrieval-time access decision, or to a derived store. Each is described
below, along with what it costs.

## 3.1 Substrate

Memory is a directory of Markdown files. Those files are the only source of truth. Everything
else — the vector index, the full-text index, the knowledge graph, any extracted summary — is
a cache that can be deleted and rebuilt from the files without loss.

The index is a single SQLite database holding `sqlite-vec` embeddings and an FTS5 full-text
table. Retrieval fuses the two with reciprocal rank fusion (RRF), which combines ranked lists
by position and so needs no score normalisation between a cosine similarity and a BM25 score.
Chunks are embedded once and cached by content hash, so identical text embeds once across the
whole store.

**This substrate is not novel, and we do not claim it.** \citet{steffens2026vstash} describes
a local-first document memory system that combines vector search with full-text keyword
matching via RRF, storing everything in a single SQLite file using `sqlite-vec` and FTS5. That
is our stack, component for component, arrived at independently and published first. Its
contributions are orthogonal to ours — self-supervised embedding refinement from
hybrid-retrieval disagreement, adaptive per-query IDF weighting for RRF, and a negative result
on post-RRF reranking — and it is evaluated on BEIR rather than on any agent-memory benchmark.

Hybrid lexical-dense retrieval is likewise long established, and the claim that deployed memory
systems neglect it no longer holds: Mem0 offers BM25 with dense retrieval, Hindsight runs four
parallel retrieval strategies including BM25, and SuperLocalMemory implements four-channel RRF.
An earlier version of this work rested on that observation about the field. It has expired.

What we contribute is therefore not the architecture but a measurement: what this substrate
class does against a deployed memory architecture as the store grows, which is the question
§4 takes up.

## 3.2 No write-time extraction

Conversation turns are stored as written. The system does not summarise, paraphrase, or
extract structured facts at ingestion time.

This is a deliberate refusal rather than an absence. Extraction is irreversible: once a turn
has been compressed into a derived statement, the original wording is gone and no later query
can recover it. Keeping the turns preserves the option to derive whatever representation a
task needs, later, when the task is known. §5 shows what that option is worth, and what it
costs.

## 3.3 No retrieval-time access decision

In a multi-principal store, different askers are entitled to different subsets of memory. The
obvious engineering response is to filter retrieval by the asker's authorisation, so that
unauthorised records are never surfaced.

This system does not do that. It retrieves broadly and lets the answering model decide what to
disclose, given the governing policy in its prompt.

The position is not new. \citet{zafar2026guardrails} argue that in a RAG system the object
exposed to the user is a generated answer, so enforcement moves from document access to output
composition. \citet{tallam2026partial} show that silent authorisation filtering is unsafe
because it renders withheld evidence indistinguishable from absent evidence. Our contribution
here is a measurement in the multi-principal memory setting, not the prescription.

It is also contested. \citet{fan2026harnessmu} argue the opposite — that governance
constraints are deterministic runtime variables which should be enforced by execution hooks
rather than entrusted to the model — and report strong results doing so.
\citet{mireshghallah2026cimemories} evaluate precisely the regime we adopt, retrieving broadly
and letting the model judge, and find that frontier models fail at granular disclosure, with
attribute-level violations up to 69% and models tending to share everything or nothing. §6
reports where our results agree and disagree with these.

One narrower point does survive as ours. A benchmark that expects a *redacted* answer requires
the system to possess the record in order to withhold its specifics; a filter that drops the
record before generation leaves nothing to redact. This is an application of the classical
declassification model rather than a new principle: partial release has been formalised since
\citet{sabelfeld2005declassification}, whose *what* dimension defines releasing part of a
secret as an operation on the held secret, and whose *where* dimension is the placement
question itself. Possession is a structural assumption of that model, which is why it is not
stated as a result anywhere. It bears restating only because a class of deployed systems
violates it. Note also that it applies to *drop-style* filters only:
\citet{almasoud2026sdrag} enforce selective disclosure at retrieval time by sanitising chunks
in place rather than removing them, which redacts without generation-time judgment.

## 3.4 No derived store

Because the files are the store, deletion is deletion: removing a record means removing a file,
and the claim can be checked by reading the directory. The index is rebuilt without it.

This matters less for behaviour than it does for measurement. In a vector store, a leak after
deletion is ambiguous — it could be residue in an embedding, or reconstruction from surviving
context, and the two are hard to separate. A file-backed store makes storage-layer erasure
verifiable by inspection, which is what allows storage erasure and behavioural erasure to be
treated as independent variables at all. §6 uses exactly that separation.

## 3.5 Configuration and cost

Unless stated otherwise: answer model `gpt-5.5`, local embeddings, hybrid RRF fusion, top-k 16.
Every benchmark judge is stated per result, and §7 records the judge-mismatch caveat that
applies to all absolutes.

Deferring commitment is not free. Keeping raw turns makes the store larger and, at fixed top-k,
gives retrieval more candidates to rank. On GateMem, whose episodes are 7–8K tokens, we consume
roughly 2.4x more tokens than long-context prompting (3.05M vs 1.28M) because there is nothing
at that scale for retrieval to save. Indexing a 10M-token conversation with local embeddings
takes ~2h40m and is CPU-bound, which bounds how much of this evaluation could be run. Those
costs are the price of the option value claimed in §3.2, and they are only worth paying where
the store is large enough for retrieval to matter — a condition §4 makes precise.

---

## Drafting notes (not part of the section)

**What changed and why**

- The substrate is now **conceded, not claimed**. `steffens2026vstash` published the identical
  stack in April 2026. Claiming novelty for sqlite-vec + FTS5 + RRF after that date is a
  citation failure a reviewer finds in one search.
- **Deleted**: the "deployed memory systems don't fuse lexical and dense" argument that
  `PAPER-PLANNING.md` C2 rests on. Mem0, Hindsight and SuperLocalMemory all fuse. That claim
  should be removed from the ledger too — it is currently still there.
- **C3 demoted** from "strongest surviving S1 contribution" to a framing paragraph citing
  Sabelfeld & Sands. The possession property is an assumption of the 2005 model, not a finding;
  it was "not found in the literature" because nobody needed to state it.
- **Harness-MU and CIMemories are confronted in-section** rather than deferred to related work.
  Both argue against the generation-time position, CIMemories with direct evidence in our exact
  regime. Burying them would read as avoidance.
- **SD-RAG narrows the mechanism claim** to drop-style filters. Left unqualified it is
  falsifiable by a published system.

**Still open**

| item | status |
|---|---|
| Citation keys | placeholders; several sources are snippet-only and must be fetched |
| §3.5 token comparison | from GateMem; needs the e2e-pair discipline if any GateMem number is quoted |
| S6 (leakage is judgment, not thin retrieval) | contested by CIMemories, resolved in §6, not here |
| The 10M indexing cost | measured 2h39m/2h40m/161m/345m — quote the solo figure, not the contended one |
