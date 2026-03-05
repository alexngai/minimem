import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/clawdbot/**",
      "**/dist/**",
      // These tests use node:sqlite which Vite can't handle
      // Run with: npm run test:integration or npm run test:cli
      "**/*.integration.test.ts",
      "**/cli/__tests__/commands.test.ts",
      // knowledge.test.ts uses node:sqlite for graph tests — run via test:knowledge
      // Frontmatter tests are in knowledge-frontmatter.test.ts (vitest-compatible)
      "src/__tests__/knowledge.test.ts",
    ],
    // Run tests sequentially to avoid XDG_CONFIG_HOME conflicts
    pool: "forks",
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
