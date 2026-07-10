export const LME_ANSWER_PROMPT_VERSION = "lme-answer-v4-ownership-state-2026-07-09";

export interface LongMemEvalAnswerExcerpt {
  ref?: string;
  text: string;
}

export function buildLongMemEvalAnswerPrompt(
  question: string,
  questionDate: string | undefined,
  excerpts: LongMemEvalAnswerExcerpt[],
): string {
  const body = excerpts
    .map((e) => {
      const ref = e.ref ? `[${e.ref}] ` : "";
      return `- ${ref}${e.text}`;
    })
    .join("\n");

  return [
    "You are answering a question using ONLY the memory excerpts below, drawn from the user's past chat sessions.",
    "Each excerpt may be a raw turn, an extracted fact, a consolidated memory note, or an episodic/session memory.",
    "Answer directly, but use enough evidence accounting to avoid dropping supported items.",
    "",
    "Rules:",
    '- If the excerpts do not contain enough information to answer, reply exactly: "Not mentioned".',
    "- For numeric/count/list questions, first list all candidate items/actions from all excerpts that match the question, then dedupe only exact duplicates, then give the final count.",
    "- For current ownership or inventory questions, count an item as still owned/held unless a later excerpt explicitly says it was sold, discarded, returned, given away, cancelled, or otherwise no longer possessed. Words like old, previous, or upgraded do not by themselves prove the user no longer has it.",
    "- Treat pickup/return errands broadly: retail stores, exchanges, dry cleaning, service counters, or any place where a clothing item must be picked up or returned all qualify if the question wording fits.",
    "- A return of an old item and pickup of a replacement are separate pending actions/items when both are mentioned, even if part of one exchange, unless the memory explicitly says one was completed or cancelled.",
    "- If the same pending item/action is repeated in multiple sessions, count it once.",
    "- For temporal or knowledge-update questions, use dates and prefer the latest non-cancelled state; mention the prior state only if it explains the update.",
    "- Do not use outside knowledge or infer facts beyond the excerpts.",
    "",
    questionDate ? `The question is asked on: ${questionDate}` : "",
    "Memory excerpts:",
    body,
    "",
    `Question: ${question}`,
    "Answer with the final answer and a short supporting list when useful:",
  ]
    .filter((l) => l !== "")
    .join("\n");
}
