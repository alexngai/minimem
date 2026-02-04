/**
 * Version management for the CLI
 *
 * Reads the version from package.json at runtime for consistency.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Get the package version from package.json
 *
 * This reads from the package.json at runtime to ensure the CLI
 * version always matches the published package version.
 */
function getPackageVersion(): string {
  try {
    // In ESM, we need to get __dirname equivalent
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    // Navigate from src/cli/ to package root
    const packagePath = join(__dirname, "../../package.json");
    const packageJson = JSON.parse(readFileSync(packagePath, "utf-8"));
    return packageJson.version || "0.0.0";
  } catch {
    // Fallback if we can't read package.json
    // This might happen in bundled builds where path resolution differs
    return "0.0.0";
  }
}

export const VERSION = getPackageVersion();
