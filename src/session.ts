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
 * Frontmatter structure for memory files
 */
export type MemoryFrontmatter = {
  session?: SessionContext;
  created?: string;
  updated?: string;
  tags?: string[];
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
 * - Only supports 2-level nesting (e.g., `session.id`, not `a.b.c`)
 * - Does not handle multi-line strings (block scalars `|` / `>`)
 * - Does not handle YAML list items with `- ` syntax (only inline `[a, b]`)
 * - Does not preserve comments
 * - Keys must be simple `\w+` identifiers (no quoted or special-char keys)
 *
 * If you need full YAML support, consider replacing this with a library
 * such as `yaml` (https://www.npmjs.com/package/yaml).
 */
function parseSimpleYaml(yaml: string): MemoryFrontmatter {
  const result: MemoryFrontmatter = {};
  const lines = yaml.split("\n");
  let currentKey: string | null = null;
  let currentObject: Record<string, unknown> | null = null;

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) continue;

    // Check indentation level
    const indentMatch = line.match(/^(\s*)/);
    const indent = indentMatch ? indentMatch[1].length : 0;

    // Top-level key
    if (indent === 0) {
      const keyMatch = line.match(/^(\w+):\s*(.*)?$/);
      if (keyMatch) {
        const [, key, value] = keyMatch;
        if (value && value.trim()) {
          // Simple key: value
          (result as Record<string, unknown>)[key] = parseYamlValue(value.trim());
          currentKey = null;
          currentObject = null;
        } else {
          // Object start
          currentKey = key;
          currentObject = {};
          (result as Record<string, unknown>)[key] = currentObject;
        }
      }
    } else if (currentObject && indent >= 2) {
      // Nested key
      const nestedMatch = line.match(/^\s+(\w+):\s*(.*)$/);
      if (nestedMatch) {
        const [, key, value] = nestedMatch;
        currentObject[key] = parseYamlValue(value.trim());
      }
    }
  }

  return result;
}

/**
 * Parse a YAML value (handles strings, numbers, booleans, arrays)
 */
function parseYamlValue(value: string): unknown {
  // Remove quotes if present
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }

  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;

  // Number
  const num = Number(value);
  if (!isNaN(num) && value !== "") return num;

  // Array (simple inline format)
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1);
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
