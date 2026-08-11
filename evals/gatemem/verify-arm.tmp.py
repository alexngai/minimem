#!/usr/bin/env python3
"""Scrutinise a GateMem arm before believing its numbers.

    python3 evals/gatemem/verify-arm.tmp.py <tag> [--judge gm|gm4o] [--vs <baseline-tag>]

Every check here exists because something silently produced a plausible, wrong number in
this codebase. A run that fails none of these is not guaranteed correct; a run that fails any
of them should not be reported.

  1. checkpoint count      -- killing a run leaves the parent shell scoring alongside a
                              relaunch, yielding n=972 for a 540-checkpoint domain.
  2. answer failures       -- a failed answer call becomes action="refuse", which scores as a
                              deliberate choice. 18 such failures on one arm zeroed 9% of a
                              domain's utility before a counter surfaced it.
  3. config banner         -- three flags have silently no-oped (--deletion tombstone ran as
                              "off"; two others). The banner records what actually reached
                              the prompt, so a flag that did nothing is visible.
  4. MGS identity          -- MGS must equal U*(1-A)*(1-F). Confirms the summary is internally
                              consistent and that action_accuracy is not a hidden factor.
  5. provenance field      -- prompt_memory_block moved between top-level and output.* mid-
                              project. Reading one location silently yields "", and every
                              coverage statistic derived from it then reads 0%/100%.
  6. deletion actually ran -- if the config says deletion is on, notes must actually have been
                              deleted; zero means the pass was inert.
  7. effect vs noise       -- with --vs, compares against a baseline using the MEASURED noise
                              floor: four-domain mean sd ~1.2 (so ~2.4 to be real), but
                              per-domain sd ranges 0.6 (office) to 3.3 (education), so a
                              per-domain claim needs ~6 points.
"""
import json, os, re, sys, glob

EXPECT = {"medical": 579, "office": 547, "education": 540, "household": 552}
# Measured from repeated identical runs; see evals/gatemem/RESULTS.md.
DOMAIN_SD = {"medical": 2.7, "office": 0.65, "education": 3.3, "household": 1.2}
MEAN_SD = 1.2


def load(pfx, tag, d):
    p = f"/tmp/{pfx}-{tag}-{d}/summary.json"
    return json.load(open(p)) if os.path.exists(p) else None


def pct(s, k):
    v = s.get(k)
    return None if v is None else (v * 100 if v <= 1 else v)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    tag = sys.argv[1]
    pfx = "gm4o" if "--judge" in sys.argv and sys.argv[sys.argv.index("--judge") + 1] == "gm4o" else "gm"
    base = sys.argv[sys.argv.index("--vs") + 1] if "--vs" in sys.argv else None
    fails, warns = [], []
    print(f"scrutinising {tag}  (judge dir: {pfx}-*)\n")

    # 1/4/6 -- per-domain integrity
    means = {}
    for d, n in EXPECT.items():
        s = load(pfx, tag, d)
        if s is None:
            fails.append(f"{d}: no summary")
            continue
        if s["n_checkpoints"] != n:
            fails.append(f"{d}: n_checkpoints {s['n_checkpoints']} != {n}")
        U, A, F, M = (pct(s, k) for k in ("utility_accuracy", "privacy_leakage_rate",
                                          "deletion_leakage_rate", "compliance_utility_score"))
        recomputed = U * (1 - A / 100) * (1 - F / 100)
        if abs(recomputed - M) > 0.15:
            fails.append(f"{d}: MGS identity broken ({recomputed:.2f} vs reported {M:.2f})")
        means[d] = M
        print(f"  {d:10} n={s['n_checkpoints']:4}  U {U:5.1f}  A {A:5.1f}  F {F:5.1f}  MGS {M:5.1f}")

    # 2 -- answer failures
    logs = glob.glob(f"evals/gatemem/results/{tag}-*.log")
    nfail = sum(len(re.findall(r"answer call FAILED|EPISODE FAILED", open(f, errors="ignore").read()))
                for f in logs)
    if nfail:
        fails.append(f"{nfail} answer/episode failures -- scores are partly artifact")
    else:
        print("  answer/episode failures: 0")

    # 3 -- config banner
    banner = ""
    for f in logs:
        m = re.search(r"\[gatemem\] CONFIG .*", open(f, errors="ignore").read())
        if m:
            banner = m.group(0)
            break
    if banner:
        print(f"  {banner.strip()}")
    else:
        warns.append("no CONFIG banner found -- cannot confirm which flags took effect")

    # 6 -- forgetting actually happened when enabled. "deletion=redact" removes facts rather
    #      than notes, so counting deletions alone would flag every redact arm as inert.
    if banner and "deletion=off" not in banner:
        blobs = [open(f, errors="ignore").read() for f in logs]
        deleted = sum(int(x) for b in blobs for x in re.findall(r"(\d+) notes deleted", b))
        redacted = sum(int(x) for b in blobs for x in re.findall(r"(\d+) facts redacted", b))
        refused = sum(int(x) for b in blobs for x in re.findall(r"\((\d+) refused\)", b))
        if deleted + redacted == 0:
            fails.append("config says deletion is enabled but nothing was deleted or redacted "
                         "-- inert flag")
        else:
            print(f"  notes deleted: {deleted}   facts redacted: {redacted}")
        if "deletion=redact" in banner and redacted == 0:
            fails.append("deletion=redact but 0 facts redacted -- the redact path did not run")
        if refused:
            warns.append(f"{refused} redactions refused by the blast-radius guard -- the "
                         f"harness pre-filter and the library limit disagree; deletions are "
                         f"narrower than the config implies")

    # 5 -- provenance field readable in at least one schema
    preds = sorted(glob.glob(f"evals/gatemem/results/{tag}-*.jsonl"))
    if preds:
        rows = [json.loads(l) for l in open(preds[0])]
        got = sum(1 for r in rows
                  if (r.get("prompt_memory_block")
                      or (r.get("output") or {}).get("prompt_memory_block")))
        if got == 0:
            warns.append("prompt_memory_block empty in BOTH schemas -- context metrics will read "
                         "a vacuous 0.0, not an error")
        else:
            print(f"  provenance present: {got}/{len(rows)} rows")

    # 7 -- effect size against the measured noise floor
    if base and len(means) == 4:
        bm = {d: load(pfx, base, d) for d in EXPECT}
        if all(bm.values()):
            print(f"\n  vs {base}:")
            for d in EXPECT:
                delta = means[d] - pct(bm[d], "compliance_utility_score")
                bar = 2 * DOMAIN_SD[d]
                verdict = "REAL" if abs(delta) > bar else "within noise"
                print(f"    {d:10} {delta:+6.1f}   (needs |{bar:.1f}| to clear 2sd)  {verdict}")
            dm = sum(means.values()) / 4 - sum(pct(b, "compliance_utility_score") for b in bm.values()) / 4
            print(f"    {'MEAN':10} {dm:+6.1f}   (needs |{2*MEAN_SD:.1f}|)  "
                  f"{'REAL' if abs(dm) > 2*MEAN_SD else 'WITHIN NOISE'}")

    print()
    for w in warns:
        print(f"  WARN  {w}")
    for f in fails:
        print(f"  FAIL  {f}")
    print(f"\n  verdict: {'DO NOT REPORT' if fails else ('report with caveats' if warns else 'clean')}")
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
