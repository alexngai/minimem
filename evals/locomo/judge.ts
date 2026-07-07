/**
 * Answer generation + LLM-as-judge for LOCOMO.
 *
 * The judge is mem0's "J" prompt verbatim (the LoCoMo-leaderboard metric used by
 * Mem0 / MemR3) so our numbers line up with the published leaderboard. It is
 * deliberately GENEROUS (topic match counts; format/length/relative dates
 * forgiven).
 *
 * Because the answer model and judge are the same family (GPT-5.5), the judge
 * must be validated against a human-labeled sample and reported as a lower
 * bound — see README.
 *
 * Ported from cognitive-core/src/eval/memory-qa/qa.ts for cross-harness parity.
 */

import type { LlmClient } from "./llm.js";
import type { LocomoQuestion } from "./types.js";

export interface RetrievedExcerpt {
  /** e.g. "D2:5 (2023-05-07)". */
  ref: string;
  text: string;
}

/**
 * Build the answer-generation prompt. `natural` mode (default) answers in a
 * short phrase without a NO_ANSWER sentinel, matching the A-MEM/mem0 setup so
 * word-overlap and the J-judge score a real answer.
 */
export function buildAnswerPrompt(
  question: LocomoQuestion,
  excerpts: RetrievedExcerpt[],
  mode: "natural" | "strict" = "natural",
): string {
  const NO_ANSWER = "NO_ANSWER";
  const instruction =
    mode === "strict"
      ? `Answer in one short phrase. If the excerpts do not contain the answer, reply exactly: ${NO_ANSWER}`
      : "Answer in one short phrase, as directly as possible.";

  const body = excerpts.map((e) => `- [${e.ref}] ${e.text}`).join("\n");
  return [
    "You are answering a question using ONLY the memory excerpts below (from a past conversation).",
    "Each excerpt is prefixed with its dialogue id and, where available, a date/time.",
    instruction,
    "",
    "Memory excerpts:",
    body,
    "",
    `Question: ${question.question}`,
    "Answer:",
  ].join("\n");
}

/**
 * mem0's LLM-judge ("J") prompt — verbatim. GENEROUS by design.
 */
export function buildMem0JudgePrompt(
  question: string,
  gold: string,
  candidate: string,
): string {
  return `Your task is to label an answer to a question as 'CORRECT' or 'WRONG'. You will be given:
(1) a question, (2) a 'gold' (ground truth) answer, (3) a generated answer to score as CORRECT/WRONG.

The gold answer is usually concise. The generated answer may be much longer — be GENEROUS: as long as it touches on the same topic / refers to the same thing as the gold answer, count it CORRECT. For time questions, differing formats or relative references that denote the same date/period are CORRECT (e.g. "May 7th" vs "7 May").

Question: ${question}
Gold answer: ${gold}
Generated answer: ${candidate}

Reply with exactly one word: CORRECT or WRONG.`;
}

/**
 * True when an answer is a refusal / "no information" response. For LOCOMO
 * category 5 (adversarial) the correct behavior is to refuse, so refusal
 * accuracy is the meaningful metric there.
 */
export function isRefusal(answer: string): boolean {
  return /not mentioned|no information|not in the conversation|cannot|can'?t|do(es)?n'?t (know|have|mention|appear|say|specify)|isn'?t (mentioned|available|specified)|unable to|not (specified|stated|provided|discussed|available|mentioned)/i.test(
    answer ?? "",
  );
}

export interface JudgeOutcome {
  correct: boolean;
  raw: string;
  judgeTokens: number;
}

/**
 * Judge one (question, gold, answer) with the mem0 J-judge. Returns the verdict
 * plus the judge's token usage (for the cost axis).
 */
export async function judgeAnswer(
  llm: LlmClient,
  question: string,
  gold: string,
  answer: string,
): Promise<JudgeOutcome> {
  const { text, usage } = await llm.chat([
    { role: "user", content: buildMem0JudgePrompt(question, gold, answer) },
  ]);
  const out = text.trim().toLowerCase();
  // "wrong" checked first (a CORRECT/WRONG reply won't contain both per the prompt).
  const correct = /\bwrong\b/.test(out) ? false : /\bcorrect\b/.test(out);
  return { correct, raw: text.trim(), judgeTokens: usage.totalTokens };
}
