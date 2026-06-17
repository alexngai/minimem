/**
 * Retrieval eval CLI (W5a). Runs the config matrix over a BEIR dataset (or a
 * local fixture dir) and writes a Markdown + JSON report.
 *
 *   npx tsx evals/cli.ts --fixture evals/datasets/__fixtures__/mini   # offline, BM25-only
 *   npx tsx evals/cli.ts --dataset scifact --bm25-only                # network (download), free
 *   npx tsx evals/cli.ts --dataset scifact \
 *     --embedding openai:text-embedding-3-small --base-url $TEI_URL --out scifact.md
 *
 * Embedding spec: none | openai[:model] | gemini[:model] | local[:modelPath].
 * For SageMaker/Bedrock via an OpenAI-compatible endpoint, use
 * `--embedding openai:<model> --base-url <url>` (key from OPENAI_API_KEY).
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { MinimemConfig } from "../src/index.js";
import { loadBeirDataset, parseBeirDir, type BeirDatasetName } from "./datasets/beir.js";
import type { BeirDataset } from "./datasets/types.js";
import { runMatrix, P0_CONFIGS, BM25_CONFIGS } from "./harness/matrix.js";
import { formatMarkdown, toJSON } from "./harness/report.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

function parseEmbedding(spec: string | undefined, baseUrl?: string): MinimemConfig["embedding"] {
  const s = (spec ?? "none").trim();
  if (s === "none") return { provider: "none" };
  // Split on the FIRST colon only — model ids can contain colons
  // (e.g. Bedrock "amazon.titan-embed-text-v2:0").
  const colon = s.indexOf(":");
  const provider = colon === -1 ? s : s.slice(0, colon);
  const model = colon === -1 ? undefined : s.slice(colon + 1);
  if (provider === "openai") {
    return { provider: "openai", model, openai: baseUrl ? { baseUrl } : undefined };
  }
  if (provider === "gemini") {
    return { provider: "gemini", model, gemini: baseUrl ? { baseUrl } : undefined };
  }
  if (provider === "local") {
    return { provider: "local", local: model ? { modelPath: model } : undefined };
  }
  throw new Error(`Unknown embedding provider: '${provider}'. Use none|openai|gemini|local.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const k = args.k ? Number(args.k) : 10;
  const embedding = parseEmbedding(args.embedding as string, args["base-url"] as string | undefined);
  let configs = args["bm25-only"] ? BM25_CONFIGS : P0_CONFIGS;
  // The Jaccard baseline is O(queries * docs * |query|); skip it on large
  // corpora with long queries (e.g. ArguAna) where it dominates runtime.
  if (args["no-jaccard"]) configs = configs.filter((c) => c.kind !== "jaccard");
  const reference = (args.reference as string) ?? "jaccard";

  let dataset: BeirDataset;
  if (args.fixture) {
    const dir = args.fixture as string;
    dataset = { name: path.basename(dir), ...(await parseBeirDir(dir)) };
  } else if (args.dataset) {
    dataset = await loadBeirDataset(args.dataset as BeirDatasetName);
  } else {
    throw new Error("Provide --dataset <scifact|nfcorpus|arguana> or --fixture <dir>.");
  }

  const { results, skipped } = await runMatrix(dataset, {
    embedding,
    configs,
    k,
    log: (m) => process.stderr.write(`[eval] ${m}\n`),
  });

  const md = formatMarkdown(results, { k, reference });
  if (args.out) await fs.writeFile(args.out as string, md + "\n");
  else process.stdout.write(md + "\n");
  if (args.json) await fs.writeFile(args.json as string, toJSON(results) + "\n");

  if (skipped.length > 0) {
    process.stderr.write(
      `[eval] skipped ${skipped.length} config(s): ` +
        skipped.map((s) => `${s.name} (${s.reason})`).join("; ") +
        "\n",
    );
  }
}

main().catch((err) => {
  process.stderr.write(`[eval] error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
