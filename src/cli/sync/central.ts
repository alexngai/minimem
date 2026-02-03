/**
 * Central repository initialization and management
 */

import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";

import { expandPath, saveXdgConfig, loadXdgConfig } from "../config.js";
import {
  createEmptyRegistry,
  writeRegistry,
  readRegistry,
  getRegistryPath,
} from "./registry.js";
import { isInsideGitRepo } from "./detection.js";

const GITIGNORE_CONTENT = `# Minimem sync - ignore database files and temp directories
*.db
*.db-journal
*.db-wal
*.db-shm
staging/
conflicts/
shadows/
.DS_Store
`;

const README_CONTENT = `# Minimem Central Repository

This repository contains synchronized memory files from minimem.

## Structure

Each directory represents a mapped memory location:

\`\`\`
memories-repo/
├── global/              # ~/.minimem/
├── work/                # ~/work/memories/
└── projects/
    └── myproject/       # ~/projects/myproject/
\`\`\`

## Registry

The \`.minimem-registry.json\` file tracks which local directories are mapped to which paths.
This prevents path collisions when multiple machines sync to the same repository.

## Usage

To sync a local memory directory to this repo:

\`\`\`bash
minimem config --xdg-global --set centralRepo=<path-to-this-repo>
minimem sync init --path <directory-name>/
\`\`\`

## Files

- \`.minimem-registry.json\` - Tracks sync mappings
- \`.gitignore\` - Ignores database and temp files
- \`*/MEMORY.md\` - Main memory files
- \`*/memory/*.md\` - Additional memory files
`;

export type InitCentralResult = {
  success: boolean;
  path: string;
  created: boolean;
  message: string;
};

/**
 * Check if a path is writable
 */
async function isWritable(dirPath: string): Promise<boolean> {
  try {
    const testFile = path.join(dirPath, `.minimem-write-test-${Date.now()}`);
    await fs.writeFile(testFile, "test");
    await fs.unlink(testFile);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if git is available
 */
function isGitAvailable(): boolean {
  try {
    execSync("git --version", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Initialize a git repository
 */
async function initGitRepo(dirPath: string): Promise<void> {
  execSync("git init", { cwd: dirPath, stdio: "pipe" });
}

/**
 * Initialize a new central repository or configure an existing one
 */
export async function initCentralRepo(
  repoPath: string
): Promise<InitCentralResult> {
  const expandedPath = expandPath(repoPath);
  const resolvedPath = path.resolve(expandedPath);

  // Check if git is available
  if (!isGitAvailable()) {
    return {
      success: false,
      path: resolvedPath,
      created: false,
      message: "Git is not installed or not available in PATH",
    };
  }

  // Check if directory exists
  let dirExists = false;
  try {
    const stat = await fs.stat(resolvedPath);
    dirExists = stat.isDirectory();
  } catch {
    dirExists = false;
  }

  let created = false;

  if (!dirExists) {
    // Create new directory
    try {
      await fs.mkdir(resolvedPath, { recursive: true });
      created = true;
    } catch (error) {
      return {
        success: false,
        path: resolvedPath,
        created: false,
        message: `Failed to create directory: ${error}`,
      };
    }
  }

  // Check if writable
  if (!(await isWritable(resolvedPath))) {
    return {
      success: false,
      path: resolvedPath,
      created,
      message: "Directory is not writable",
    };
  }

  // Initialize git repo if not already
  const isGitRepo = await isInsideGitRepo(resolvedPath);
  if (!isGitRepo) {
    try {
      await initGitRepo(resolvedPath);
    } catch (error) {
      return {
        success: false,
        path: resolvedPath,
        created,
        message: `Failed to initialize git repository: ${error}`,
      };
    }
  }

  // Create .gitignore if not exists
  const gitignorePath = path.join(resolvedPath, ".gitignore");
  try {
    await fs.access(gitignorePath);
  } catch {
    await fs.writeFile(gitignorePath, GITIGNORE_CONTENT, "utf-8");
  }

  // Create registry if not exists
  const registryPath = getRegistryPath(resolvedPath);
  try {
    await fs.access(registryPath);
  } catch {
    await writeRegistry(resolvedPath, createEmptyRegistry());
  }

  // Create README if not exists
  const readmePath = path.join(resolvedPath, "README.md");
  try {
    await fs.access(readmePath);
  } catch {
    await fs.writeFile(readmePath, README_CONTENT, "utf-8");
  }

  // Update global config with central repo path
  const globalConfig = await loadXdgConfig();
  globalConfig.centralRepo = repoPath; // Store original (possibly with ~)
  await saveXdgConfig(globalConfig);

  return {
    success: true,
    path: resolvedPath,
    created,
    message: created
      ? "Created new central repository"
      : "Configured existing directory as central repository",
  };
}

/**
 * Validate an existing central repository
 */
export async function validateCentralRepo(repoPath: string): Promise<{
  valid: boolean;
  warnings: string[];
  errors: string[];
}> {
  const expandedPath = expandPath(repoPath);
  const resolvedPath = path.resolve(expandedPath);
  const warnings: string[] = [];
  const errors: string[] = [];

  // Check directory exists
  try {
    const stat = await fs.stat(resolvedPath);
    if (!stat.isDirectory()) {
      errors.push("Path is not a directory");
      return { valid: false, warnings, errors };
    }
  } catch {
    errors.push("Directory does not exist");
    return { valid: false, warnings, errors };
  }

  // Check if git repo
  const isGitRepo = await isInsideGitRepo(resolvedPath);
  if (!isGitRepo) {
    warnings.push("Not a git repository - sync features may be limited");
  }

  // Check for registry
  const registryPath = getRegistryPath(resolvedPath);
  try {
    await fs.access(registryPath);
    // Validate registry content
    const registry = await readRegistry(resolvedPath);
    if (!registry.mappings) {
      warnings.push("Registry file is malformed");
    }
  } catch {
    warnings.push("Registry file is missing - will be created on first sync");
  }

  // Check for .gitignore
  const gitignorePath = path.join(resolvedPath, ".gitignore");
  try {
    const gitignore = await fs.readFile(gitignorePath, "utf-8");
    if (!gitignore.includes("*.db")) {
      warnings.push(".gitignore does not exclude database files");
    }
  } catch {
    warnings.push(".gitignore is missing");
  }

  // Check if writable
  if (!(await isWritable(resolvedPath))) {
    errors.push("Directory is not writable");
  }

  return {
    valid: errors.length === 0,
    warnings,
    errors,
  };
}

/**
 * Get the configured central repo path
 */
export async function getCentralRepoPath(): Promise<string | undefined> {
  const globalConfig = await loadXdgConfig();
  if (globalConfig.centralRepo) {
    return path.resolve(expandPath(globalConfig.centralRepo));
  }
  return undefined;
}
