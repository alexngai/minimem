/**
 * Per-dimension diff of two BEAM details.jsonl files (arm A = baseline, arm B).
 * Matches rows by questionId so it is robust to ordering. Prints per-dim mean
 * score for each arm + delta, and overall (mean of dims).
 *
 *   npx tsx evals/beam/diff-details.tmp.ts <A.jsonl> <B.jsonl>
 */
import fs from "node:fs";

const [pathA, pathB] = process.argv.slice(2);
if (!pathA || !pathB) { console.error("usage: diff-details.tmp.ts <A.jsonl> <B.jsonl>"); process.exit(1); }

type Row = { questionId: string; dimension: string; score: number };
const load = (p: string): Map<string, Row> => {
  const m = new Map<string, Row>();
  for (const l of fs.readFileSync(p, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = JSON.parse(l) as Row;
    m.set(r.questionId, r);
  }
  return m;
};
const A = load(pathA), B = load(pathB);
const dims = [...new Set([...A.values()].map((r) => r.dimension))].sort();
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);

console.log(`A = ${pathA}`);
console.log(`B = ${pathB}`);
console.log(`common questions: ${[...A.keys()].filter((k) => B.has(k)).length}\n`);
console.log(`${"dimension".padEnd(26)} ${"A".padStart(8)} ${"B".padStart(8)}   delta   n`);
const perDimA: number[] = [], perDimB: number[] = [];
for (const d of dims) {
  const ids = [...A.keys()].filter((k) => B.has(k) && A.get(k)!.dimension === d);
  const a = mean(ids.map((k) => A.get(k)!.score));
  const b = mean(ids.map((k) => B.get(k)!.score));
  perDimA.push(a); perDimB.push(b);
  const dl = b - a;
  console.log(`${d.padEnd(26)} ${(100 * a).toFixed(1).padStart(7)}% ${(100 * b).toFixed(1).padStart(7)}%   ${dl >= 0 ? "+" : ""}${(100 * dl).toFixed(1).padStart(5)}   ${ids.length}`);
}
const oa = mean(perDimA), ob = mean(perDimB);
console.log(`${"OVERALL (mean of dims)".padEnd(26)} ${(100 * oa).toFixed(1).padStart(7)}% ${(100 * ob).toFixed(1).padStart(7)}%   ${ob - oa >= 0 ? "+" : ""}${(100 * (ob - oa)).toFixed(1).padStart(5)}`);
