/**
 * Build a VERBATIM observation cache for LongMemEval, so C1 can be tested with a control.
 *
 * C1 claims write-time compression is a bad trade for exact recall, and its stated hole is
 * that every benchmark we cite grades exact recall — the converse (does compression help
 * synthesis?) is untested. LongMemEval can test it, because its categories split into
 * synthesis (multi-session, knowledge-update, temporal-reasoning) and recall
 * (single-session-*). But both existing arms extract: `run-flat.tmp.ts` is "flat" in the
 * sense of retrieval structure, and its own docstring notes it reuses the cached
 * observations. There is no verbatim arm to compare against.
 *
 * Rather than build a parallel pipeline (which would reintroduce confounds), this writes a
 * cache in the SAME `ObservationCache` schema the adapter already loads, with one
 * "observation" per turn whose statement is the raw turn text. Pointing the adapter at this
 * directory changes only what the notes contain — retrieval, prompt, answer model and judge
 * are untouched.
 *
 *   npx tsx evals/longmemeval/make-verbatim-cache.tmp.ts [--n 90] [--out <dir>]
 */
import fs from "node:fs/promises";
import path from "node:path";

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const DATA = arg("data", "evals/longmemeval/cache/longmemeval_s.json")!;
const OUT = arg("out", "evals/longmemeval/.cache/verbatim-observations")!;
const N = Number(arg("n", "0"));

interface Turn { role?: string; content?: string }
interface Instance {
  question_id: string;
  haystack_sessions: Turn[][];
  haystack_dates?: string[];
  haystack_session_ids?: string[];
}

async function main(): Promise<void> {
  const raw = JSON.parse(await fs.readFile(DATA, "utf8")) as Instance[];
  const instances = N > 0 ? raw.slice(0, N) : raw;
  await fs.mkdir(OUT, { recursive: true });

  let notes = 0;
  for (const inst of instances) {
    const observations: unknown[] = [];
    inst.haystack_sessions.forEach((session, si) => {
      const date = inst.haystack_dates?.[si];
      const sid = inst.haystack_session_ids?.[si] ?? `s${si}`;
      session.forEach((turn, ti) => {
        const text = (turn.content ?? "").trim();
        if (!text) return;
        observations.push({
          // Verbatim, with the speaker kept so provenance matches what extraction records.
          statement: `${turn.role ?? "speaker"}: ${text}`,
          type: "event",
          status: "complete",
          ...(date ? { date } : {}),
          entities: [],
          turnIds: [`${sid}:${ti}`],
        });
      });
    });
    notes += observations.length;
    await fs.writeFile(
      path.join(OUT, `${inst.question_id}.combined.json`),
      JSON.stringify({
        version: 1,
        instanceId: inst.question_id,
        chunkTurns: 40,
        maxObservationsPerChunk: 12,
        source: "combined",
        observations,
      }),
      "utf8",
    );
  }
  process.stdout.write(
    `wrote ${instances.length} verbatim caches to ${OUT} (${notes} notes, ` +
      `${(notes / Math.max(instances.length, 1)).toFixed(0)} per instance)\n`,
  );
}

void main();
