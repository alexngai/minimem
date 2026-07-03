/**
 * `minimem-alone` arm — the retrieval-only baseline.
 *
 * No LLM extraction: each conversation turn becomes a note, indexed by minimem
 * in BM25-only mode (no embedding API). At answer time we retrieve the top-k
 * turns and have GPT-5.5 read them and answer. This isolates minimem's
 * retrieval quality and anchors what cognitive-core's extraction layer adds.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Minimem } from "../../../src/index.js";
import { buildAnswerPrompt, type RetrievedExcerpt } from "../judge.js";
import type {
  LocomoConversation,
  LocomoQuestion,
  MemorySystemAdapter,
  UsageStats,
} from "../types.js";
import type { LlmClient } from "../llm.js";

export interface MinimemAloneOptions {
  /** Retrieved excerpts per question. */
  topK?: number;
  /** Root for the scratch memory dir (defaults to os.tmpdir()). */
  scratchRoot?: string;
}

interface NoteRef {
  ref: string;
  text: string;
}

export class MinimemAloneAdapter implements MemorySystemAdapter {
  readonly name = "minimem-alone";
  private readonly topK: number;
  private readonly scratchRoot: string;
  private readonly llm: LlmClient;

  private memoryDir: string | null = null;
  private mm: Minimem | null = null;
  /** basename → note (resolve search hits back to full turn text). */
  private notes = new Map<string, NoteRef>();

  constructor(llm: LlmClient, opts?: MinimemAloneOptions) {
    this.llm = llm;
    this.topK = opts?.topK ?? 8;
    this.scratchRoot = opts?.scratchRoot ?? os.tmpdir();
  }

  async ingest(conversation: LocomoConversation): Promise<UsageStats> {
    const started = Date.now();
    const dir = await fs.mkdtemp(path.join(this.scratchRoot, "locomo-mm-"));
    this.memoryDir = dir;
    this.notes.clear();

    const notesDir = path.join(dir, "memory");
    await fs.mkdir(notesDir, { recursive: true });

    let n = 0;
    for (const session of conversation.sessions) {
      for (const turn of session.turns) {
        const ref = `${turn.diaId}${session.dateTime ? ` (${session.dateTime})` : ""}`;
        const text = turn.imageCaption
          ? `${turn.speaker}: ${turn.text} [shared image: ${turn.imageCaption}]`
          : `${turn.speaker}: ${turn.text}`;
        const base = `turn-${String(n).padStart(5, "0")}.md`;
        const fileBody = `${session.dateTime ? `> ${session.dateTime}\n\n` : ""}${text}\n`;
        await fs.writeFile(path.join(notesDir, base), fileBody, "utf-8");
        this.notes.set(base, { ref, text });
        n++;
      }
    }

    this.mm = await Minimem.create({
      memoryDir: dir,
      dbPath: path.join(dir, "index.db"),
      embedding: { provider: "none" },
      hybrid: { enabled: true, vectorWeight: 0, textWeight: 1, ftsQueryMode: "or" },
      query: { maxResults: this.topK, minScore: 0 },
      watch: { enabled: false },
    });
    // Force the initial index build so the first query isn't charged for it.
    await this.mm.sync({ reason: "ingest" });

    return { latencyMs: Date.now() - started, totalTokens: 0 };
  }

  async answer(
    question: LocomoQuestion,
  ): Promise<{ text: string } & UsageStats> {
    if (!this.mm) throw new Error("ingest() must run before answer()");

    const hits = await this.mm.search(question.question, {
      maxResults: this.topK,
      minScore: 0,
      skipStaleCheck: true,
    });

    const excerpts: RetrievedExcerpt[] = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      const base = path.basename(hit.path);
      const note = this.notes.get(base);
      if (!note || seen.has(base)) continue;
      seen.add(base);
      excerpts.push({ ref: note.ref, text: note.text });
    }

    const prompt = buildAnswerPrompt(question, excerpts);
    const { text, usage } = await this.llm.chat([{ role: "user", content: prompt }]);
    return { text: text.trim(), ...usage };
  }

  async reset(): Promise<void> {
    await this.close();
  }

  async close(): Promise<void> {
    if (this.mm) {
      await this.mm.close?.();
      this.mm = null;
    }
    if (this.memoryDir) {
      await fs.rm(this.memoryDir, { recursive: true, force: true }).catch(() => {});
      this.memoryDir = null;
    }
    this.notes.clear();
  }
}
