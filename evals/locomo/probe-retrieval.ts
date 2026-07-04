/**
 * Retrieval probe — isolates the retrieval layer from the noisy answer/judge
 * pipeline. Reconstructs the cogcore-memory bank for one conversation (from the
 * deterministic extraction cache) and prints what different query strategies
 * surface for a target question, so we can A/B embeddings/keyword-expansion
 * mechanically (does the needed fact appear at all?) rather than via LLM score.
 *
 * Usage:
 *   npx tsx evals/locomo/probe-retrieval.ts --conv conv-26 \
 *     --q "pets' names" --embeddings nomic
 */
import { loadLocomo } from "./dataset.js";
import { LlmClient } from "./llm.js";
import { CogcoreMemoryAdapter } from "./adapters/cogcore-memory.js";
import type { Embeddings } from "./adapters/cogcore-shared.js";

function arg(flag: string, def?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main(): Promise<void> {
  const convId = arg("--conv", "conv-26")!;
  const qNeedle = arg("--q", "pets' names")!;
  const embeddings = (arg("--embeddings", "local") ?? "local") as Embeddings;
  const topK = Number(arg("--topk", "16"));
  const keyword = process.argv.includes("--keyword-expansion");

  const dataset = await loadLocomo();
  const conv = dataset.find((c) => c.sampleId === convId);
  if (!conv) throw new Error(`conv ${convId} not found`);
  const question = conv.questions.find((q) => q.question.includes(qNeedle));
  if (!question) throw new Error(`question matching "${qNeedle}" not found`);

  const llm = new LlmClient();
  const adapter = new CogcoreMemoryAdapter(llm, { topK, embeddings, keywordExpansion: keyword });
  process.stderr.write(`[probe] ingest ${convId} (${embeddings}${keyword ? "+kw" : ""})...\n`);
  await adapter.ingest(conv);

  // On-disk note-file audit FIRST (before any risky native teardown).
  {
    const st = (adapter as unknown as { state: { memoryDir: string } }).state;
    const { execSync } = await import("node:child_process");
    const files = execSync(`find "${st.memoryDir}" -name '*.md' | wc -l`).toString().trim();
    const lunaFiles = execSync(`grep -rl "named Luna" "${st.memoryDir}" || true`).toString().trim();
    console.log(`\non-disk: ${files} .md note files; files containing "named Luna": ${lunaFiles ? lunaFiles.split("\n").length : 0}`);
    if (lunaFiles) {
      const first = lunaFiles.split("\n")[0];
      console.log(`--- ${first} ---\n${execSync(`cat "${first}"`).toString().slice(0, 500)}\n`);
    }
  }

  // Reach into the adapter's state for a raw minimem probe.
  const state = (adapter as unknown as { state: { mm: { search: (q: string, o?: unknown) => Promise<Array<{ text: string; score: number }>> }; kb: { getRelevantKnowledge: (t: unknown, o: unknown) => Promise<Array<{ note: { body?: string }; matchType?: string; score: number }>> } } }).state;

  const isPet = (t: string) => /luna|oliver|bailey|\bpet\b|\bcat\b/i.test(t);
  const txt = (r: { snippet?: string; text?: string }) => r.snippet ?? r.text ?? "";

  console.log(`\n=== Q: ${question.question}\n    gold: ${question.gold}\n`);

  const rawQueries = [question.question, "Melanie pets cats dogs names Luna Oliver Bailey"];
  for (const rq of rawQueries) {
    const res = await state.mm.search(rq, { maxResults: topK, skipStaleCheck: true });
    const hits = res.filter((r) => isPet(txt(r))).length;
    console.log(`raw mm.search("${rq.slice(0, 50)}"): ${hits}/${res.length} pet-relevant`);
    res.filter((r) => isPet(txt(r))).slice(0, 3).forEach((r) => console.log(`    * ${txt(r).replace(/\n/g, " ").slice(0, 80)}`));
  }

  const matches = await state.kb.getRelevantKnowledge(
    { description: question.question },
    { maxNotes: topK, maxTokens: 1_000_000 },
  );
  const kbHits = matches.filter((m) => isPet(m.note.body ?? "")).length;
  console.log(`\nkb.getRelevantKnowledge: ${kbHits}/${matches.length} pet-relevant`);
  matches.slice(0, 5).forEach((m) => console.log(`    [${m.matchType ?? "?"}] ${(m.note.body ?? "").replace(/\n/g, " ").slice(0, 80)}`));

  // Direct index probe: raw results + counts for a few tokens.
  for (const tok of ["Luna", "pet", "Melanie", "Bailey"]) {
    const res = await state.mm.search(tok, { maxResults: 1000, skipStaleCheck: true });
    const withTok = res.filter((r) => new RegExp(tok, "i").test(txt(r))).length;
    console.log(`\nraw mm.search("${tok}"): ${res.length} results, ${withTok} snippets contain "${tok}"`);
    res.filter((r) => new RegExp(tok, "i").test(txt(r))).slice(0, 2).forEach((r, i) => console.log(`    #${res.indexOf(r)} (${(r.score ?? 0).toFixed(3)}) ${txt(r).replace(/\n/g, " ").slice(0, 75)}`));
  }

  const dirState = (adapter as unknown as { state: { dir: string; memoryDir: string } }).state;
  console.log(`\nDIR=${dirState.dir}`);
  console.log(`DB=${dirState.dir}/index.db`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
