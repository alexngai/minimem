import { defineConfig } from "tsup";

export default defineConfig([
  // Library build
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    clean: true,
    sourcemap: true,
    target: "node22",
    external: ["node-llama-cpp"],
  },
  // CLI build - bundle everything into single file
  {
    entry: ["src/cli/index.ts"],
    format: ["esm"],
    outDir: "dist/cli",
    sourcemap: true,
    target: "node22",
    external: ["node-llama-cpp", "commander"],
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
