import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  test: {
    watch: false,
    // Pure-function tests only. *.smoke.test.ts use node:sqlite (run via tsx).
    include: ["datasets/**/*.test.ts", "harness/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/cache/**", "**/*.smoke.test.ts"],
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
