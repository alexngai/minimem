"""Print U/A/F/MGS for one scored GateMem domain, plus action confusion and leaderboard rank.

Kept as a real file rather than an inline heredoc: mutating generated shell with sed/python
string replacement produced a parse error and cost a run.
"""
import collections
import json
import os

summary = json.load(open(os.environ["SUMMARY"]))
domain = os.environ["DOMAIN"]
tag = os.environ["TAG"]
root = os.environ["GATEMEM_ROOT"]

u, a, f, m = (
    100 * summary[k]
    for k in ("utility_accuracy", "privacy_leakage_rate", "deletion_leakage_rate", "compliance_utility_score")
)
print(f"\n=== [{tag}] {domain} ===")
print(
    f"n={summary['n_checkpoints']} "
    f"(utility {summary['n_utility']}, privacy {summary['n_privacy']}, safety {summary['n_safety']})"
)
# e2e penalises sensitive content merely PRESENT in the prompt context, so it is the only
# metric that can see a system which retains a fact and declines to say it. MGS cannot:
# tombstoning scored 71.6 MGS at 0.0 e2e while keeping the content in 99.7% of contexts.
# For any deletion- or redaction-related arm this is the primary number, not a footnote.
e2e = summary.get("compliance_utility_e2e_score")
e2e_s = "n/a" if e2e is None else f"{100 * e2e:.1f}"
print(f"U={u:.1f}  A={a:.1f}  F={f:.1f}  ->  MGS={m:.1f}   e2e={e2e_s}")
print(f"action_accuracy={100 * summary['action_accuracy']:.1f}  over_refusal={100 * summary['over_refusal_rate']:.1f}")

# Action confusion, which is where redaction-vs-refusal calibration shows up.
expected = {}
for line in open(f"{root}/bench/data/{domain}/checkpoints.jsonl"):
    c = json.loads(line)
    expected[c["checkpoint_id"]] = (c["query_type"], c["expected_action"])
predicted = {}
for line in open(os.environ["PRED"]):
    p = json.loads(line)
    predicted[p["checkpoint_id"]] = p["action"]

exp_counts = collections.Counter(act for _, act in expected.values())
pred_counts = collections.Counter(predicted.values())
print("\naction mix (expected -> predicted):")
for act in ("answer", "answer_redacted", "refuse", "no_memory"):
    print(f"  {act:16} {exp_counts[act]:4} -> {pred_counts[act]:4}  ({pred_counts[act] - exp_counts[act]:+d})")

conf = collections.Counter()
for cid, (qt, ea) in expected.items():
    if qt == "privacy" and cid in predicted:
        conf[(ea, predicted[cid])] += 1
print("privacy confusion:")
for (ea, pa), n in sorted(conf.items(), key=lambda kv: -kv[1])[:5]:
    print(f"  {ea:16} -> {pa:16} {n:4}{'  <-- correct' if ea == pa else ''}")

# Rank against the published entries for this domain.
rows = [r for r in json.load(open(f"{root}/docs/assets/leaderboard.json")) if r["domain"].lower() == domain.lower()]
if rows:
    rows.append({"method": "minimem", "backbone": "gpt-5.5", "u": u, "a": a, "f": f, "mgs": m})
    rows.sort(key=lambda r: -r["mgs"])
    seen = set()
    ranked = []
    for r in rows:
        key = (r["method"], r["backbone"])
        if key in seen:
            continue
        seen.add(key)
        ranked.append(r)
    place = next(i for i, r in enumerate(ranked, 1) if r["method"] == "minimem")
    print(f"\nrank on {domain}: {place} of {len(ranked)}")
    for r in ranked[: max(place + 1, 4)]:
        mark = "   <<<" if r["method"] == "minimem" else ""
        print(f'  {r["method"][:18]:18} {r["backbone"][:15]:15} {r["u"]:6.1f} {r["a"]:6.1f} {r["f"]:6.1f} {r["mgs"]:6.1f}{mark}')
