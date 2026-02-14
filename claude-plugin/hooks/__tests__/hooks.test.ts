/**
 * Tests for hook scripts config checking behavior.
 *
 * These tests verify that session-start and session-end hooks
 * respect the hooks config (enabled/disabled). They run the actual
 * shell scripts in temp directories with controlled configs.
 *
 * Run with: npx tsx --test claude-plugin/hooks/__tests__/hooks.test.ts
 */

import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert";

const HOOKS_DIR = path.resolve(
  import.meta.dirname,
  "..",
);

describe("hook scripts config checks", () => {
  let tempDir: string;
  let originalHome: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-hooks-test-"));
    originalHome = process.env.HOME!;
    // Use a fake HOME so global config doesn't interfere
    process.env.HOME = tempDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Run a hook script in a given working directory.
   * Returns exit code (0 = success/early-exit, non-zero = error).
   * We pipe empty JSON as stdin since hooks expect input.
   */
  function runHook(
    script: string,
    cwd: string,
    stdinData = "{}",
  ): { exitCode: number; stdout: string; stderr: string } {
    try {
      const stdout = execSync(`echo '${stdinData}' | bash "${script}"`, {
        cwd,
        env: { ...process.env, HOME: tempDir },
        timeout: 10_000,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { exitCode: 0, stdout: stdout.toString(), stderr: "" };
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return {
        exitCode: e.status ?? 1,
        stdout: (e.stdout ?? "").toString(),
        stderr: (e.stderr ?? "").toString(),
      };
    }
  }

  describe("session-start hook", () => {
    const script = path.join(HOOKS_DIR, "session-start.sh");

    it("should exit early when no .minimem directories exist", () => {
      const result = runHook(script, tempDir);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), "");
    });

    it("should exit early when hooks.sessionStart is not set (defaults to false)", async () => {
      // Create local .minimem with config but no hooks setting
      const configDir = path.join(tempDir, ".minimem");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ embedding: { provider: "auto" } }),
      );

      const result = runHook(script, tempDir);
      assert.strictEqual(result.exitCode, 0);
      // Should produce no output (exited before search)
      assert.strictEqual(result.stdout.trim(), "");
    });

    it("should exit early when hooks.sessionStart is false in local config", async () => {
      const configDir = path.join(tempDir, ".minimem");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ hooks: { sessionStart: false } }),
      );

      const result = runHook(script, tempDir);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), "");
    });

    it("should exit early when hooks.sessionStart is false in global config", async () => {
      // Create global config at $HOME/.minimem/.minimem/config.json
      const globalConfigDir = path.join(tempDir, ".minimem", ".minimem");
      await fs.mkdir(globalConfigDir, { recursive: true });
      await fs.writeFile(
        path.join(globalConfigDir, "config.json"),
        JSON.stringify({ hooks: { sessionStart: false } }),
      );

      const result = runHook(script, tempDir);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), "");
    });

    it("should allow local config to override global config (local true, global false)", async () => {
      // Global: disabled
      const globalConfigDir = path.join(tempDir, ".minimem", ".minimem");
      await fs.mkdir(globalConfigDir, { recursive: true });
      await fs.writeFile(
        path.join(globalConfigDir, "config.json"),
        JSON.stringify({ hooks: { sessionStart: false } }),
      );

      // Local: enabled — script should proceed past config check
      // (it will fail at npx minimem search, but that's expected)
      const localConfigDir = path.join(tempDir, ".minimem");
      await fs.writeFile(
        path.join(localConfigDir, "config.json"),
        JSON.stringify({ hooks: { sessionStart: true } }),
      );

      const result = runHook(script, tempDir);
      // Script proceeds past config check. It will exit 0 because
      // the npx search failure is caught with || true
      assert.strictEqual(result.exitCode, 0);
    });

    it("should allow local config to override global config (local false, global true)", async () => {
      // Global: enabled
      const globalConfigDir = path.join(tempDir, ".minimem", ".minimem");
      await fs.mkdir(globalConfigDir, { recursive: true });
      await fs.writeFile(
        path.join(globalConfigDir, "config.json"),
        JSON.stringify({ hooks: { sessionStart: true } }),
      );

      // Local: disabled
      const localConfigDir = path.join(tempDir, ".minimem");
      await fs.writeFile(
        path.join(localConfigDir, "config.json"),
        JSON.stringify({ hooks: { sessionStart: false } }),
      );

      const result = runHook(script, tempDir);
      assert.strictEqual(result.exitCode, 0);
      // Should exit early — no search output
      assert.strictEqual(result.stdout.trim(), "");
    });
  });

  describe("session-end hook", () => {
    const script = path.join(HOOKS_DIR, "session-end.sh");

    it("should exit early when no .minimem directories exist", () => {
      const result = runHook(script, tempDir);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), "");
    });

    it("should exit early when hooks.sessionEnd is not set (defaults to false)", async () => {
      const configDir = path.join(tempDir, ".minimem");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ embedding: { provider: "auto" } }),
      );

      const result = runHook(script, tempDir);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), "");
    });

    it("should exit early when hooks.sessionEnd is false in local config", async () => {
      const configDir = path.join(tempDir, ".minimem");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ hooks: { sessionEnd: false } }),
      );

      const result = runHook(script, tempDir);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), "");
    });

    it("should exit early when hooks.sessionEnd is false in global config", async () => {
      const globalConfigDir = path.join(tempDir, ".minimem", ".minimem");
      await fs.mkdir(globalConfigDir, { recursive: true });
      await fs.writeFile(
        path.join(globalConfigDir, "config.json"),
        JSON.stringify({ hooks: { sessionEnd: false } }),
      );

      const result = runHook(script, tempDir);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), "");
    });

    it("should allow local config to override global config (local true, global false)", async () => {
      // Global: disabled
      const globalConfigDir = path.join(tempDir, ".minimem", ".minimem");
      await fs.mkdir(globalConfigDir, { recursive: true });
      await fs.writeFile(
        path.join(globalConfigDir, "config.json"),
        JSON.stringify({ hooks: { sessionEnd: false } }),
      );

      // Local: enabled
      const localConfigDir = path.join(tempDir, ".minimem");
      await fs.writeFile(
        path.join(localConfigDir, "config.json"),
        JSON.stringify({ hooks: { sessionEnd: true } }),
      );

      const result = runHook(script, tempDir);
      // Script proceeds past config check — npx append will fail but is caught
      assert.strictEqual(result.exitCode, 0);
    });

    it("should allow local config to override global config (local false, global true)", async () => {
      // Global: enabled
      const globalConfigDir = path.join(tempDir, ".minimem", ".minimem");
      await fs.mkdir(globalConfigDir, { recursive: true });
      await fs.writeFile(
        path.join(globalConfigDir, "config.json"),
        JSON.stringify({ hooks: { sessionEnd: true } }),
      );

      // Local: disabled
      const localConfigDir = path.join(tempDir, ".minimem");
      await fs.writeFile(
        path.join(localConfigDir, "config.json"),
        JSON.stringify({ hooks: { sessionEnd: false } }),
      );

      const result = runHook(script, tempDir);
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), "");
    });

    it("should exit early when stop_hook_active is true", async () => {
      const configDir = path.join(tempDir, ".minimem");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(
        path.join(configDir, "config.json"),
        JSON.stringify({ hooks: { sessionEnd: true } }),
      );

      const result = runHook(
        script,
        tempDir,
        JSON.stringify({ stop_hook_active: true }),
      );
      assert.strictEqual(result.exitCode, 0);
      assert.strictEqual(result.stdout.trim(), "");
    });
  });
});
