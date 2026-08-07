import json, os
D=["medical","office","education","household"]
ARMS=[("full","baseline (session start)","tuned","gpt-5.5"),
      ("final","+ household prompt fix (rejected)","tuned","gpt-5.5"),
      ("confirm","+ literal-purge deletion","tuned","gpt-5.5"),
      ("precise","+ precise deletion","tuned","gpt-5.5"),
      ("hybrid","+ no-reconstruct guard","tuned","gpt-5.5"),
      ("sol","best tuned","tuned","gpt-5.6-sol"),
      ("officialp","official prompt (UNFAITHFUL — superseded)","standard*","gpt-5.5"),
      ("officialfx","official prompt (faithful)","standard","gpt-5.5"),
      ("stdsol","official prompt + newer model","standard","gpt-5.6-sol"),
      ("weak2","tuned + weak model","tuned","gpt-4.1")]
def cell(tag,d):
    p=f"/tmp/gm-{tag}-{d}/summary.json"
    if not os.path.exists(p): return None
    s=json.load(open(p))
    exp={"medical":579,"office":547,"education":540,"household":552}[d]
    if s["n_checkpoints"]!=exp: return "POLLUTED"
    g=lambda k:(s[k]*100 if s[k]<=1 else s[k])
    return dict(U=g("utility_accuracy"),A=g("privacy_leakage_rate"),F=g("deletion_leakage_rate"),
                M=g("compliance_utility_score"),O=g("over_refusal_rate"))
print("| arm | prompt | model | medical | office | education | household | **mean** |")
print("|---|---|---|--:|--:|--:|--:|--:|")
for tag,label,pr,mdl in ARMS:
    cells=[cell(tag,d) for d in D]
    if any(c is None for c in cells):
        print(f"| {label} | {pr} | {mdl} | — | — | — | — | *not run* |"); continue
    ms=[c["M"] for c in cells]
    print(f"| {label} | {pr} | {mdl} | " + " | ".join(f"{m:.1f}" for m in ms) + f" | **{sum(ms)/4:.1f}** |")
print("\n\n### U / A / F / over-refusal detail\n")
print("| arm | domain | U | A | F | MGS | over-refusal |")
print("|---|---|--:|--:|--:|--:|--:|")
for tag,label,pr,mdl in ARMS:
    for d in D:
        c=cell(tag,d)
        if not isinstance(c,dict): continue
        print(f"| {label} | {d} | {c['U']:.1f} | {c['A']:.1f} | {c['F']:.1f} | {c['M']:.1f} | {c['O']:.1f} |")
