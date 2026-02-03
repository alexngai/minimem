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
