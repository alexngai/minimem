import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type EmbeddingBackend =
  | string
  | {
      provider?: string;
      openai?: { baseUrl?: string };
      baseUrl?: string;
    }
  | undefined;

export interface LocalEmbeddingLease {
  label: string;
  lockDir: string;
  release: () => Promise<void>;
}

export interface LocalEmbeddingLeaseOptions {
  label?: string;
  lockDir?: string;
  pollMs?: number;
  staleMs?: number;
}

const DEFAULT_LOCK_DIR = path.join(os.tmpdir(), "minimem-eval-local-embedding.lock");
const DEFAULT_POLL_MS = 500;
const DEFAULT_STALE_MS = 30 * 60 * 1000;

export function needsLocalEmbeddingLease(backend: EmbeddingBackend): boolean {
  if (!backend) return false;
  if (typeof backend === "string") return backend !== "none";

  const provider = backend.provider ?? "none";
  if (provider === "none") return false;
  if (provider === "local") return true;

  const baseUrl = backend.openai?.baseUrl ?? backend.baseUrl ?? "";
  return provider === "openai" && /(?:localhost|127\.0\.0\.1|0\.0\.0\.0|ollama)/i.test(baseUrl);
}

export async function acquireLocalEmbeddingLease(
  backend: EmbeddingBackend,
  opts: LocalEmbeddingLeaseOptions = {},
): Promise<LocalEmbeddingLease | null> {
  if (!needsLocalEmbeddingLease(backend)) return null;

  const label = opts.label ?? "local-embedding";
  const lockDir = opts.lockDir ?? DEFAULT_LOCK_DIR;
  const ownerPath = path.join(lockDir, "owner.json");
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(
        ownerPath,
        JSON.stringify(
          {
            pid: process.pid,
            token,
            label,
            cwd: process.cwd(),
            startedAt: new Date().toISOString(),
          },
          null,
          2,
        ),
        "utf-8",
      );
      return {
        label,
        lockDir,
        release: once(async () => {
          const owner = await readOwner(ownerPath);
          if (owner?.token === token) {
            await fs.rm(lockDir, { recursive: true, force: true });
          }
        }),
      };
    } catch (err) {
      if (!isNodeError(err) || err.code !== "EEXIST") throw err;
      if (await lockLooksStale(lockDir, ownerPath, staleMs)) {
        await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      await sleep(pollMs);
    }
  }
}

async function lockLooksStale(lockDir: string, ownerPath: string, staleMs: number): Promise<boolean> {
  const owner = await readOwner(ownerPath);
  if (typeof owner?.pid === "number") return !pidIsAlive(owner.pid);

  const stat = await fs.stat(lockDir).catch(() => null);
  return stat ? Date.now() - stat.mtimeMs > staleMs : true;
}

async function readOwner(ownerPath: string): Promise<{ pid?: number; token?: string } | null> {
  try {
    return JSON.parse(await fs.readFile(ownerPath, "utf-8")) as { pid?: number; token?: string };
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return isNodeError(err) && err.code === "EPERM";
  }
}

function once(fn: () => Promise<void>): () => Promise<void> {
  let called = false;
  return async () => {
    if (called) return;
    called = true;
    await fn();
  };
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
