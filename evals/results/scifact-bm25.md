[eval] materialized 5183 docs -> /var/folders/xg/4g0d09h14x596z_2q2lqkxlm0000gn/T/minimem-matrix-scifact-31ENUG
[eval] scored jaccard (lexical)
[eval] scored bm25-only-and
[eval] scored bm25-only-or
# Retrieval eval — nDCG@10 / Recall@10 / MRR / Hit@10

Metrics show mean [95% bootstrap CI] over judged queries.

## scifact (300 queries)

| Config | nDCG@10 | Recall@10 | MRR@10 | Hit@10 | ΔnDCG vs jaccard |
|---|---|---|---|---|---|
| jaccard | 0.278 [0.23,0.32] | 0.390 [0.33,0.45] | 0.244 [0.21,0.29] | 0.403 [0.35,0.46] | — |
| bm25-only-and | 0.017 [0.00,0.03] | 0.017 [0.00,0.03] | 0.017 [0.00,0.03] | 0.017 [0.00,0.03] | -26.1pp |
| bm25-only-or | 0.656 [0.61,0.70] | 0.780 [0.74,0.82] | 0.624 [0.58,0.67] | 0.800 [0.76,0.85] | +37.9pp |

