/**
 * Retrieval-recall diagnostic (no answer/judge LLM — deterministic & cheap).
 *
 * Attributes cogcore misses to retrieval vs extraction vs answer by measuring,
 * per question, whether the GOLD EVIDENCE turns are actually retrieved:
 *
 * - cogcore-retrieval (raw turns): turn-level recall@k — is the exact evidence
 *   diaId (e.g. D8:4) among the retrieved notes?
 * - cogcore-memory (extracted facts): session-level recall@k — is a fact from
 *   the evidence turn's SESSION among the retrieved facts? (Facts lose per-turn
 *   provenance, so session is the finest resolvable unit.) Plus extraction
 *   coverage: does the evidence session produce ANY fact at all?
 *
 * Cross-tabbed with per-question correctness from a prior trace-*.json:
 *   retrieved✓ + wrong  → extraction/answer problem
 *   retrieved✗ + wrong  → retrieval problem
 *
 *   npx tsx evals/locomo/recall-diag.ts --conversations 1 --questions 24 \
 *     --trace evals/locomo/results/trace-030.json --out evals/locomo/results/recall-diag
 */

import fs from "node:fs/promises";
import path from "node:path";

import { createObservation } from "cognitive-core";

import { loadLocomo } from "./dataset.js";
import {
  closeBank,
  defaultScratchRoot,
  indexAndInject,
  openBank,
  type CogcoreState,
  type Embeddings,
} from "./adapters/cogcore-shared.js";
import type { LocomoConversation, LocomoQuestion } from "./types.js";

const K_VALUES = [5, 10, 16, 50];
const MAX_TOKENS = 1_000_000;

interface Args {
  conversations: number;
  questions: number;
  seed: number;
  embeddings: Embeddings;
  trace?: string;
  out: string;
}

function parseArgs(argv: string[]): Args {
  const get = (f: string): string | undefined => {
    const i = argv.indexOf(f);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    conversations: Number(get("--conversations") ?? 1),
    questions: Number(get("--questions") ?? 24),
    seed: Number(get("--seed") ?? 1),
    embeddings: (get("--embeddings") ?? "local") as Embeddings,
    trace: get("--trace"),
    out: get("--out") ?? "evals/locomo/results/recall-diag",
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Same stratified sampler as trace.ts, so question sets line up for the join. */
function sampleQuestions(questions: LocomoQuestion[], limit: number, seed: number): LocomoQuestion[] {
  const pool = questions.filter((q) => !q.isAdversarial);
  if (limit <= 0 || pool.length <= limit) return pool;
  const rand = mulberry32(seed);
  const byCat = new Map<string, LocomoQuestion[]>();
  for (const q of pool) {
    const arr = byCat.get(q.category) ?? [];
    arr.push(q);
    byCat.set(q.category, arr);
  }
  for (const arr of byCat.values()) arr.sort(() => rand() - 0.5);
  const cats = [...byCat.keys()].sort();
  const out: LocomoQuestion[] = [];
  let idx = 0;
  while (out.length < limit) {
    const cat = cats[idx % cats.length];
    const arr = byCat.get(cat)!;
    if (arr.length) out.push(arr.shift()!);
    idx++;
    if (cats.every((c) => byCat.get(c)!.length === 0)) break;
  }
  return out;
}

interface ExtractedFact {
  fact: string;
  entities: string[];
}
interface ExtractionCache {
  version: number;
  sampleId: string;
  sessions: Record<number, ExtractedFact[]>;
}

async function buildRetrievalStore(
  conv: LocomoConversation,
  embeddings: Embeddings,
): Promise<CogcoreState> {
  const state = await openBank(defaultScratchRoot(), "diag-ccr-");
  let n = 0;
  for (const session of conv.sessions) {
    for (const turn of session.turns) {
      const when = session.dateTime ? `[${session.dateTime}] ` : "";
      const img = turn.imageCaption ? ` [shared image: ${turn.imageCaption}]` : "";
      await state.kb.addObservation(
        createObservation({
          id: `k-${String(n).padStart(5, "0")}`,
          title: turn.diaId,
          body: `${when}${turn.speaker}: ${turn.text}${img}`,
          domain: [conv.sampleId],
          entities: [],
          tags: [`session-${session.index}`],
          confidence: 0.8,
          source: { origin: "imported" },
        }),
      );
      n++;
    }
  }
  await indexAndInject(state, embeddings, Math.max(...K_VALUES));
  return state;
}

async function buildMemoryStore(
  conv: LocomoConversation,
  embeddings: Embeddings,
): Promise<CogcoreState> {
  const cachePath = path.resolve(
    "evals/locomo/.cache/cogcore-extractions",
    `${conv.sampleId}.json`,
  );
  const cache = JSON.parse(await fs.readFile(cachePath, "utf-8")) as ExtractionCache;
  const state = await openBank(defaultScratchRoot(), "diag-ccm-");
  let n = 0;
  for (const session of conv.sessions) {
    const facts = cache.sessions[session.index] ?? [];
    const when = session.dateTime ? `[${session.dateTime}] ` : "";
    for (const f of facts) {
      await state.kb.addObservation(
        createObservation({
          id: `k-${String(n).padStart(5, "0")}`,
          title: `session-${session.index}`,
          body: `${when}${f.fact}`,
          domain: [conv.sampleId],
          entities: f.entities,
          tags: [`session-${session.index}`],
          confidence: 0.8,
          source: { origin: "extracted" },
        }),
      );
      n++;
    }
  }
  await state.kb.defragment();
  await indexAndInject(state, embeddings, Math.max(...K_VALUES));
  return state;
}

/** session index -> #facts extracted (0 = extraction dropped the whole session). */
function factCountsBySession(cache: ExtractionCache): Map<number, number> {
  const m = new Map<number, number>();
  for (const [idx, facts] of Object.entries(cache.sessions)) m.set(Number(idx), facts.length);
  return m;
}

function sessionOfDiaId(diaId: string): number | null {
  const m = /^D(\d+):/i.exec(diaId);
  return m ? Number(m[1]) : null;
}

async function retrievedNotes(
  state: CogcoreState,
  question: string,
  k: number,
): Promise<Array<{ diaId: string | null; session: number | null }>> {
  const matches = await state.kb.getRelevantKnowledge(
    { description: question },
    { maxNotes: k, maxTokens: MAX_TOKENS },
  );
  return matches.map((m) => {
    const body = m.note.body ?? "";
    const dm = /^#\s*(D\d+:\d+)/i.exec(body.trim());
    const tag = m.note.frontmatter.tags.find((t) => t.startsWith("session-"));
    return {
      diaId: dm ? dm[1] : null,
      session: tag ? Number(tag.slice("session-".length)) : null,
    };
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const conversations = (await loadLocomo()).slice(0, args.conversations);

  // Optional per-question correctness from a prior trace run: {questionId: {sys: correct}}.
  let correctness: Record<string, Record<string, boolean>> = {};
  if (args.trace) {
    try {
      const t = JSON.parse(await fs.readFile(path.resolve(args.trace), "utf-8")) as {
        questions: Array<{ questionId: string; bySystem: Record<string, { correct: boolean }> }>;
      };
      for (const q of t.questions) {
        correctness[q.questionId] = {};
        for (const [sys, v] of Object.entries(q.bySystem)) correctness[q.questionId][sys] = v.correct;
      }
    } catch {
      console.error(`[diag] could not read trace ${args.trace}; correctness join skipped`);
    }
  }

  type Cell = { hit: number; tot: number };
  const mkK = (): Record<number, Cell> =>
    Object.fromEntries(K_VALUES.map((k) => [k, { hit: 0, tot: 0 }])) as Record<number, Cell>;
  type RecallSet = { ccrTurn: Record<number, Cell>; ccrSession: Record<number, Cell>; ccmSession: Record<number, Cell> };
  const mkSet = (): RecallSet => ({ ccrTurn: mkK(), ccrSession: mkK(), ccmSession: mkK() });

  const agg = {
    ...mkSet(),
    /** Same recall counters, split by question category. */
    byCat: {} as Record<string, RecallSet>,
    extractionCoverage: { hit: 0, tot: 0 },
    // 2x2 at k=10, using the trace correctness if available.
    ccm: { retOK_ans: [0, 0], retMISS_ans: [0, 0] }, // [wrong, right]
    ccr: { retOK_ans: [0, 0], retMISS_ans: [0, 0] },
  };
  const catSet = (cat: string): RecallSet => (agg.byCat[cat] ??= mkSet());
  const lines: string[] = [];

  // Per-conversation checkpoint so a machine sleep / kill never loses the whole
  // run (each conversation's stores take minutes to build). Resume skips convs
  // already accumulated into the checkpoint.
  const ckptPath = `${path.resolve(args.out)}.ckpt.json`;
  const doneConvs = new Set<string>();
  try {
    const ck = JSON.parse(await fs.readFile(ckptPath, "utf-8")) as { agg: typeof agg; done: string[] };
    Object.assign(agg, ck.agg);
    for (const c of ck.done) doneConvs.add(c);
    if (doneConvs.size) console.error(`[diag] resume: ${doneConvs.size} conversations already done`);
  } catch {
    // No checkpoint — fresh run.
  }

  for (const conv of conversations) {
    if (doneConvs.has(conv.sampleId)) continue;
    const cachePath = path.resolve("evals/locomo/.cache/cogcore-extractions", `${conv.sampleId}.json`);
    const cache = JSON.parse(await fs.readFile(cachePath, "utf-8")) as ExtractionCache;
    const factsBySession = factCountsBySession(cache);

    const questions = sampleQuestions(conv.questions, args.questions, args.seed).filter(
      (q) => q.evidence.length > 0,
    );

    console.error(`[diag] ${conv.sampleId}: building stores...`);
    const ccr = await buildRetrievalStore(conv, args.embeddings);
    const ccm = await buildMemoryStore(conv, args.embeddings);

    console.error(`[diag] ${conv.sampleId}: scoring ${questions.length} questions...`);
    for (const q of questions) {
      const goldSessions = new Set(
        q.evidence.map(sessionOfDiaId).filter((s): s is number => s !== null),
      );
      const goldTurns = new Set(q.evidence);

      // Extraction coverage: did the evidence session(s) produce any facts?
      for (const s of goldSessions) {
        agg.extractionCoverage.tot++;
        if ((factsBySession.get(s) ?? 0) > 0) agg.extractionCoverage.hit++;
      }

      for (const k of K_VALUES) {
        const rNotes = await retrievedNotes(ccr, q.question, k);
        const rTurns = new Set(rNotes.map((n) => n.diaId).filter(Boolean) as string[]);
        const rSessR = new Set(rNotes.map((n) => n.session).filter((s): s is number => s !== null));
        const mNotes = await retrievedNotes(ccm, q.question, k);
        const rSessM = new Set(mNotes.map((n) => n.session).filter((s): s is number => s !== null));

        const ccrTurnHit = [...goldTurns].some((t) => rTurns.has(t));
        const ccrSessHit = [...goldSessions].some((s) => rSessR.has(s));
        const ccmSessHit = [...goldSessions].some((s) => rSessM.has(s));

        const cat = catSet(q.category);
        agg.ccrTurn[k].tot++; cat.ccrTurn[k].tot++; if (ccrTurnHit) { agg.ccrTurn[k].hit++; cat.ccrTurn[k].hit++; }
        agg.ccrSession[k].tot++; cat.ccrSession[k].tot++; if (ccrSessHit) { agg.ccrSession[k].hit++; cat.ccrSession[k].hit++; }
        agg.ccmSession[k].tot++; cat.ccmSession[k].tot++; if (ccmSessHit) { agg.ccmSession[k].hit++; cat.ccmSession[k].hit++; }

        if (k === 10) {
          const c = correctness[q.id];
          if (c) {
            const ccmRight = c["cogcore-memory"] ? 1 : 0;
            (ccmSessHit ? agg.ccm.retOK_ans : agg.ccm.retMISS_ans)[ccmRight]++;
            const ccrRight = c["cogcore-retrieval"] ? 1 : 0;
            (ccrTurnHit ? agg.ccr.retOK_ans : agg.ccr.retMISS_ans)[ccrRight]++;
          }
        }
      }
    }
    await closeBank(ccr);
    await closeBank(ccm);

    doneConvs.add(conv.sampleId);
    await fs.mkdir(path.dirname(ckptPath), { recursive: true });
    await fs.writeFile(ckptPath, JSON.stringify({ agg, done: [...doneConvs] }), "utf-8");
    console.error(`[diag] checkpointed after ${conv.sampleId} (${doneConvs.size} done)`);
  }

  const pct = (h: number, t: number): string => (t ? `${((100 * h) / t).toFixed(1)}% (${h}/${t})` : "n/a");
  lines.push("# LOCOMO retrieval-recall diagnostic\n");
  lines.push(`conversations=${conversations.length} · embeddings=${args.embeddings} · seed=${args.seed}\n`);
  lines.push("## Recall of gold evidence (does retrieval surface the evidence?)\n");
  lines.push("| k | ccr turn-recall | ccr session-recall | ccm session-recall |");
  lines.push("|---|---|---|---|");
  for (const k of K_VALUES) {
    lines.push(`| ${k} | ${pct(agg.ccrTurn[k].hit, agg.ccrTurn[k].tot)} | ${pct(agg.ccrSession[k].hit, agg.ccrSession[k].tot)} | ${pct(agg.ccmSession[k].hit, agg.ccmSession[k].tot)} |`);
  }
  lines.push(`\n**Extraction coverage** (evidence sessions with ≥1 extracted fact): ${pct(agg.extractionCoverage.hit, agg.extractionCoverage.tot)}`);

  // Per-category recall — the signal for whether a weak category is retrieval-bound.
  const cats = Object.keys(agg.byCat).sort();
  for (const [label, pick] of [
    ["ccr turn-recall", (s: RecallSet) => s.ccrTurn],
    ["ccm session-recall", (s: RecallSet) => s.ccmSession],
  ] as const) {
    lines.push(`\n### ${label} by category (does more k surface the evidence?)\n`);
    lines.push(`| category | ${K_VALUES.map((k) => `k=${k}`).join(" | ")} |`);
    lines.push(`|---|${K_VALUES.map(() => "---").join("|")}|`);
    for (const cat of cats) {
      const cells = pick(agg.byCat[cat]);
      lines.push(`| ${cat} | ${K_VALUES.map((k) => pct(cells[k].hit, cells[k].tot)).join(" | ")} |`);
    }
  }
  lines.push("\n## Attribution @k=10 (retrieval hit × answer correctness)\n");
  lines.push("| arm | retrieved✓ & wrong | retrieved✓ & right | retrieved✗ & wrong | retrieved✗ & right |");
  lines.push("|---|---|---|---|---|");
  lines.push(`| cogcore-memory | ${agg.ccm.retOK_ans[0]} | ${agg.ccm.retOK_ans[1]} | ${agg.ccm.retMISS_ans[0]} | ${agg.ccm.retMISS_ans[1]} |`);
  lines.push(`| cogcore-retrieval | ${agg.ccr.retOK_ans[0]} | ${agg.ccr.retOK_ans[1]} | ${agg.ccr.retMISS_ans[0]} | ${agg.ccr.retMISS_ans[1]} |`);
  lines.push("\n- retrieved✓ & wrong → extraction/answer-side loss (evidence present but not used).");
  lines.push("- retrieved✗ & wrong → retrieval loss (evidence never surfaced).");

  const md = lines.join("\n");
  const outBase = path.resolve(args.out);
  await fs.mkdir(path.dirname(outBase), { recursive: true });
  await fs.writeFile(`${outBase}.md`, md, "utf-8");
  await fs.writeFile(`${outBase}.json`, JSON.stringify(agg, null, 2), "utf-8");
  console.error(`\nWrote ${outBase}.md`);
  console.log(md);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
