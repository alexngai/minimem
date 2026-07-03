import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveInitEmbedding } from "../embedding-setup.js";

const KEYS = ["OPENAI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"] as const;

describe("resolveInitEmbedding (non-interactive)", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // Force the non-interactive path regardless of the test TTY.
    saved.MINIMEM_NONINTERACTIVE = process.env.MINIMEM_NONINTERACTIVE;
    process.env.MINIMEM_NONINTERACTIVE = "1";
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (saved.MINIMEM_NONINTERACTIVE === undefined) {
      delete process.env.MINIMEM_NONINTERACTIVE;
    } else {
      process.env.MINIMEM_NONINTERACTIVE = saved.MINIMEM_NONINTERACTIVE;
    }
  });

  it("defaults to keyword-only ('auto') when no key and non-interactive", async () => {
    const result = await resolveInitEmbedding({});
    expect(result.embedding.provider).toBe("auto");
    expect(result.messages.join("\n")).toMatch(/keyword-only/i);
  });

  it("honors --yes with the same keyword-only default", async () => {
    const result = await resolveInitEmbedding({ yes: true });
    expect(result.embedding.provider).toBe("auto");
  });

  it("uses auto and reports detection when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const result = await resolveInitEmbedding({});
    expect(result.embedding.provider).toBe("auto");
    expect(result.messages.join("\n")).toMatch(/OPENAI_API_KEY/);
    expect(result.messages.join("\n")).toMatch(/openai/);
  });

  it("detects Gemini via GOOGLE_API_KEY", async () => {
    process.env.GOOGLE_API_KEY = "g-test";
    const result = await resolveInitEmbedding({});
    expect(result.embedding.provider).toBe("auto");
    expect(result.messages.join("\n")).toMatch(/gemini/i);
  });

  it("honors an explicit --provider and notes a missing key", async () => {
    const result = await resolveInitEmbedding({ provider: "openai" });
    expect(result.embedding.provider).toBe("openai");
    expect(result.messages.join("\n")).toMatch(/--provider/);
    expect(result.messages.join("\n")).toMatch(/no openai key/i);
  });

  it("honors --provider local with a download note", async () => {
    const result = await resolveInitEmbedding({ provider: "local" });
    expect(result.embedding.provider).toBe("local");
    expect(result.messages.join("\n")).toMatch(/download on first sync/i);
  });

  it("does not note a missing key when the env key matches the explicit provider", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const result = await resolveInitEmbedding({ provider: "openai" });
    expect(result.embedding.provider).toBe("openai");
    expect(result.messages.join("\n")).not.toMatch(/no openai key/i);
  });
});
