export const LME_ANSWER_PROMPT_VERSION = "lme-answer-v11-academic-descriptor-guard-2026-07-11";

export interface LongMemEvalAnswerExcerpt {
  ref?: string;
  text: string;
}

export function buildLongMemEvalAnswerPrompt(
  question: string,
  questionDate: string | undefined,
  excerpts: LongMemEvalAnswerExcerpt[],
  questionCategory?: string,
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
    '- Before replying "Not mentioned", scan every excerpt and tool result. Answer from a candidate only if it directly satisfies all required entities, descriptors, events, and time constraints in the question.',
    "- For numeric/count/list questions, first make a candidate ledger from all excerpts: item/action/event, source/date if present, include/exclude decision, and reason. Then dedupe exact repeats and give the final count or list.",
    "- Count unique real-world items/actions/events, not mentions. Do not drop a candidate merely because it appears in a lower-ranked excerpt, an assistant turn, or a session-level/episodic memory.",
    "- For current ownership or inventory questions, count an item as still owned/held unless a later excerpt explicitly says it was sold, discarded, returned, given away, cancelled, or otherwise no longer possessed. Words like old, previous, or upgraded do not by themselves prove the user no longer has it.",
    "- Treat pickup/return errands broadly: retail stores, exchanges, dry cleaning, service counters, or any place where a clothing item must be picked up or returned all qualify if the question wording fits.",
    "- A return of an old item and pickup of a replacement are separate pending actions/items when both are mentioned, even if part of one exchange, unless the memory explicitly says one was completed or cancelled.",
    "- If the same pending item/action is repeated in multiple sessions, count it once.",
    "- For temporal/order questions, build a dated timeline from explicit dates, session dates, and relative references. Sort the events before answering. If the question asks for elapsed days/weeks/months, show the calculation and units.",
    "- Resolve relative dates such as yesterday, last Saturday, next week, or this month against the question date when available; otherwise resolve them against the dated session that contains the phrase.",
    "- For date-anchored who/from-whom questions, prioritize receive/gift/acquisition events on the resolved date and answer the explicit person/source if present, even when the object's wording is approximate.",
    "- For elapsed-time questions, identify the event date asked about and the true start event. If evidence says the user just started an activity on a date, use that explicit start event unless a later memory explicitly corrects the start date.",
    "- For earliest-to-latest order questions, include completed user events; exclude assistant recommendations, candidate options, plans, and repeated later mentions unless the user actually completed the visit/flight/action. For same-date events with no time, preserve the source turn order.",
    "- For airline/flight order questions, a completed flight tied to earning or using a named airline rewards program can identify the airline when no contrary airline is stated.",
    "- For knowledge-update questions, use dates and prefer the latest non-cancelled state; mention the prior state only if it explains the update.",
    "- For preference/recommendation questions, use analogous remembered preferences from prior choices to answer the new request. Do not require the exact new destination, venue, product, or option to appear in memory; answer from preference dimensions such as views, amenities, constraints, and style.",
    "- For unanswerable questions, require an exact match to the asked entity, role, event, and time period. Related but mismatched facts are not enough.",
    "- For non-preference factual questions, do not stitch separate memories into an answer unless an excerpt explicitly supports the asked relationship. If the question asks for a specific descriptor or role, that descriptor must be tied to the same event or a direct update.",
    "- For presentation, poster, publication, award, or conference-location questions, the location or institution must be explicitly tied to the asked presentation/poster/event. Do not infer the location from a related conference mention unless the same evidence states it was that presentation/poster/event.",
    "- Academic descriptors are exact: thesis research, course research, undergrad research, graduate research, and conference attendance are not interchangeable unless an excerpt explicitly equates them.",
    "- Tool result Query lines repeat the question; they are not memory evidence.",
    "- Do not use outside knowledge or infer facts beyond the excerpts.",
    "",
    questionCategory ? `Question category: ${questionCategory}` : "",
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
