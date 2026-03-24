import { defineConfig } from "tsup";

export default defineConfig([
  // Library build
  {
    entry: ["src/index.ts", "src/session.ts", "src/internal.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    external: ["node-llama-cpp", "node:sqlite"],
  },
  // CLI build - bundle everything into single file
  {
    entry: ["src/cli/index.ts"],
    format: ["esm"],
    outDir: "dist/cli",
    sourcemap: true,
    target: "node22",
    external: ["node-llama-cpp", "commander", "node:sqlite"],
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
