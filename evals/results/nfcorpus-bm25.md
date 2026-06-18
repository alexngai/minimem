[beir] Downloading nfcorpus from https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip...
[beir] Extracting nfcorpus.zip...
[beir] nfcorpus cached at /Users/alexngai/GitHub/minimem/evals/datasets/cache/nfcorpus
[eval] materialized 3633 docs -> /var/folders/xg/4g0d09h14x596z_2q2lqkxlm0000gn/T/minimem-matrix-nfcorpus-oBabw8
[eval] scored jaccard (lexical)
[eval] scored bm25-only-and
[eval] scored bm25-only-or
# Retrieval eval — nDCG@10 / Recall@10 / MRR / Hit@10

Metrics show mean [95% bootstrap CI] over judged queries.

## nfcorpus (323 queries)

| Config | nDCG@10 | Recall@10 | MRR@10 | Hit@10 | ΔnDCG vs jaccard |
|---|---|---|---|---|---|
| jaccard | 0.179 [0.15,0.21] | 0.097 [0.08,0.12] | 0.292 [0.25,0.33] | 0.495 [0.45,0.55] | — |
| bm25-only-and | 0.192 [0.16,0.23] | 0.085 [0.06,0.11] | 0.323 [0.27,0.37] | 0.372 [0.32,0.42] | +1.2pp |
| bm25-only-or | 0.300 [0.27,0.34] | 0.149 [0.12,0.18] | 0.499 [0.45,0.55] | 0.663 [0.61,0.71] | +12.1pp |

