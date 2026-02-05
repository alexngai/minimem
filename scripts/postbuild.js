#!/usr/bin/env node

/**
 * Cross-platform postbuild script
 *
 * Fixes the sqlite import in the CLI bundle.
 * esbuild/tsup strips the "node:" prefix from built-in modules,
 * but node:sqlite requires it.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, "../dist/cli/index.js");

try {
  let content = readFileSync(cliPath, "utf-8");

  // Fix sqlite import (esbuild strips the node: prefix)
  const before = content;
  content = content.replace(/from "sqlite"/g, 'from "node:sqlite"');
  content = content.replace(/from 'sqlite'/g, "from 'node:sqlite'");

  if (content !== before) {
    writeFileSync(cliPath, content);
    console.log("✓ Fixed node:sqlite import in dist/cli/index.js");
  } else {
    console.log("✓ No sqlite import fixes needed");
  }
} catch (error) {
  console.error("Error running postbuild:", error.message);
  process.exit(1);
}
