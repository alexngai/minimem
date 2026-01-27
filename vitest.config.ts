import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: [
      "**/node_modules/**",
      "**/clawdbot/**",
      "**/dist/**",
      // Integration tests use Node.js native test runner (node:test)
      // Run with: npm run test:integration
      "**/*.integration.test.ts",
    ],
  },
});
