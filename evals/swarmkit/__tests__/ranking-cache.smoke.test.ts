/**
 * LocalRankingCache: resource reuse across runs (swarmkit-eval D15c wiring).
 * node:test (run via `npm run eval:ci`) — the integration case exercises node:sqlite + sqlite-vec.
 *
 *   npx tsx --test evals/swarmkit/__tests__/ranking-cache.smoke.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  runEval,
  InProcessBackend,
  LocalResultStore,
  buildReport,
  type EvalConfig,
  type ResourceCache,
} from "swarmkit-eval";
import { parseBeirDir } from "../../datasets/beir.js";
import { MINIMEM_CONFIGS, needsVector, configArms, beirBenchmark, rankingAdapter } from "../beir-swarmkit.js";
import { LocalRankingCache } from "../ranking-cache.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "../../datasets/__fixtures__/mini");

describe("LocalRankingCache", () => {
  it("round-trips a rankings map; miss returns null", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "rc-unit-"));
    const cache = new LocalRankingCache(dir);

    assert.equal(await cache.load("missing"), null);

    const rankings = new Map([["q1", [{ docId: "d1", score: 0.9 }, { docId: "d2", score: 0.4 }]]]);
    await cache.save("k1", { value: { rankings }, async stop() {} });

    const got = await cache.load("k1");
    assert.ok(got, "hit after save");
    const v = got!.value as { rankings: Map<string, Array<{ docId: string; score: number }>> };
    assert.deepEqual(
      [...v.rankings.get("q1")!],
      [{ docId: "d1", score: 0.9 }, { docId: "d2", score: 0.4 }],
    );
  });

  it("serves resources from cache on the second run (skips rebuild), identical scores", async () => {
    const dataset = { name: "mini", ...(await parseBeirDir(FIXTURE)) };
    const configs = MINIMEM_CONFIGS.filter((c) => !needsVector(c)); // offline: jaccard + bm25
    const cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "rc-int-"));

    // Wrap LocalRankingCache to count cache hits (load returning a handle).
    const base = new LocalRankingCache(cacheDir);
    let hits = 0;
    const cache: ResourceCache = {
      async load(k) {
        const h = await base.load(k);
        if (h) hits++;
        return h;
      },
      save: (k, h) => base.save(k, h),
    };

    const run = async () => {
      const benchmark = beirBenchmark(dataset, configs, { k: 10 });
      const store = await fs.mkdtemp(path.join(os.tmpdir(), "rc-store-")); // fresh store → isolates the resource cache
      const config: EvalConfig = {
        runId: "mini",
        configVersion: "v0",
        benchmark: benchmark.id,
        arms: configArms(configs),
        models: [{ name: "none" }],
        seeds: [1],
        backend: "in-process",
        concurrency: { cells: 4, modelConnections: 1, resources: 2 },
        retry: { maxAttempts: 1, baseDelayMs: 0 },
        output: { dir: store, trace: false },
      };
      const results = await runEval(config, {
        benchmark,
        backend: new InProcessBackend(),
        store: new LocalResultStore(store),
        adapter: rankingAdapter(),
        resourceCache: cache,
      });
      return buildReport(results, config, { baselineArmId: "jaccard" });
    };

    const r1 = await run();
    assert.equal(hits, 0, "run 1 is all cache misses (cold)");

    const r2 = await run();
    assert.ok(hits >= configs.length, `run 2 served every arm from cache (hits=${hits}, arms=${configs.length})`);

    const ndcg = (rep: Awaited<ReturnType<typeof run>>, arm: string) =>
      rep.aggregates.find((a) => a.armId === arm)?.metrics?.["ndcg@10"]?.mean;
    for (const c of configs) {
      assert.equal(ndcg(r2, c.id), ndcg(r1, c.id), `${c.id}: cached scores match cold run`);
    }
  });
});
