/**
 * minimem skill - Manage skills (Claudeception-style knowledge extraction)
 *
 * Skills are reusable knowledge extracted from work sessions, stored as
 * markdown files with YAML frontmatter for semantic matching.
 */

import * as path from "node:path";
import * as os from "node:os";
import { Minimem } from "../../minimem.js";
import {
  loadConfig,
  buildMinimemConfig,
  isInitialized,
  formatPath,
} from "../config.js";

export type SkillSearchOptions = {
  dir?: string;
  global?: boolean;
  max?: string;
  minScore?: string;
  provider?: string;
  json?: boolean;
};

export type SkillListOptions = {
  dir?: string;
  global?: boolean;
  provider?: string;
  json?: boolean;
};

export type SkillShowOptions = {
  dir?: string;
  global?: boolean;
  provider?: string;
  raw?: boolean;
};

export type SkillExtractOptions = {
  dir?: string;
  global?: boolean;
  provider?: string;
  author?: string;
  tags?: string;
};

/**
 * Search skills semantically
 */
export async function skillSearch(
  query: string,
  options: SkillSearchOptions,
): Promise<void> {
  const memoryDir = resolveMemoryDir(options);

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    console.error("Run 'minimem init' first.");
    process.exit(1);
  }

  const cliConfig = await loadConfig(memoryDir);
  const config = buildMinimemConfig(memoryDir, cliConfig, {
    provider: options.provider,
    watch: false,
  });

  const minimem = await Minimem.create(config);

  try {
    const maxResults = options.max ? parseInt(options.max, 10) : 5;
    const minScore = options.minScore ? parseFloat(options.minScore) : undefined;

    const results = await minimem.searchSkills(query, { maxResults, minScore });

    if (results.length === 0) {
      console.log("No matching skills found.");
      return;
    }

    if (options.json) {
      const output = results.map((r) => ({
        name: r.skill.name,
        description: r.skill.description,
        score: r.score,
        version: r.skill.version,
        path: r.skill.path,
        snippet: r.snippet,
      }));
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // Terminal output
    for (const result of results) {
      const score = (result.score * 100).toFixed(1);
      console.log(`[${score}%] ${result.skill.name}`);
      if (result.skill.version) {
        console.log(`       v${result.skill.version}`);
      }
      console.log(`       ${result.skill.path}`);
      console.log(formatSnippet(result.snippet));
      console.log();
    }

    console.log(`Found ${results.length} skill${results.length === 1 ? "" : "s"}`);
  } finally {
    minimem.close();
  }
}

/**
 * List all skills
 */
export async function skillList(options: SkillListOptions): Promise<void> {
  const memoryDir = resolveMemoryDir(options);

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    console.error("Run 'minimem init' first.");
    process.exit(1);
  }

  const cliConfig = await loadConfig(memoryDir);
  const config = buildMinimemConfig(memoryDir, cliConfig, {
    provider: options.provider,
    watch: false,
  });

  const minimem = await Minimem.create(config);

  try {
    const skills = await minimem.listSkills();

    if (skills.length === 0) {
      console.log("No skills found.");
      console.log("Create skills using 'minimem skill extract' or by adding files to skills/<name>/SKILL.md");
      return;
    }

    if (options.json) {
      const output = skills.map((s) => ({
        name: s.name,
        description: s.description,
        version: s.version,
        date: s.date,
        author: s.author,
        tags: s.tags,
        path: s.path,
      }));
      console.log(JSON.stringify(output, null, 2));
      return;
    }

    // Terminal output
    console.log(`Skills in ${formatPath(memoryDir)}:\n`);
    for (const skill of skills) {
      console.log(`  ${skill.name}`);
      if (skill.version) {
        console.log(`    Version: ${skill.version}`);
      }
      if (skill.description) {
        const desc = skill.description.split("\n")[0]?.trim() ?? "";
        const truncated = desc.length > 80 ? desc.slice(0, 77) + "..." : desc;
        console.log(`    ${truncated}`);
      }
      console.log();
    }

    console.log(`Total: ${skills.length} skill${skills.length === 1 ? "" : "s"}`);
  } finally {
    minimem.close();
  }
}

/**
 * Show a specific skill
 */
export async function skillShow(
  name: string,
  options: SkillShowOptions,
): Promise<void> {
  const memoryDir = resolveMemoryDir(options);

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    console.error("Run 'minimem init' first.");
    process.exit(1);
  }

  const cliConfig = await loadConfig(memoryDir);
  const config = buildMinimemConfig(memoryDir, cliConfig, {
    provider: options.provider,
    watch: false,
  });

  const minimem = await Minimem.create(config);

  try {
    const skill = await minimem.getSkill(name);

    if (!skill) {
      console.error(`Error: Skill '${name}' not found.`);
      console.error(`\nAvailable skills:`);
      const skills = await minimem.listSkills();
      for (const s of skills) {
        console.error(`  - ${s.name}`);
      }
      process.exit(1);
    }

    if (options.raw) {
      console.log(skill.rawContent);
      return;
    }

    // Formatted output
    console.log(`# ${skill.name}`);
    console.log();
    if (skill.version) console.log(`Version: ${skill.version}`);
    if (skill.author) console.log(`Author: ${skill.author}`);
    if (skill.date) console.log(`Date: ${skill.date}`);
    if (skill.tags?.length) console.log(`Tags: ${skill.tags.join(", ")}`);
    console.log();
    console.log(skill.content);
  } finally {
    minimem.close();
  }
}

/**
 * Extract a new skill interactively
 */
export async function skillExtract(
  name: string,
  options: SkillExtractOptions,
): Promise<void> {
  const memoryDir = resolveMemoryDir(options);

  if (!(await isInitialized(memoryDir))) {
    console.error(`Error: ${formatPath(memoryDir)} is not initialized.`);
    console.error("Run 'minimem init' first.");
    process.exit(1);
  }

  // Read from stdin
  const stdinContent = await readStdin();
  if (!stdinContent.trim()) {
    console.error("Error: No content provided via stdin.");
    console.error("\nUsage: echo 'YAML or JSON content' | minimem skill extract <name>");
    console.error("\nExpected format (YAML):");
    console.error(`  problem: "Description of the problem"`);
    console.error(`  triggerConditions: "When this applies"`);
    console.error(`  solution: "Step-by-step solution"`);
    console.error(`  verification: "How to verify" (optional)`);
    console.error(`  example: "Concrete example" (optional)`);
    console.error(`  notes: "Additional notes" (optional)`);
    process.exit(1);
  }

  // Parse input (simple YAML/JSON-like parsing)
  const parsed = parseSkillInput(stdinContent);

  if (!parsed.problem || !parsed.triggerConditions || !parsed.solution) {
    console.error("Error: Missing required fields: problem, triggerConditions, solution");
    process.exit(1);
  }

  const cliConfig = await loadConfig(memoryDir);
  const config = buildMinimemConfig(memoryDir, cliConfig, {
    provider: options.provider,
    watch: false,
  });

  const minimem = await Minimem.create(config);

  try {
    // Check if skill already exists
    if (await minimem.hasSkill(name)) {
      console.error(`Error: Skill '${name}' already exists.`);
      console.error("Use a different name or delete the existing skill first.");
      process.exit(1);
    }

    // Helper to ensure string type
    const asString = (val: string | string[] | undefined): string | undefined => {
      if (Array.isArray(val)) return val.join("\n");
      return val;
    };

    const asStringArray = (val: string | string[] | undefined): string[] | undefined => {
      if (Array.isArray(val)) return val;
      if (typeof val === "string") return val.split(",").map((s) => s.trim());
      return undefined;
    };

    const tags = options.tags
      ? options.tags.split(",").map((t) => t.trim())
      : asStringArray(parsed.tags);

    const skill = await minimem.writeSkill({
      name,
      problem: asString(parsed.problem) ?? "",
      triggerConditions: asString(parsed.triggerConditions) ?? "",
      solution: asString(parsed.solution) ?? "",
      verification: asString(parsed.verification),
      example: asString(parsed.example),
      notes: asString(parsed.notes),
      references: asStringArray(parsed.references),
      tags,
      author: options.author ?? asString(parsed.author),
    });

    console.log(`Skill '${skill.name}' created successfully.`);
    console.log(`Path: ${path.join(memoryDir, skill.path)}`);
  } finally {
    minimem.close();
  }
}

/**
 * Read stdin content
 */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];

  return new Promise((resolve) => {
    // Check if stdin has data
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    process.stdin.on("error", () => resolve(""));

    // Timeout after 100ms if no data
    setTimeout(() => {
      if (chunks.length === 0) {
        resolve("");
      }
    }, 100);
  });
}

/**
 * Parse skill input (simple YAML-like or JSON)
 */
function parseSkillInput(content: string): Record<string, string | string[] | undefined> {
  const trimmed = content.trim();

  // Try JSON first
  if (trimmed.startsWith("{")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Not valid JSON, try YAML
    }
  }

  // Simple YAML-like parsing
  const result: Record<string, string | string[] | undefined> = {};
  const lines = trimmed.split("\n");
  let currentKey: string | null = null;
  let multilineValue: string[] = [];

  const saveMultiline = () => {
    if (currentKey && multilineValue.length > 0) {
      result[currentKey] = multilineValue.join("\n").trim();
    }
    multilineValue = [];
  };

  for (const line of lines) {
    // Check for new key
    const keyMatch = line.match(/^(\w+):\s*(.*)$/);
    if (keyMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
      saveMultiline();
      const [, key, value] = keyMatch;
      if (key && value !== undefined) {
        if (value === "|" || value === ">") {
          currentKey = key;
        } else if (value.trim()) {
          result[key] = value.trim().replace(/^["']|["']$/g, "");
          currentKey = null;
        } else {
          currentKey = key;
        }
      }
    } else if (currentKey) {
      multilineValue.push(line.replace(/^  /, ""));
    }
  }
  saveMultiline();

  return result;
}

/**
 * Resolve memory directory from options
 */
function resolveMemoryDir(options: { dir?: string; global?: boolean }): string {
  if (options.global) {
    return path.join(os.homedir(), ".minimem");
  }
  if (options.dir) {
    return path.resolve(options.dir);
  }
  return process.cwd();
}

/**
 * Format snippet for terminal display
 */
function formatSnippet(snippet: string): string {
  const lines = snippet.split("\n").slice(0, 4);
  const formatted = lines.map((line) => `  ${line}`).join("\n");
  return formatted.length > 300 ? formatted.slice(0, 297) + "..." : formatted;
}
