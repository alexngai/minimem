/**
 * Structural retrieval on minimem's OWN graph — the machinery the cogcore-live arm
 * bypasses (it writes to cognitive-core's KnowledgeBank without links and retrieves flat).
 *
 * Stage 0 (traverse=false): observations as typed knowledge notes; retrieve via minimem
 *   hybrid search (RRF) — the parity substrate.
 * Stage 1 (traverse=true): add entity-hub + temporal edges (KnowledgeLink) at ingestion;
 *   retrieve by seed-then-traverse (hybrid seed → getGraphNeighbors expansion → merge).
 *
 * See scratchpad/structural-retrieval-design.md.
 */
import fs from "node:fs/promises";
import path from "node:path";
import {
  Minimem,
  serializeFrontmatter,
  type MemoryFrontmatter,
  type KnowledgeLink,
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

export interface MinimemGraphOptions {
  /** Directory to hold the notes + SQLite index for this conversation (wiped on build). */
  memoryDir: string;
  instanceId: string;
  embedding: MinimemConfig["embedding"];
  topK?: number;
  /** Stage 1: build entity/temporal edges and retrieve by seed-then-traverse. */
  traverse?: boolean;
  /** Max notes returned by seed-then-traverse (default 2x topK). */
  maxContext?: number;
  /** Synthesized hierarchical summaries, written as retrievable domain-summary nodes. */
  summaries?: SummaryNote[];
}

export interface SummaryNote {
  topic: string;
  summary: string;
  entities: string[];
}

export interface GraphExcerpt {
  ref: string;
  text: string;
  score: number;
  via?: "seed" | "graph";
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

function entitySlug(entity: string): string {
  return `e-${entity.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)}`;
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
 * Write observations as minimem knowledge notes. Stage 1 (traverse) also writes entity-hub
 * notes and links: obs -[mentions/entity]-> entity-hub, and a temporal chain obs -[before/temporal]-> next-by-date.
 */
async function writeGraphNotes(
  memoryDir: string,
  instanceId: string,
  observations: GraphObservation[],
  traverse: boolean,
  summaries: SummaryNote[] = [],
): Promise<NoteMeta[]> {
  const notesDir = path.join(memoryDir, "memory");
  await fs.mkdir(notesDir, { recursive: true });
  await fs.writeFile(path.join(memoryDir, "MEMORY.md"), `# Memory\n\nKnowledge notes for ${instanceId}.\n`, "utf8");

  const metas: NoteMeta[] = observations.map((obs, i) => ({
    id: `o-${String(i).padStart(6, "0")}`,
    body: noteBody(obs),
    date: obs.date,
    epoch: parseDate(obs.date),
    entities: obs.entities ?? [],
  }));

  // Temporal chain: link each observation to the next one by date.
  const temporalNext = new Map<string, string>();
  if (traverse) {
    const dated = metas.filter((m) => m.epoch !== null).sort((a, b) => a.epoch! - b.epoch!);
    for (let i = 0; i + 1 < dated.length; i++) temporalNext.set(dated[i].id, dated[i + 1].id);
  }

  // Entity hubs (Stage 1): one note per distinct entity; observations link to their hubs.
  const entitySet = new Set<string>();
  if (traverse) for (const m of metas) for (const e of m.entities) entitySet.add(e);

  for (const meta of metas) {
    const links: KnowledgeLink[] = [];
    if (traverse) {
      for (const e of meta.entities) links.push({ target: entitySlug(e), relation: "mentions", layer: "entity" });
      const next = temporalNext.get(meta.id);
      if (next) links.push({ target: next, relation: "before", layer: "temporal" });
    }
    const fm: MemoryFrontmatter = {
      id: meta.id,
      type: "observation",
      domain: [instanceId],
      entities: meta.entities,
      confidence: 0.82,
      ...(meta.date ? { created: meta.date } : {}),
      ...(links.length ? { links } : {}),
    };
    await fs.writeFile(path.join(notesDir, `${meta.id}.md`), `${serializeFrontmatter(fm)}\n\n${meta.body}\n`, "utf8");
  }

  if (traverse) {
    for (const e of entitySet) {
      const id = entitySlug(e);
      const fm: MemoryFrontmatter = { id, type: "entity", domain: [instanceId], entities: [e] };
      await fs.writeFile(path.join(notesDir, `${id}.md`), `${serializeFrontmatter(fm)}\n\nEntity: ${e}\n`, "utf8");
    }
  }

  // Synthesized summary nodes (bet #2): retrievable domain-summary notes.
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
    const metas = await writeGraphNotes(opts.memoryDir, opts.instanceId, observations, opts.traverse ?? false, opts.summaries ?? []);
    const mm = await Minimem.create({
      memoryDir: opts.memoryDir,
      embedding: opts.embedding,
      watch: { enabled: false },
      query: { maxResults: opts.topK ?? 16, minScore: 0 },
    });
    await mm.sync({ force: true });
    return new MinimemGraphStore(mm, opts, metas);
  }

  /** Stage 0: hybrid seed only. Stage 1 (traverse): seed → graph-neighbor expansion → merge. */
  async retrieve(query: string, k?: number): Promise<GraphExcerpt[]> {
    const topK = k ?? this.opts.topK ?? 16;
    // Over-fetch so we can drop entity-hub hits and still fill topK observation seeds.
    const raw = await this.mm.search(query, { maxResults: topK * 2, minScore: 0, skipStaleCheck: true });
    // Keep observation (o-) and summary (s-) nodes as seeds; drop entity-hub (e-) nodes.
    const seeds = raw.filter((r) => !path.basename(r.path, ".md").startsWith("e-")).slice(0, topK);
    // Use our own clean note bodies (minimem chunks long frontmatter, leaking YAML into snippets).
    const bodyOf = (id: string, fallback: string) => this.byId.get(id)?.body ?? stripFrontmatter(fallback);
    const seedExcerpts: GraphExcerpt[] = seeds.map((r) => {
      const id = path.basename(r.path, ".md");
      const meta = this.byId.get(id);
      return { ref: `minimem:${id}`, text: bodyOf(id, r.snippet), score: r.score, via: "seed" as const, date: meta?.date, epoch: meta?.epoch ?? null };
    });
    if (!this.opts.traverse) return seedExcerpts;

    // Seed-then-traverse: expand each seed observation via entity/temporal edges (depth 2).
    const seen = new Set(seeds.map((r) => path.basename(r.path, ".md")));
    const out: GraphExcerpt[] = [...seedExcerpts];
    const maxContext = this.opts.maxContext ?? topK * 2;
    for (const r of seeds) {
      if (out.length >= maxContext) break;
      const seedId = path.basename(r.path, ".md");
      const neighbors = this.mm.getGraphNeighbors(seedId, 2);
      for (const n of neighbors) {
        if (out.length >= maxContext) break;
        if (seen.has(n.id) || !n.id.startsWith("o-")) continue; // skip entity hubs + dups
        const meta = this.byId.get(n.id);
        if (!meta) continue;
        seen.add(n.id);
        out.push({ ref: `minimem:${n.id}`, text: meta.body, score: r.score * 0.5, via: "graph", date: meta.date, epoch: meta.epoch });
      }
    }
    return out.slice(0, maxContext);
  }

  /**
   * Query decomposition: retrieve for each sub-query independently (seed-then-traverse),
   * then union the results deduped by note, keeping the best score, relevance-ordered.
   * Gives multi-part / multi-hop questions the evidence a single query misses.
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
