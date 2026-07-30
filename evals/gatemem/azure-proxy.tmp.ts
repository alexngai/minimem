/**
 * Minimal OpenAI-compatible → Azure OpenAI shim, so GateMem's official scorer can be
 * run UNMODIFIED against our Azure deployments.
 *
 * Their judge client (bench/llm/providers/openai_compatible.py) builds
 * `{api_base}/chat/completions` and authenticates with `Authorization: Bearer`. Azure
 * needs `/openai/deployments/{model}/chat/completions?api-version=...` and an `api-key`
 * header. Patching their scorer would compromise the point of using the official one, so
 * we translate at the transport instead.
 *
 *   npx tsx evals/gatemem/azure-proxy.tmp.ts --port 8787
 *   ... --judge_api_base http://127.0.0.1:8787 --judge_api_key_env GATEMEM_DUMMY_KEY
 */
import http from "node:http";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const PORT = Number(arg("port", "8787"));
const BASE = (process.env.AZURE_API_BASE ?? "").replace(/\/$/, "");
const KEY = process.env.AZURE_API_KEY ?? "";
const API_VERSION = process.env.AZURE_API_VERSION ?? "2025-04-01-preview";

if (!BASE || !KEY) {
  console.error("AZURE_API_BASE and AZURE_API_KEY must be set");
  process.exit(1);
}

let forwarded = 0;
let failed = 0;

const server = http.createServer((req, res) => {
  if (!req.url?.endsWith("/chat/completions") || req.method !== "POST") {
    res.writeHead(404).end(JSON.stringify({ error: "only POST /chat/completions" }));
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let deployment = "gpt-4.1";
    let body = raw;
    try {
      const parsed = JSON.parse(raw) as { model?: string };
      if (typeof parsed.model === "string" && parsed.model.trim()) deployment = parsed.model.trim();
      // Azure takes the deployment from the URL; leaving `model` in the body is harmless.
      body = JSON.stringify(parsed);
    } catch {
      /* forward verbatim and let Azure complain */
    }
    const url = `${BASE}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${API_VERSION}`;
    try {
      const upstream = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": KEY },
        body,
      });
      const text = await upstream.text();
      if (!upstream.ok) {
        failed++;
        process.stderr.write(`[proxy] ${upstream.status} ${deployment}: ${text.slice(0, 200)}\n`);
      } else {
        forwarded++;
        if (forwarded % 50 === 0) process.stderr.write(`[proxy] ${forwarded} ok, ${failed} failed\n`);
      }
      res.writeHead(upstream.status, { "Content-Type": "application/json" }).end(text);
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[proxy] fetch error: ${message}\n`);
      res.writeHead(502, { "Content-Type": "application/json" }).end(JSON.stringify({ error: message }));
    }
  });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[proxy] OpenAI-compatible → Azure on http://127.0.0.1:${PORT} (api-version ${API_VERSION})\n`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    process.stderr.write(`[proxy] shutting down (${forwarded} ok, ${failed} failed)\n`);
    server.close(() => process.exit(0));
  });
}
