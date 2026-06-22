/**
 * Persistent {@link ResourceCache} for the BEIR ranking resource (swarmkit-eval D15c).
 *
 * swarmkit-eval owns the cache KEY (`ResourceSpec.cacheKey`) and the hash-fold; the CLIENT owns
 * storage. We persist each arm's *rankings* — the output of the expensive materialize + embed + index
 * + run-all-queries build — so a cache hit skips that whole rebuild on a re-run (the vector arms in
 * particular re-embed otherwise). The cached `value` is `{ rankings: Map<queryId, RankedDoc[]> }`,
 * which serializes cleanly to JSON.
 *
 * Note: the cache key (see beir-swarmkit.ts) folds dataset + corpus size + arm + embedding
 * provider/model, NOT minimem's chunking/scoring code version — so clear the cache dir after changing
 * retrieval code that would alter rankings.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { ResourceCache, ResourceHandle } from "swarmkit-eval";
import type { RankedDoc } from "../harness/run.js";

interface RankingValue {
  rankings: Map<string, RankedDoc[]>;
}

export class LocalRankingCache implements ResourceCache {
  constructor(private readonly dir: string) {}

  /** Stable, filesystem-safe filename for an arbitrary cache key. */
  private file(key: string): string {
    const safe = createHash("sha256").update(key).digest("hex").slice(0, 32);
    return path.join(this.dir, `rankings-${safe}.json`);
  }

  async load(key: string): Promise<ResourceHandle | null> {
    try {
      const raw = await fs.readFile(this.file(key), "utf-8");
      const parsed = JSON.parse(raw) as { key: string; rankings: Array<[string, RankedDoc[]]> };
      const rankings = new Map(parsed.rankings);
      return { value: { rankings } satisfies RankingValue, async stop() {} };
    } catch {
      return null; // miss (absent or unreadable) → caller rebuilds
    }
  }

  async save(key: string, handle: ResourceHandle): Promise<void> {
    const value = handle.value as RankingValue | undefined;
    if (!value?.rankings) return; // only the rankings resource is cacheable
    await fs.mkdir(this.dir, { recursive: true });
    const payload = { key, rankings: [...value.rankings.entries()] };
    await fs.writeFile(this.file(key), JSON.stringify(payload));
  }
}
