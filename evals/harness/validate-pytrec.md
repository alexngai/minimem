# One-time validation against pytrec_eval

`metrics.ts` implements `nDCG@k` / `recall@k` / `MRR` with the trec_eval
`ndcg_cut` convention (linear gain, `log2(rank+1)` discount). BEIR reports
`nDCG@10` via [pytrec_eval](https://github.com/cvangysel/pytrec_eval). Run this
once to confirm the TS implementation matches within ±0.001; thereafter the TS
metrics are self-contained (no Python dependency in CI).

```bash
pip install pytrec_eval
```

```python
import pytrec_eval

# qrels: {query_id: {doc_id: relevance}}
qrels = {"q1": {"a": 2, "c": 1}}
# run:  {query_id: {doc_id: score}}  (higher score = higher rank)
run = {"q1": {"a": 0.9, "b": 0.8, "c": 0.7}}

ev = pytrec_eval.RelevanceEvaluator(qrels, {"ndcg_cut.3", "recall.1", "recall.3", "recip_rank"})
print(ev.evaluate(run))
# ndcg_cut_3 ~= 0.9502, recall_1 = 0.5, recall_3 = 1.0, recip_rank = 1.0
```

Compare against the hand-verified values asserted in `__tests__/metrics.test.ts`
(`ndcg@3 ≈ 0.95023`, `recall@1 = 0.5`, `recall@3 = 1.0`, `MRR = 1.0`). To validate
on a real run, dump the harness's per-query rankings to a TREC run file and feed
both to pytrec_eval.

> Note: trec_eval's `ndcg_cut` uses **linear** gain. If a comparison target uses
> exponential gain (`2^rel − 1`, e.g. sklearn's default), numbers differ on graded
> qrels — match the convention before comparing.
