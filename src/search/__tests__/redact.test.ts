import { describe, expect, it } from "vitest";

import {
  applyRedactions,
  isFullyRedacted,
  normalizeRule,
  parseRedactionManifest,
  serializeRedactionRule,
  type RedactionRuleInput,
} from "../redact.js";

const rule = (input: RedactionRuleInput) => normalizeRule(input);

describe("applyRedactions", () => {
  it("is the identity with no rules", () => {
    const text = "- stipend is 2600 USD\n- meeting on May 13";
    expect(applyRedactions(text, []).text).toBe(text);
  });

  // The whole point: remove the fact, keep everything it was sitting next to.
  it("removes the matching line and preserves co-located facts", () => {
    const text = [
      "- Stipend raised to 2600 USD per month.",
      "- Review meeting scheduled for May 13.",
      "- Mentor is Dana.",
    ].join("\n");
    const out = applyRedactions(text, [rule({ match: "2600 USD" })]).text;
    expect(out).not.toContain("2600");
    expect(out).toContain("May 13");
    expect(out).toContain("Dana");
  });

  it("matches case-insensitively", () => {
    const out = applyRedactions("- Badge code is ALPHA-7.", [rule({ match: "alpha-7" })]).text;
    expect(out).not.toContain("ALPHA-7");
  });

  // Span-level masking leaves the value reconstructable from its own sentence; this documents
  // why block is the default rather than asserting span is wrong.
  it("span granularity leaves surrounding text, block does not", () => {
    const text = "- Raised by 200 from the previous 2400 to 2600.";
    const span = applyRedactions(text, [
      rule({ match: "2600", granularity: "span", replacement: "[redacted]" }),
    ]).text;
    expect(span).toContain("2400");
    expect(span).toContain("Raised by 200");

    const block = applyRedactions(text, [rule({ match: "2600" })]).text;
    expect(block).not.toContain("2400");
    expect(block).not.toContain("Raised by 200");
  });

  it("carries a list item's indented continuation lines with it", () => {
    const text = [
      "- Salary record",
      "    amount: 2600 USD",
      "    effective: May",
      "- Unrelated note",
    ].join("\n");
    const out = applyRedactions(text, [rule({ match: "2600" })]).text;
    expect(out).not.toContain("2600");
    expect(out).not.toContain("effective: May");
    expect(out).not.toContain("Salary record");
    expect(out).toContain("Unrelated note");
  });

  it("leaves one marker per removed block, not one per line", () => {
    const text = ["- Record", "    amount: 2600", "    note: x", "- Keep"].join("\n");
    const out = applyRedactions(text, [rule({ match: "2600" })]).text;
    expect(out.split("[redacted]").length - 1).toBe(1);
  });

  it("removes silently when replacement is empty", () => {
    const out = applyRedactions("- secret 2600\n- keep", [
      rule({ match: "2600", replacement: "" }),
    ]).text;
    expect(out).not.toContain("redacted");
    expect(out).toContain("keep");
  });

  it("applies every matching line, not just the first", () => {
    const text = ["- code 99", "- keep me", "- code 99 again"].join("\n");
    const out = applyRedactions(text, [rule({ match: "code 99" })]).text;
    expect(out).not.toContain("code 99");
    expect(out).toContain("keep me");
  });

  describe("scope", () => {
    const r = rule({ match: "2600", paths: ["memory/pay.md"] });

    it("applies inside scope", () => {
      const out = applyRedactions("- 2600", [r], { path: "memory/pay.md" }).text;
      expect(out).not.toContain("2600");
    });

    it("does not apply outside scope", () => {
      const out = applyRedactions("- 2600", [r], { path: "memory/other.md" }).text;
      expect(out).toContain("2600");
    });

    it("does not apply when the path is unknown", () => {
      expect(applyRedactions("- 2600", [r]).text).toContain("2600");
    });
  });

  describe("regex rules", () => {
    it("matches by pattern", () => {
      const out = applyRedactions("- ssn 123-45-6789\n- keep", [
        rule({ match: "\\d{3}-\\d{2}-\\d{4}", kind: "regex" }),
      ]).text;
      expect(out).not.toContain("123-45-6789");
      expect(out).toContain("keep");
    });

    // A read path must never throw on stored data.
    it("ignores an invalid pattern instead of throwing", () => {
      const text = "- anything";
      expect(applyRedactions(text, [rule({ match: "([unclosed", kind: "regex" })]).text).toBe(text);
    });

    it("treats literals as literal, not as patterns", () => {
      const out = applyRedactions("- a.c\n- abc", [rule({ match: "a.c" })]).text;
      expect(out).toContain("abc");
      expect(out).not.toContain("a.c\n");
    });
  });
});

describe("manifest", () => {
  it("round-trips a rule", () => {
    const r = rule({ match: "2600", reason: "deletion request", at: "2026-01-01T00:00:00Z" });
    const [back] = parseRedactionManifest(serializeRedactionRule(r));
    expect(back).toEqual(r);
  });

  // "No rules loaded" is a silent leak, so one bad line must not disable the rest.
  it("skips corrupt and empty lines but keeps valid ones", () => {
    const text = ['{"match":"a","kind":"literal"}', "not json", "", "  ", '{"nomatch":1}'].join(
      "\n",
    );
    const rules = parseRedactionManifest(text);
    expect(rules).toHaveLength(1);
    expect(rules[0].match).toBe("a");
  });

  it("fills defaults for a minimal rule", () => {
    const [r] = parseRedactionManifest('{"match":"x"}');
    expect(r.kind).toBe("literal");
    expect(r.granularity).toBe("block");
    expect(r.replacement).toBe("[redacted]");
  });
});

describe("isFullyRedacted", () => {
  it("is true when only markers and punctuation remain", () => {
    expect(isFullyRedacted("[redacted]")).toBe(true);
    expect(isFullyRedacted("- [redacted]\n- [redacted]")).toBe(true);
    expect(isFullyRedacted("   ")).toBe(true);
  });

  it("is false when real content survives", () => {
    expect(isFullyRedacted("- [redacted]\n- Mentor is Dana")).toBe(false);
  });
});
