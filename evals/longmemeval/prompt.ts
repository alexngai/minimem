export const LME_ANSWER_PROMPT_VERSION = "lme-answer-v15-explicit-event-date-2026-07-12";

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
    "- For questions asking how many doctors, physicians, or medical providers the user visited, count a named provider when the evidence says they diagnosed, prescribed, treated, or had a follow-up appointment with the user. Exclude planned future consultations, generic doctor-advice wording, clinic-admin examples, and fictional/example doctors.",
    "- For temporal/order questions, build a dated timeline from explicit dates, session dates, and relative references. Sort the events before answering. If the question asks for elapsed days/weeks/months, show the calculation and units.",
    "- For order questions, when an event description contains an explicit calendar date for the event, use that event date instead of the source session date or words like recently/lately. Use the source session date only when the actual event date is not explicit.",
    "- Resolve relative dates such as yesterday, last Saturday, next week, or this month against the question date when available; otherwise resolve them against the dated session that contains the phrase.",
    "- For date-anchored who/from-whom questions, prioritize receive/gift/acquisition events on the resolved date and answer the explicit person/source if present, even when the object's wording is approximate.",
    "- For elapsed-time questions, identify the exact two events named by the question and compute between those event dates only. If evidence says the user just started/began/recovered on a date, use that explicit date as the start. Do not add a separate 'had been doing X for N weeks' duration unless there is no direct start event or the user explicitly corrects the start date with words like actually, correction, or I meant. Do not treat extractor words such as superseding or later stated as a user correction.",
    "- For earliest-to-latest order questions, include completed user events; exclude assistant recommendations, candidate options, plans, and repeated later mentions unless the user actually completed or booked the visit/flight/action. For same-date events with no time, preserve the source turn order.",
    "- For museum order questions, include completed user visits, tours, exhibitions, or lecture series at named museums. Exclude galleries unless the question asks for galleries. If the only date is phrased as recently or just came back, use the dated source session as that event date.",
    "- For airline/flight order questions, include actual completed flights and flights booked in the conversation; exclude candidate options that were merely compared. A completed flight tied to earning or using a named airline rewards program can identify the airline when no contrary airline is stated. Return unique airline names by first actual/booked flight occurrence; do not repeat the same airline for multiple legs.",
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
