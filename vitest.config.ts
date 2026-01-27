import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    watch: false,
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/clawdbot/**",
      "**/dist/**",
      // Integration tests use Node.js native test runner (node:test)
      // Run with: npm run test:integration
      "**/*.integration.test.ts",
      // CLI tests use Node.js native test runner (node:sqlite not supported in vitest)
      // Run with: npm run test:cli
      "**/cli/__tests__/**",
    ],
  },
});
