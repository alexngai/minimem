import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";

import { materializeStore, type MaterializeResult } from "../materialize.js";

describe("materializeStore", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "minimem-materialize-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns symlink strategy for existing local store", async () => {
    const storePath = path.join(tmpDir, "my-store");
    await fs.mkdir(storePath, { recursive: true });
    await fs.writeFile(path.join(storePath, "MEMORY.md"), "# Memory\n");

    const result = await materializeStore("my-store", { path: storePath });

    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("symlink");
    expect(result!.path).toBe(storePath);

    // Cleanup should work without error
    await result!.cleanup();
  });

  it("returns null for nonexistent store with no remote", async () => {
    const result = await materializeStore("missing", {
      path: "/nonexistent/path",
    });
    expect(result).toBeNull();
  });

  it("symlink cleanup removes temp dir", async () => {
    const storePath = path.join(tmpDir, "my-store");
    await fs.mkdir(storePath, { recursive: true });

    const result = await materializeStore("my-store", { path: storePath });
    expect(result).not.toBeNull();

    // The cleanup function should not throw
    await result!.cleanup();
  });
});
