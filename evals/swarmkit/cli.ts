/**
 * Retrieval eval CLI — minimem's PRIMARY eval entrypoint, on swarmkit-eval.
 *
 *   npx tsx evals/swarmkit/cli.ts --fixture evals/datasets/__fixtures__/mini --bm25-only
 *   npx tsx evals/swarmkit/cli.ts --dataset scifact --bm25-only --out scifact.md
 *   npx tsx evals/swarmkit/cli.ts --dataset arguana --embedding local --base-url $TEI_URL --ks 1,5,10,20
 *
 * Gating (CI): --gate <baseline.json> fails (exit 1) if any arm's nDCG@10 drops beyond tolerance;
 * --update-baseline <baseline.json> writes a fresh committed baseline from the run.
 *
 * Resume: results are content-addressed in --store (default .eval-cache/swarmkit-<dataset>), so re-running
 * the same command skips already-scored query-cells across runs. (Vector index rebuilds per run until a
 * ResourceCache is wired — BM25/Jaccard need no embeddings, so the free CI path is unaffected.)
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  runEval,
  InProcessBackend,
  LocalResultStore,
  buildReport,
  renderMarkdownReport,
  checkGate,
  buildGateBaseline,
  type EvalConfig,
  type Baseline,
} from "swarmkit-eval";
import type { MinimemConfig } from "../../src/index.js";
import type { BeirDataset } from "../datasets/types.js";
import { loadBeirDataset, parseBeirDir, type BeirDatasetName } from "../datasets/beir.js";
import { MINIMEM_CONFIGS, needsVector, configArms, beirBenchmark, rankingAdapter } from "./beir-swarmkit.js";

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else {
      out[a.slice(2)] = next;
      i++;
    }
  }
  return out;
}

function parseEmbedding(spec: string | undefined, baseUrl?: string): MinimemConfig["embedding"] {
  const s = (spec ?? "none").trim();
  if (s === "none") return { provider: "none" };
  const colon = s.indexOf(":");
  const provider = colon === -1 ? s : s.slice(0, colon);
  const model = colon === -1 ? undefined : s.slice(colon + 1);
  if (provider === "openai") return { provider: "openai", model, openai: baseUrl ? { baseUrl } : undefined };
  if (provider === "gemini") return { provider: "gemini", model, gemini: baseUrl ? { baseUrl } : undefined };
  if (provider === "local") return { provider: "local", local: model ? { modelPath: model } : undefined };
  throw new Error(`Unknown embedding provider: '${provider}'. Use none|openai|gemini|local.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const k = args.k ? Number(args.k) : 10;
  const ks = args.ks ? String(args.ks).split(",").map(Number) : [k];
  const embedding = parseEmbedding(args.embedding as string, args["base-url"] as string | undefined);

  let configs = MINIMEM_CONFIGS;
  if (args["bm25-only"]) configs = configs.filter((c) => !needsVector(c));
  if (args["no-jaccard"]) configs = configs.filter((c) => c.kind !== "jaccard");

  let dataset: BeirDataset;
  if (args.fixture) {
    const dir = args.fixture as string;
    dataset = { name: path.basename(dir), ...(await parseBeirDir(dir)) };
  } else if (args.dataset) {
    dataset = await loadBeirDataset(args.dataset as BeirDatasetName);
  } else {
    throw new Error("Provide --dataset <scifact|nfcorpus|arguana> or --fixture <dir>.");
  }

  const storeDir = (args.store as string) || path.join(".eval-cache", `swarmkit-${dataset.name}`);
  const benchmark = beirBenchmark(dataset, configs, { embedding, k, ks });
  const config: EvalConfig = {
    runId: `beir-${dataset.name}`,
    configVersion: "v0",
    benchmark: benchmark.id,
    arms: configArms(configs),
    models: [{ name: embedding.provider }], // retrieval has no LLM; the embedding provider labels the run
    seeds: [1],
    backend: "in-process",
    concurrency: { cells: 8, modelConnections: 1, resources: 2 },
    retry: { maxAttempts: 1, baseDelayMs: 0 },
    output: { dir: storeDir, trace: false },
  };

  const log = (m: string) => process.stderr.write(`[eval] ${m}\n`);
  log(`${dataset.name}: ${configs.length} arm(s), embedding=${embedding.provider}`);
  const results = await runEval(config, {
    benchmark,
    backend: new InProcessBackend(),
    store: new LocalResultStore(storeDir),
    adapter: rankingAdapter(),
  });

  const report = buildReport(results, config, { baselineArmId: "jaccard", accuracyMetric: "sPartial" });
  const md = renderMarkdownReport(report);
  if (args.out) await fs.writeFile(args.out as string, md + "\n");
  else process.stdout.write(md + "\n");
  if (args.json) await fs.writeFile(args.json as string, JSON.stringify(report, null, 2) + "\n");

  if (args["update-baseline"]) {
    const base = buildGateBaseline(report.aggregates, [`ndcg@${k}`], {
      label: `${dataset.name}-bm25`,
      publishedAt: (args["as-of"] as string) || "manual",
    });
    await fs.writeFile(args["update-baseline"] as string, JSON.stringify(base, null, 2) + "\n");
    log(`wrote baseline → ${args["update-baseline"]}`);
  }

  if (args.gate) {
    const baseline = JSON.parse(await fs.readFile(args.gate as string, "utf-8")) as Baseline;
    const tolerance = args.tolerance ? Number(args.tolerance) : 0.02;
    const res = checkGate(report.aggregates, baseline, {
      baseline: String(args.gate),
      thresholds: [{ metric: `ndcg@${k}`, direction: "not-decrease", tolerance }],
    });
    if (!res.passed) {
      for (const v of res.violations) {
        log(`REGRESSION ${v.metric}: ${v.actual.toFixed(4)} < baseline ${(v.baseline ?? 0).toFixed(4)} - ${tolerance}`);
      }
      process.exit(1);
    }
    log(`gate passed (nDCG@${k} not-decrease, tol ${tolerance}) vs ${args.gate}`);
  }
}

main().catch((err) => {
  process.stderr.write(`[eval] error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
