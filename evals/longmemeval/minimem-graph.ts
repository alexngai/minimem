/**
 * Structural retrieval on minimem's OWN graph — using the PRODUCT graph feature so the
 * eval exercises the SHIPPED code path, not a bespoke reimplementation:
 *   - ingestion: MinimemConfig.graph.autoEntityLinks derives co-entity edges at sync time
 *     from the `entities` frontmatter (no hand-built hub nodes / links).
 *   - retrieval: search(query, { graphExpand }) does seed-then-traverse over knowledge_links.
 *
 * Stage 0 (traverse=false): hybrid seed only (graphExpand=0).
 * Stage 1 (traverse=true): seed-then-traverse over the auto-derived co-entity graph.
 *
 * Public interface (build / retrieve / retrieveMany / close) is unchanged so the adapter
 * and ablation flags keep working. See evals/beam/RESULTS.md.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  Minimem,
  serializeFrontmatter,
  type MemoryFrontmatter,
  type MinimemConfig,
} from "../../src/index.js";

export interface GraphObservation {
  statement: string;
  type?: string;
  date?: string;
  status?: string;
  entities: string[];
  turnIds?: string[];
}

export interface SummaryNote {
  topic: string;
  summary: string;
  entities: string[];
}

export interface MinimemGraphOptions {
  /** Directory to hold the notes + SQLite index for this conversation (wiped on build). */
  memoryDir: string;
  instanceId: string;
  embedding: MinimemConfig["embedding"];
  topK?: number;
  /** Stage 1: build co-entity edges (autoEntityLinks) and retrieve by seed-then-traverse (graphExpand). */
  traverse?: boolean;
  /** graphExpand traversal depth over the co-entity graph (default 1 = direct co-entity notes). */
  graphExpandDepth?: number;
  /** Max notes returned by retrieveMany (default 2x topK). */
  maxContext?: number;
  /** Synthesized hierarchical summaries, written as retrievable domain-summary nodes. */
  summaries?: SummaryNote[];
  /** Post-fusion selection (diversity / supersede / recency / quotas). Defaults to off. */
  retrieval?: MinimemConfig["retrieval"];
}

export interface GraphExcerpt {
  ref: string;
  text: string;
  score: number;
  date?: string;
  epoch?: number | null;
}

interface NoteMeta {
  id: string;
  body: string;
  date?: string;
  epoch: number | null;
  entities: string[];
}

/** Remove a leading YAML frontmatter block (minimem's snippet includes it). */
function stripFrontmatter(text: string): string {
  return text.replace(/^\s*---[\s\S]*?---\s*/, "").trim();
}

function parseDate(s?: string): number | null {
  if (!s) return null;
  const m = s.match(/(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})/);
  if (m) return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

function noteBody(obs: GraphObservation): string {
  return [
    obs.date ? `Date: ${obs.date}` : "",
    obs.type ? `Type: ${obs.type}` : "",
    obs.status ? `Status: ${obs.status}` : "",
    obs.statement,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Write observations (and any synthesized summaries) as minimem knowledge notes with
 * `entities` frontmatter. Edges are NOT written here — the product's autoEntityLinks
 * derives co-entity edges from the entities column at sync time.
 */
async function writeNotes(
  memoryDir: string,
  instanceId: string,
  observations: GraphObservation[],
  summaries: SummaryNote[],
): Promise<NoteMeta[]> {
  const notesDir = path.join(memoryDir, "memory");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, "MEMORY.md"), `# Memory\n\nKnowledge notes for ${instanceId}.\n`, "utf8");

  const metas: NoteMeta[] = [];

  for (let i = 0; i < observations.length; i++) {
    const obs = observations[i];
    const id = `o-${String(i).padStart(6, "0")}`;
    const entities = obs.entities ?? [];
    const fm: MemoryFrontmatter = {
      id,
      type: "observation",
      domain: [instanceId],
      entities,
      confidence: 0.82,
      ...(obs.date ? { created: obs.date } : {}),
    };
    const body = noteBody(obs);
    await fs.writeFile(path.join(notesDir, `${id}.md`), `${serializeFrontmatter(fm)}\n\n${body}\n`, "utf8");
    metas.push({ id, body, date: obs.date, epoch: parseDate(obs.date), entities });
  }

  for (let i = 0; i < summaries.length; i++) {
    const s = summaries[i];
    const id = `s-${String(i).padStart(6, "0")}`;
    const body = `Summary of ${s.topic}:\n${s.summary}`;
    const fm: MemoryFrontmatter = {
      id,
      type: "domain-summary",
      domain: [instanceId],
      entities: s.entities ?? [],
      confidence: 0.85,
    };
    await fs.writeFile(path.join(notesDir, `${id}.md`), `${serializeFrontmatter(fm)}\n\n${body}\n`, "utf8");
    metas.push({ id, body, epoch: null, entities: s.entities ?? [] });
  }

  return metas;
}

export class MinimemGraphStore {
  private readonly byId = new Map<string, NoteMeta>();

  private constructor(
    private readonly mm: Minimem,
    private readonly opts: MinimemGraphOptions,
    metas: NoteMeta[],
  ) {
    for (const m of metas) this.byId.set(m.id, m);
  }

  static async build(observations: GraphObservation[], opts: MinimemGraphOptions): Promise<MinimemGraphStore> {
    await fs.rm(opts.memoryDir, { recursive: true, force: true });
    const metas = await writeNotes(opts.memoryDir, opts.instanceId, observations, opts.summaries ?? []);
    const mm = await Minimem.create({
      memoryDir: opts.memoryDir,
      embedding: opts.embedding,
      watch: { enabled: false },
      query: { maxResults: opts.topK ?? 16, minScore: 0 },
      // Product graph feature: build co-entity edges at sync when we intend to traverse.
      ...(opts.traverse ? { graph: { autoEntityLinks: true } } : {}),
      ...(opts.retrieval ? { retrieval: opts.retrieval } : {}),
    });
    await mm.sync({ force: true });
    return new MinimemGraphStore(mm, opts, metas);
  }

  private toExcerpt(r: { path: string; snippet: string; score: number }): GraphExcerpt {
    const id = path.basename(r.path, ".md");
    const meta = this.byId.get(id);
    return {
      ref: `minimem:${id}`,
      text: meta?.body ?? stripFrontmatter(r.snippet),
      score: r.score,
      date: meta?.date,
      epoch: meta?.epoch ?? null,
    };
  }

  /** Stage 0: hybrid seed only. Stage 1 (traverse): product seed-then-traverse via graphExpand. */
  async retrieve(query: string, k?: number): Promise<GraphExcerpt[]> {
    const topK = k ?? this.opts.topK ?? 16;
    const graphExpand = this.opts.traverse ? (this.opts.graphExpandDepth ?? 1) : 0;
    const results = await this.mm.search(query, {
      maxResults: topK,
      minScore: 0,
      skipStaleCheck: true,
      graphExpand,
    });
    return results.map((r) => this.toExcerpt(r));
  }

  /**
   * Query decomposition: retrieve for each sub-query independently, union deduped by note,
   * keeping the best score, relevance-ordered.
   */
  async retrieveMany(queries: string[], kPerQuery?: number, maxTotal?: number): Promise<GraphExcerpt[]> {
    const perQuery = kPerQuery ?? this.opts.topK ?? 16;
    const cap = maxTotal ?? this.opts.maxContext ?? perQuery * 2;
    const byRef = new Map<string, GraphExcerpt>();
    for (const q of queries) {
      if (!q.trim()) continue;
      for (const h of await this.retrieve(q, perQuery)) {
        const prev = byRef.get(h.ref);
        if (!prev || h.score > prev.score) byRef.set(h.ref, h);
      }
    }
    return [...byRef.values()].sort((a, b) => b.score - a.score).slice(0, cap);
  }

  async close(): Promise<void> {
    await this.mm.close();
  }
}
