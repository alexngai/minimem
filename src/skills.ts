/**
 * Skill types and utilities for Claudeception-style skill extraction.
 * Skills are reusable knowledge extracted from work sessions.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * YAML frontmatter metadata for a skill file
 */
export type SkillMetadata = {
  /** Unique kebab-case identifier */
  name: string;
  /** Description for semantic matching - should include trigger conditions */
  description: string;
  /** Author of the skill */
  author?: string;
  /** Semantic version (e.g., "1.0.0") */
  version?: string;
  /** Creation/update date in YYYY-MM-DD format */
  date?: string;
  /** Tags for categorization */
  tags?: string[];
};

/**
 * Parsed skill with metadata and content sections
 */
export type Skill = SkillMetadata & {
  /** Full markdown content (including frontmatter) */
  rawContent: string;
  /** Content without frontmatter */
  content: string;
  /** Relative path to the skill file */
  path: string;
  /** Parsed sections from the skill content */
  sections: {
    problem?: string;
    triggerConditions?: string;
    solution?: string;
    verification?: string;
    example?: string;
    notes?: string;
    references?: string;
  };
};

/**
 * Skill search result with relevance score
 */
export type SkillSearchResult = {
  skill: Skill;
  score: number;
  /** Matched text snippet */
  snippet: string;
};

/**
 * Options for skill extraction
 */
export type SkillExtractionOptions = {
  /** Skill name (kebab-case) */
  name: string;
  /** Problem description */
  problem: string;
  /** Trigger conditions (error messages, symptoms) */
  triggerConditions: string;
  /** Step-by-step solution */
  solution: string;
  /** How to verify it worked */
  verification?: string;
  /** Concrete example */
  example?: string;
  /** Caveats and notes */
  notes?: string;
  /** Reference URLs */
  references?: string[];
  /** Tags for categorization */
  tags?: string[];
  /** Author name */
  author?: string;
};

const SKILLS_DIR = "skills";
const SKILL_FILENAME = "SKILL.md";

/**
 * Check if a path is a skill path
 */
export function isSkillPath(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized) return false;
  return normalized.startsWith(`${SKILLS_DIR}/`) && normalized.endsWith(".md");
}

/**
 * Get the skills directory path
 */
export function getSkillsDir(baseDir: string): string {
  return path.join(baseDir, SKILLS_DIR);
}

/**
 * Get the path for a specific skill
 */
export function getSkillPath(baseDir: string, skillName: string): string {
  return path.join(baseDir, SKILLS_DIR, skillName, SKILL_FILENAME);
}

/**
 * List all skill files in a directory
 */
export async function listSkillFiles(baseDir: string): Promise<string[]> {
  const skillsDir = getSkillsDir(baseDir);
  const result: string[] = [];

  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = path.join(skillsDir, entry.name, SKILL_FILENAME);
      try {
        await fs.access(skillFile);
        result.push(skillFile);
      } catch {
        // No SKILL.md in this directory
      }
    }
  } catch {
    // Skills directory doesn't exist
  }

  return result;
}

/**
 * Parse YAML frontmatter from markdown content
 */
export function parseFrontmatter(content: string): { metadata: Partial<SkillMetadata>; body: string } {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { metadata: {}, body: content };
  }

  const [, yamlContent, body] = frontmatterMatch;
  const metadata: Partial<SkillMetadata> = {};

  // Simple YAML parsing (handles common cases)
  const lines = (yamlContent ?? "").split("\n");
  let currentKey: string | null = null;
  let multilineValue: string[] = [];
  let inMultiline = false;

  const saveMultiline = () => {
    if (currentKey && multilineValue.length > 0) {
      const value = multilineValue.join("\n").trim();
      (metadata as Record<string, unknown>)[currentKey] = value;
    }
    multilineValue = [];
    inMultiline = false;
    currentKey = null;
  };

  for (const line of lines) {
    // Check for new key
    const keyMatch = line.match(/^(\w+(?:-\w+)*):\s*(.*)$/);
    if (keyMatch && !line.startsWith("  ") && !line.startsWith("\t")) {
      saveMultiline();
      const [, key, value] = keyMatch;
      if (key && value !== undefined) {
        if (value === "|" || value === ">") {
          // Multiline value starts
          currentKey = key;
          inMultiline = true;
        } else if (value.trim()) {
          // Single line value
          (metadata as Record<string, unknown>)[key] = value.trim();
        } else {
          // Empty value, might be start of multiline
          currentKey = key;
          inMultiline = true;
        }
      }
    } else if (inMultiline && currentKey) {
      // Continue multiline value
      multilineValue.push(line.replace(/^  /, ""));
    }
  }
  saveMultiline();

  // Parse tags if present
  if (typeof metadata.tags === "string") {
    const tagsStr = metadata.tags as string;
    if (tagsStr.startsWith("[")) {
      try {
        metadata.tags = JSON.parse(tagsStr);
      } catch {
        metadata.tags = tagsStr.split(",").map((t) => t.trim());
      }
    } else {
      metadata.tags = tagsStr.split(",").map((t) => t.trim());
    }
  }

  return { metadata, body: body ?? content };
}

/**
 * Parse sections from skill markdown content
 */
export function parseSections(content: string): Skill["sections"] {
  const sections: Skill["sections"] = {};
  const sectionRegex = /^##\s+(.+)$/gm;
  const matches = [...content.matchAll(sectionRegex)];

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const nextMatch = matches[i + 1];
    const heading = match[1]?.toLowerCase().trim() ?? "";
    const startIndex = match.index! + match[0].length;
    const endIndex = nextMatch?.index ?? content.length;
    const sectionContent = content.slice(startIndex, endIndex).trim();

    if (heading.includes("problem")) {
      sections.problem = sectionContent;
    } else if (heading.includes("trigger") || heading.includes("context")) {
      sections.triggerConditions = sectionContent;
    } else if (heading.includes("solution")) {
      sections.solution = sectionContent;
    } else if (heading.includes("verification") || heading.includes("verify")) {
      sections.verification = sectionContent;
    } else if (heading.includes("example")) {
      sections.example = sectionContent;
    } else if (heading.includes("note")) {
      sections.notes = sectionContent;
    } else if (heading.includes("reference")) {
      sections.references = sectionContent;
    }
  }

  return sections;
}

/**
 * Parse a skill file into a Skill object
 */
export function parseSkill(content: string, relativePath: string): Skill {
  const { metadata, body } = parseFrontmatter(content);
  const sections = parseSections(body);

  return {
    name: metadata.name ?? path.basename(path.dirname(relativePath)),
    description: metadata.description ?? "",
    author: metadata.author,
    version: metadata.version,
    date: metadata.date,
    tags: metadata.tags,
    rawContent: content,
    content: body,
    path: relativePath,
    sections,
  };
}

/**
 * Generate skill markdown content from extraction options
 */
export function generateSkillContent(options: SkillExtractionOptions): string {
  const date = new Date().toISOString().split("T")[0];
  const tags = options.tags?.length ? `\n  - ${options.tags.join("\n  - ")}` : "";
  const tagsLine = tags ? `tags:${tags}\n` : "";

  const references = options.references?.length
    ? `\n## References\n\n${options.references.map((r) => `- ${r}`).join("\n")}\n`
    : "";

  const verification = options.verification
    ? `\n## Verification\n\n${options.verification}\n`
    : "";

  const example = options.example ? `\n## Example\n\n${options.example}\n` : "";

  const notes = options.notes ? `\n## Notes\n\n${options.notes}\n` : "";

  // Build description for semantic matching
  const description = buildSkillDescription(options);

  return `---
name: ${options.name}
description: |
  ${description.split("\n").join("\n  ")}
author: ${options.author ?? "Claude Code"}
version: 1.0.0
date: ${date}
${tagsLine}---

# ${toTitleCase(options.name.replace(/-/g, " "))}

## Problem

${options.problem}

## Context / Trigger Conditions

${options.triggerConditions}

## Solution

${options.solution}
${verification}${example}${notes}${references}`;
}

/**
 * Build a description optimized for semantic matching
 */
function buildSkillDescription(options: SkillExtractionOptions): string {
  const parts: string[] = [];

  // Start with problem summary
  const problemSummary = options.problem.split("\n")[0]?.trim() ?? "";
  if (problemSummary) {
    parts.push(problemSummary);
  }

  // Add trigger conditions for matching
  const triggers = options.triggerConditions
    .split("\n")
    .filter((line) => line.trim().startsWith("-") || line.trim().startsWith("*"))
    .map((line) => line.replace(/^[-*]\s*/, "").trim())
    .slice(0, 3);

  if (triggers.length > 0) {
    parts.push(`Use when: ${triggers.join(", ")}.`);
  }

  // Add tags as context
  if (options.tags?.length) {
    parts.push(`Related: ${options.tags.join(", ")}.`);
  }

  return parts.join(" ");
}

/**
 * Convert kebab-case to Title Case
 */
function toTitleCase(str: string): string {
  return str
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Validate skill name (must be kebab-case)
 */
export function validateSkillName(name: string): boolean {
  return /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name);
}

/**
 * Convert a string to valid skill name (kebab-case)
 */
export function toSkillName(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}
