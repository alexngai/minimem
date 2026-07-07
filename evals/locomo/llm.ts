/**
 * Azure OpenAI (GPT-5.5) chat client for the LOCOMO harness.
 *
 * GPT-5.5 is a reasoning model: it uses `max_completion_tokens` (not
 * `max_tokens`), does not accept a custom `temperature`, and its reasoning
 * tokens are billed as completion tokens. We surface the API's `usage` block so
 * the harness can report the real cost axis.
 *
 * Credentials come from the environment (see ~/.zshrc):
 *   AZURE_API_BASE      e.g. https://<resource>.openai.azure.com
 *   AZURE_API_KEY
 *   AZURE_API_VERSION   e.g. 2025-04-01-preview
 *   AZURE_DEPLOYMENT    optional; defaults to "gpt-5.5"
 */

export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
}

export interface LlmResult {
  text: string;
  usage: LlmUsage;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClientOptions {
  base?: string;
  apiKey?: string;
  apiVersion?: string;
  deployment?: string;
  /** Generous default: reasoning tokens count against this budget. */
  maxCompletionTokens?: number;
  /** Retries on 429 / 5xx. */
  maxRetries?: number;
  /** Per-request wall-clock timeout (ms). node fetch has NO default timeout, so
   *  a stuck connection would hang forever — fatal during ingest extraction,
   *  which (unlike answer()) has no outer timeout. On abort we retry. */
  requestTimeoutMs?: number;
}

export class LlmClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly maxCompletionTokens: number;
  private readonly maxRetries: number;
  private readonly requestTimeoutMs: number;
  readonly deployment: string;

  /** Cumulative usage across all calls for this client instance. */
  totals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 };

  constructor(opts?: LlmClientOptions) {
    const base = opts?.base ?? process.env.AZURE_API_BASE;
    const apiKey = opts?.apiKey ?? process.env.AZURE_API_KEY;
    const apiVersion = opts?.apiVersion ?? process.env.AZURE_API_VERSION;
    this.deployment = opts?.deployment ?? process.env.AZURE_DEPLOYMENT ?? "gpt-5.5";

    if (!base) throw new Error("AZURE_API_BASE is not set");
    if (!apiKey) throw new Error("AZURE_API_KEY is not set");
    if (!apiVersion) throw new Error("AZURE_API_VERSION is not set");

    this.apiKey = apiKey;
    this.url = `${base.replace(/\/$/, "")}/openai/deployments/${this.deployment}/chat/completions?api-version=${apiVersion}`;
    this.maxCompletionTokens = opts?.maxCompletionTokens ?? 4096;
    this.maxRetries = opts?.maxRetries ?? 4;
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? 150_000;
  }

  async chat(messages: LlmMessage[]): Promise<LlmResult> {
    const body = JSON.stringify({
      messages,
      max_completion_tokens: this.maxCompletionTokens,
    });

    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const started = Date.now();
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), this.requestTimeoutMs);
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "api-key": this.apiKey, "content-type": "application/json" },
          body,
          signal: ac.signal,
        });

        if (res.status === 429 || res.status >= 500) {
          const retryAfter = Number(res.headers.get("retry-after")) || 0;
          const backoff = retryAfter * 1000 || Math.min(30000, 1000 * 2 ** attempt);
          await sleep(backoff);
          lastErr = new Error(`HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) {
          const body = await res.text();
          // Azure's content-management policy rejects some LOCOMO prompts
          // (400 content_filter). It is not retryable and must not kill the
          // run: treat it as an unanswerable question (empty answer, scored
          // wrong) so the arm continues.
          if (res.status === 400 && /content_filter|ResponsibleAIPolicy/i.test(body)) {
            return {
              text: "",
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, latencyMs: Date.now() - started },
            };
          }
          throw new Error(`Azure chat failed: HTTP ${res.status} ${body}`);
        }

        const json = (await res.json()) as {
          choices: { message: { content: string | null } }[];
          usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
        };
        const latencyMs = Date.now() - started;
        const u = json.usage;
        const usage: LlmUsage = {
          promptTokens: u?.prompt_tokens ?? 0,
          completionTokens: u?.completion_tokens ?? 0,
          totalTokens: u?.total_tokens ?? 0,
          latencyMs,
        };
        this.totals.promptTokens += usage.promptTokens;
        this.totals.completionTokens += usage.completionTokens;
        this.totals.totalTokens += usage.totalTokens;
        this.totals.calls += 1;

        return { text: json.choices[0]?.message?.content ?? "", usage };
      } catch (err) {
        lastErr = err instanceof Error && err.name === "AbortError"
          ? new Error(`request timeout after ${this.requestTimeoutMs}ms`)
          : err;
        await sleep(Math.min(30000, 1000 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new Error(
      `Azure chat exhausted retries: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  /** Convenience: single-prompt completion returning just the text. */
  async complete(prompt: string): Promise<string> {
    const { text } = await this.chat([{ role: "user", content: prompt }]);
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
