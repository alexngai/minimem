/**
 * Session tracking for memory entries
 *
 * Captures context about the originating session (Claude Code, VS Code, etc.)
 * and stores it as YAML frontmatter in memory files.
 */

import * as os from "node:os";

/**
 * Session metadata for memory entries
 */
export type SessionContext = {
  /** Session identifier (e.g., Claude Code session ID) */
  id?: string;
  /** Source application (claude-code, vscode, cursor, etc.) */
  source?: string;
  /** Project directory path */
  project?: string;
  /** Path to session transcript/log file */
  transcript?: string;
};

/**
 * Source provenance for a knowledge entry
 */
export type KnowledgeSource = {
  origin?: string;
  trajectories?: string[];
  agentId?: string;
};

/**
 * A directional link from this entry to another knowledge node
 */
export type KnowledgeLink = {
  target: string;
  relation: string;
  layer?: string;
};

/**
 * Frontmatter structure for memory files
 */
export type MemoryFrontmatter = {
  session?: SessionContext;
  created?: string;
  updated?: string;
  tags?: string[];
  /** Knowledge node identifier */
  id?: string;
  /** Knowledge entry type */
  type?: "observation" | "entity" | "domain-summary" | string;
  /** Domain tags for this knowledge entry */
  domain?: string[];
  /** Entity references in this knowledge entry */
  entities?: string[];
  /** Confidence score 0-1 */
  confidence?: number;
  /** Source provenance */
  source?: KnowledgeSource;
  /** Links to other knowledge nodes */
  links?: KnowledgeLink[];
  /** ID of the entry this supersedes */
  supersedes?: string | null;
};

/**
 * Parse YAML frontmatter from content
 *
 * Frontmatter is delimited by --- at the start and end:
 * ```
 * ---
 * session:
 *   id: abc123
 *   source: claude-code
 * created: 2024-01-27T14:30:00Z
 * ---
 * Actual content here...
 * ```
 */
export function parseFrontmatter(content: string): {
  frontmatter: MemoryFrontmatter | undefined;
  body: string;
} {
  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    return { frontmatter: undefined, body: content };
  }

  const yamlContent = match[1];
  const body = content.slice(match[0].length);

  try {
    const frontmatter = parseSimpleYaml(yamlContent);
    return { frontmatter, body };
  } catch {
    // If parsing fails, treat as no frontmatter
    return { frontmatter: undefined, body: content };
  }
}

/**
 * Simple YAML parser for frontmatter.
 *
 * **Limitations** (by design — keeps the dependency count at zero):
 * - Does not handle multi-line strings (block scalars `|` / `>`)
 * - Does not preserve comments
 * - Keys must be simple `\w+` identifiers (no quoted or special-char keys)
 *
 * Supports:
 * - Multi-level nesting (objects within objects)
 * - Inline arrays `[a, b]`
 * - YAML list items with `- ` syntax (including `- {key: val}` objects)
 * - Null values via `~` or `null`
 */
function parseSimpleYaml(yaml: string): MemoryFrontmatter {
  const lines = yaml.split("\n");
  return parseYamlBlock(lines, 0, 0, lines.length).value as MemoryFrontmatter;
}

/**
 * Parse a block of YAML lines at a given indentation level into an object.
 * Returns the parsed value and the line index where parsing stopped.
 */
function parseYamlBlock(
  lines: string[],
  indent: number,
  startIdx: number,
  endIdx: number,
): { value: Record<string, unknown>; nextIdx: number } {
  const result: Record<string, unknown> = {};
  let i = startIdx;

  while (i < endIdx) {
    const line = lines[i];
    if (!line || !line.trim()) {
      i++;
      continue;
    }

    const lineIndent = getIndent(line);
    // If we've dedented back beyond our level, stop
    if (lineIndent < indent) break;
    // Skip lines indented deeper than expected (shouldn't happen at top of block)
    if (lineIndent > indent) {
      i++;
      continue;
    }

    // Match a key: value line
    const keyMatch = line.match(/^(\s*)([\w-]+):\s*(.*)?$/);
    if (!keyMatch) {
      i++;
      continue;
    }

    const [, , key, rawValue] = keyMatch;
    const value = rawValue?.trim() ?? "";

    if (value === "" || value === undefined) {
      // Could be an object or a list starting on next lines
      const nextNonEmpty = findNextNonEmptyLine(lines, i + 1, endIdx);
      if (nextNonEmpty < endIdx) {
        const nextLine = lines[nextNonEmpty]!;
        const nextIndent = getIndent(nextLine);
        if (nextIndent > indent) {
          // Check if it's a list (starts with "- ")
          if (nextLine.trimStart().startsWith("- ")) {
            const listResult = parseYamlList(lines, nextIndent, i + 1, endIdx);
            result[key] = listResult.value;
            i = listResult.nextIdx;
          } else {
            // Nested object
            const blockResult = parseYamlBlock(lines, nextIndent, i + 1, endIdx);
            result[key] = blockResult.value;
            i = blockResult.nextIdx;
          }
          continue;
        }
      }
      // Empty value, no nested content
      result[key] = null;
      i++;
    } else {
      result[key] = parseYamlValue(value);
      i++;
    }
  }

  return { value: result, nextIdx: i };
}

/**
 * Parse a YAML list (lines starting with "- ") at a given indentation level.
 */
function parseYamlList(
  lines: string[],
  indent: number,
  startIdx: number,
  endIdx: number,
): { value: unknown[]; nextIdx: number } {
  const result: unknown[] = [];
  let i = startIdx;

  while (i < endIdx) {
    const line = lines[i];
    if (!line || !line.trim()) {
      i++;
      continue;
    }

    const lineIndent = getIndent(line);
    if (lineIndent < indent) break;
    if (lineIndent > indent) {
      i++;
      continue;
    }

    const trimmed = line.trimStart();
    if (!trimmed.startsWith("- ")) break;

    // Get content after "- "
    const itemContent = trimmed.slice(2).trim();

    if (itemContent === "" || itemContent === undefined) {
      // Sub-block under this list item
      const nextNonEmpty = findNextNonEmptyLine(lines, i + 1, endIdx);
      if (nextNonEmpty < endIdx) {
        const nextIndent = getIndent(lines[nextNonEmpty]!);
        if (nextIndent > indent) {
          const blockResult = parseYamlBlock(lines, nextIndent, i + 1, endIdx);
          result.push(blockResult.value);
          i = blockResult.nextIdx;
          continue;
        }
      }
      result.push(null);
      i++;
    } else {
      // Check for inline key: value (object item like "- target: foo")
      const kvMatch = itemContent.match(/^([\w-]+):\s*(.*)$/);
      if (kvMatch) {
        // This list item is an object — collect all keys at this item's indent + 2
        const obj: Record<string, unknown> = {};
        const [, firstKey, firstVal] = kvMatch;
        obj[firstKey] = parseYamlValue(firstVal?.trim() ?? "");

        // Look for continuation keys indented further
        const itemKeyIndent = indent + 2;
        let j = i + 1;
        while (j < endIdx) {
          const nextLine = lines[j];
          if (!nextLine || !nextLine.trim()) {
            j++;
            continue;
          }
          const nextLineIndent = getIndent(nextLine);
          if (nextLineIndent < itemKeyIndent) break;
          if (nextLineIndent === itemKeyIndent) {
            const nextKv = nextLine.match(/^\s*([\w-]+):\s*(.*)$/);
            if (nextKv) {
              const [, nk, nv] = nextKv;
              obj[nk] = parseYamlValue(nv?.trim() ?? "");
              j++;
              continue;
            }
          }
          break;
        }
        result.push(obj);
        i = j;
      } else {
        result.push(parseYamlValue(itemContent));
        i++;
      }
    }
  }

  return { value: result, nextIdx: i };
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function findNextNonEmptyLine(lines: string[], from: number, end: number): number {
  for (let i = from; i < end; i++) {
    if (lines[i]?.trim()) return i;
  }
  return end;
}

/**
 * Parse a YAML value (handles strings, numbers, booleans, null, arrays)
 */
function parseYamlValue(value: string): unknown {
  // Empty string
  if (value === "") return null;

  // Remove quotes if present
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Null
  if (value === "null" || value === "~") return null;

  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;

  // Number
  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;

  // Array (simple inline format)
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1);
    if (inner.trim() === "") return [];
    return inner.split(",").map((s) => parseYamlValue(s.trim()));
  }

  // String
  return value;
}

/**
 * Serialize frontmatter to YAML string
 */
export function serializeFrontmatter(frontmatter: MemoryFrontmatter): string {
  const lines: string[] = ["---"];

  if (frontmatter.id) {
    lines.push(`id: ${frontmatter.id}`);
  }

  if (frontmatter.type) {
    lines.push(`type: ${frontmatter.type}`);
  }

  if (frontmatter.session) {
    lines.push("session:");
    const session = frontmatter.session;
    if (session.id) lines.push(`  id: ${session.id}`);
    if (session.source) lines.push(`  source: ${session.source}`);
    if (session.project) lines.push(`  project: ${formatPath(session.project)}`);
    if (session.transcript) lines.push(`  transcript: ${formatPath(session.transcript)}`);
  }

  if (frontmatter.created) {
    lines.push(`created: ${frontmatter.created}`);
  }

  if (frontmatter.updated) {
    lines.push(`updated: ${frontmatter.updated}`);
  }

  if (frontmatter.tags && frontmatter.tags.length > 0) {
    lines.push(`tags: [${frontmatter.tags.join(", ")}]`);
  }

  if (frontmatter.domain && frontmatter.domain.length > 0) {
    lines.push(`domain: [${frontmatter.domain.join(", ")}]`);
  }

  if (frontmatter.entities && frontmatter.entities.length > 0) {
    lines.push(`entities: [${frontmatter.entities.join(", ")}]`);
  }

  if (frontmatter.confidence !== undefined) {
    lines.push(`confidence: ${frontmatter.confidence}`);
  }

  if (frontmatter.source) {
    lines.push("source:");
    if (frontmatter.source.origin) lines.push(`  origin: ${frontmatter.source.origin}`);
    if (frontmatter.source.trajectories && frontmatter.source.trajectories.length > 0) {
      lines.push(`  trajectories: [${frontmatter.source.trajectories.join(", ")}]`);
    }
    if (frontmatter.source.agentId) lines.push(`  agentId: ${frontmatter.source.agentId}`);
  }

  if (frontmatter.links && frontmatter.links.length > 0) {
    lines.push("links:");
    for (const link of frontmatter.links) {
      lines.push(`  - target: ${link.target}`);
      lines.push(`    relation: ${link.relation}`);
      if (link.layer) lines.push(`    layer: ${link.layer}`);
    }
  }

  if (frontmatter.supersedes !== undefined) {
    lines.push(`supersedes: ${frontmatter.supersedes === null ? "~" : frontmatter.supersedes}`);
  }

  lines.push("---");
  return lines.join("\n") + "\n";
}

/**
 * Add or update frontmatter in content
 */
export function addFrontmatter(
  content: string,
  frontmatter: MemoryFrontmatter,
): string {
  const { frontmatter: existing, body } = parseFrontmatter(content);

  // Merge with existing frontmatter
  const merged: MemoryFrontmatter = {
    ...existing,
    ...frontmatter,
    session: {
      ...existing?.session,
      ...frontmatter.session,
    },
  };

  // Update timestamp
  if (!merged.created) {
    merged.created = new Date().toISOString();
  }
  merged.updated = new Date().toISOString();

  return serializeFrontmatter(merged) + body;
}

/**
 * Add session context as frontmatter to content
 */
export function addSessionToContent(
  content: string,
  session: SessionContext,
): string {
  return addFrontmatter(content, { session });
}

/**
 * Format path for display (use ~ for home directory)
 */
function formatPath(filePath: string): string {
  const home = os.homedir();
  if (filePath.startsWith(home)) {
    return "~" + filePath.slice(home.length);
  }
  return filePath;
}

/**
 * Extract session context from file content
 */
export function extractSession(content: string): SessionContext | undefined {
  const { frontmatter } = parseFrontmatter(content);
  return frontmatter?.session;
}
