/**
 * Field-level redaction.
 *
 * Deletion in minimem is file-shaped: a note exists or it does not. Obligations are
 * fact-shaped. Every note-level deletion therefore destroys co-located facts that were never
 * subject to the request — measured on a memory-governance benchmark as ~16 points of utility
 * per domain lost at *zero* benefit to the deletion metric. Narrowing what gets deleted was
 * the single largest scoring improvement found; this module removes the remaining floor by
 * making the fact, rather than the file, the unit of forgetting.
 *
 * Two properties drive the design:
 *
 * 1. **Rules are data, not an index mutation.** Memory files are the source of truth and the
 *    SQLite index is derived, so a redaction applied only to the index silently heals back
 *    into a leak on the next sync. Rules therefore live in their own file and are applied at
 *    read time.
 *
 * 2. **Redaction must remove text, not annotate it.** A previous soft-delete attempt prepended
 *    a "this was deleted" banner and left the body intact; the content stayed in 99.7% of
 *    retrieved contexts and the answer-grading metric happily scored it 71.6 while the
 *    context-level metric read 0.0. Marking is not removing.
 */

export type RedactionGranularity = "block" | "span";

export interface RedactionRule {
  /** Literal text, or a regular-expression source when `kind` is "regex". */
  match: string;
  kind: "literal" | "regex";
  /**
   * "block" (default) removes the enclosing line, plus the indented continuation lines of a
   * list item. "span" removes only the matched characters.
   *
   * Block is the default because span-level masking leaves the value derivable from its own
   * sentence — "raised by 200 from the previous 2400" reconstructs a masked 2600 exactly.
   * Paragraph-level was considered and rejected as over-broad: destroying neighbouring facts
   * is the failure this module exists to fix.
   */
  granularity: RedactionGranularity;
  /** Restrict to these memory-relative paths. Absent or empty = the whole store. */
  paths?: string[];
  /** Marker left behind. "" removes silently. */
  replacement?: string;
  reason?: string;
  /** ISO timestamp, for audit. */
  at?: string;
}

export const DEFAULT_REPLACEMENT = "[redacted]";

/** Rules a caller may supply; everything except `match` has a default. */
export type RedactionRuleInput = Partial<RedactionRule> & Pick<RedactionRule, "match">;

export function normalizeRule(input: RedactionRuleInput): RedactionRule {
  return {
    match: input.match,
    kind: input.kind ?? "literal",
    granularity: input.granularity ?? "block",
    paths: input.paths && input.paths.length > 0 ? input.paths : undefined,
    replacement: input.replacement ?? DEFAULT_REPLACEMENT,
    reason: input.reason,
    at: input.at,
  };
}

/**
 * Parse an append-only JSONL manifest. Unreadable lines are skipped rather than thrown on: a
 * corrupt line must not take the whole store's redactions offline, because the failure mode of
 * "no rules loaded" is a silent leak.
 */
export function parseRedactionManifest(text: string): RedactionRule[] {
  const rules: RedactionRule[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    try {
      const parsed = JSON.parse(trimmed) as RedactionRuleInput;
      if (typeof parsed?.match !== "string" || parsed.match.length === 0) continue;
      rules.push(normalizeRule(parsed));
    } catch {
      continue;
    }
  }
  return rules;
}

export function serializeRedactionRule(rule: RedactionRule): string {
  return JSON.stringify(rule);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Compiled matcher. Literals are case-insensitive; note text varies in case from its query. */
function toRegExp(rule: RedactionRule): RegExp | null {
  try {
    const source = rule.kind === "regex" ? rule.match : escapeRegExp(rule.match);
    return new RegExp(source, "gi");
  } catch {
    // An invalid user-supplied regex must not throw inside a read path.
    return null;
  }
}

function ruleAppliesToPath(rule: RedactionRule, filePath?: string): boolean {
  if (!rule.paths || rule.paths.length === 0) return true;
  if (!filePath) return false;
  const norm = filePath.replace(/\\/g, "/");
  return rule.paths.some((p) => {
    const q = p.replace(/\\/g, "/");
    return norm === q || norm.endsWith(`/${q}`);
  });
}

/** Leading whitespace + list marker, e.g. "  - " or "3. ". */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+/;

/**
 * Expand a hit line to its full block: a list item carries its indented continuation lines,
 * so removing only the marker line would leave the rest of the item dangling.
 */
function blockRange(lines: string[], index: number): { start: number; end: number } {
  let start = index;
  // Walk back to the list-item marker if this line is a continuation of one.
  while (start > 0 && !LIST_ITEM.test(lines[start]) && /^\s+\S/.test(lines[start])) {
    start--;
    if (LIST_ITEM.test(lines[start])) break;
  }
  if (!LIST_ITEM.test(lines[start])) start = index;

  let end = start;
  const marker = LIST_ITEM.exec(lines[start]);
  if (marker) {
    const indent = marker[1].length;
    while (end + 1 < lines.length) {
      const next = lines[end + 1];
      if (next.trim() === "") break;
      if (LIST_ITEM.test(next)) {
        const nextIndent = (LIST_ITEM.exec(next)?.[1] ?? "").length;
        if (nextIndent <= indent) break;
      } else if (!/^\s+\S/.test(next)) {
        break;
      }
      end++;
    }
  }
  return { start, end };
}

export interface RedactionResult {
  text: string;
  /** Number of rules that matched. */
  hits: number;
}

/**
 * Apply rules to text. Pure: callers decide what an emptied result means.
 */
export function applyRedactions(
  text: string,
  rules: RedactionRule[],
  opts?: { path?: string },
): RedactionResult {
  if (!text || rules.length === 0) return { text, hits: 0 };

  let out = text;
  let hits = 0;

  for (const rule of rules) {
    if (!ruleAppliesToPath(rule, opts?.path)) continue;
    const re = toRegExp(rule);
    if (!re) continue;
    const replacement = rule.replacement ?? DEFAULT_REPLACEMENT;

    if (rule.granularity === "span") {
      re.lastIndex = 0;
      if (!re.test(out)) continue;
      hits++;
      re.lastIndex = 0;
      out = out.replace(re, replacement);
      continue;
    }

    // Block: find every line the rule touches, expand each to its enclosing block, then drop
    // those blocks in one pass so overlapping ranges cannot corrupt indices.
    const lines = out.split("\n");
    const doomed = new Set<number>();
    const markerAt = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (!re.test(lines[i])) continue;
      const { start, end } = blockRange(lines, i);
      if (!doomed.has(start)) markerAt.add(start);
      for (let j = start; j <= end; j++) doomed.add(j);
    }
    if (doomed.size === 0) continue;
    hits++;
    const kept: string[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (!doomed.has(i)) {
        kept.push(lines[i]);
        continue;
      }
      // One marker per removed block, not per removed line.
      if (markerAt.has(i) && replacement) kept.push(replacement);
    }
    out = kept.join("\n");
  }

  return { text: out, hits };
}

/**
 * True when redaction left nothing of substance. Search results that reduce to this should be
 * dropped rather than returned as an empty hit.
 */
export function isFullyRedacted(text: string, replacement = DEFAULT_REPLACEMENT): boolean {
  const stripped = replacement
    ? text.split(replacement).join("").trim()
    : text.trim();
  return stripped.replace(/[\s\-*#>|_]/g, "").length === 0;
}
