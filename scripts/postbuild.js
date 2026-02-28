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

const filesToPatch = [
  join(__dirname, "../dist/cli/index.js"),
  join(__dirname, "../dist/index.cjs"),
  join(__dirname, "../dist/session.cjs"),
  join(__dirname, "../dist/internal.cjs"),
];

for (const filePath of filesToPatch) {
  try {
    let content = readFileSync(filePath, "utf-8");

    // Fix sqlite import (esbuild strips the node: prefix)
    const before = content;
    content = content.replace(/from "sqlite"/g, 'from "node:sqlite"');
    content = content.replace(/from 'sqlite'/g, "from 'node:sqlite'");
    content = content.replace(/require\("sqlite"\)/g, 'require("node:sqlite")');
    content = content.replace(/require\('sqlite'\)/g, "require('node:sqlite')");

    if (content !== before) {
      writeFileSync(filePath, content);
      console.log(`✓ Fixed node:sqlite import in ${filePath}`);
    } else {
      console.log(`✓ No sqlite import fixes needed in ${filePath}`);
    }
  } catch (error) {
    if (error.code === "ENOENT") {
      console.log(`⊘ Skipped ${filePath} (not found)`);
    } else {
      console.error(`Error patching ${filePath}:`, error.message);
      process.exit(1);
    }
  }
}
