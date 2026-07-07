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
function getModuleDir(): string | null {
  // ESM: derive from import.meta.url. In the CJS bundle, bundlers rewrite
  // import.meta to an empty object, so url is undefined there.
  try {
    const url = import.meta.url;
    if (url) return dirname(fileURLToPath(url));
  } catch {
    // import.meta unavailable
  }
  // CJS fallback
  if (typeof __dirname !== "undefined") return __dirname;
  return null;
}

function getPackageVersion(): string {
  let dir = getModuleDir();
  if (!dir) return "0.0.0";

  // Walk up from the compiled file until we find minimem's package.json.
  // The depth differs between source (src/cli/), the CLI bundle (dist/cli/),
  // and the library bundle (dist/), so probe each ancestor.
  for (let i = 0; i < 4; i++) {
    try {
      const packageJson = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf-8"),
      );
      if (packageJson.name === "minimem" && packageJson.version) {
        return packageJson.version;
      }
    } catch {
      // No package.json at this level — keep walking up
    }
    dir = dirname(dir);
  }

  return "0.0.0";
}

export const VERSION = getPackageVersion();
