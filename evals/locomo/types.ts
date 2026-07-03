/**
 * Types for the LOCOMO long-term conversational memory benchmark.
 *
 * Two layers:
 * - Raw*  — mirror the on-disk `locomo10.json` schema from snap-research/locomo.
 * - Normalized types — a clean, flattened shape the harness/adapters consume.
 *
 * See evals/locomo/README.md for methodology.
 */

// ---------------------------------------------------------------------------
// Raw on-disk schema (snap-research/locomo → data/locomo10.json)
// ---------------------------------------------------------------------------

export interface LocomoRawTurn {
  speaker: string;
  dia_id: string;
  text: string;
  img_url?: string[];
  blip_caption?: string;
}

export interface LocomoRawQA {
  question: string;
  /** Present for non-adversarial questions (categories 1-4). May be a number. */
  answer?: string | number;
  /** Present for adversarial questions (category 5). */
  adversarial_answer?: string;
  /** Dialogue ids (e.g. "D1:3") supporting the answer, when annotated. */
  evidence?: string[];
  /** 1=multi-hop, 2=temporal, 3=open-domain, 4=single-hop, 5=adversarial. */
  category: number;
}

/**
 * The conversation object uses dynamic keys: `session_<n>` (turn arrays),
 * `session_<n>_date_time` (string), plus generated `session_<n>_observation`
 * and `session_<n>_summary`. Only speaker names are fixed keys.
 */
export interface LocomoRawConversation {
  speaker_a: string;
  speaker_b: string;
  [key: string]: unknown;
}

export interface LocomoRawSample {
  sample_id: string;
  conversation: LocomoRawConversation;
  qa: LocomoRawQA[];
  event_summary?: unknown;
  observation?: unknown;
  session_summary?: unknown;
}

// ---------------------------------------------------------------------------
// Normalized types (what the harness + adapters use)
// ---------------------------------------------------------------------------

export type LocomoCategory =
  | "multi_hop"
  | "temporal"
  | "open_domain"
  | "single_hop"
  | "adversarial";

/** Map LOCOMO numeric category → readable label. */
export const CATEGORY_BY_ID: Record<number, LocomoCategory> = {
  1: "multi_hop",
  2: "temporal",
  3: "open_domain",
  4: "single_hop",
  5: "adversarial",
};

/**
 * Adversarial questions (category 5) have misleading premises and are excluded
 * from the standard accuracy metric (following the LOCOMO/mem0 convention).
 */
export const ADVERSARIAL_CATEGORY_ID = 5;

export interface LocomoTurn {
  speaker: string;
  /** Dialogue id, e.g. "D1:3" — used to resolve `evidence`. */
  diaId: string;
  text: string;
  imageCaption?: string;
}

export interface LocomoSession {
  /** Chronological session number (1-based, from `session_<n>`). */
  index: number;
  /** Human-readable timestamp from `session_<n>_date_time`. */
  dateTime: string;
  turns: LocomoTurn[];
}

export interface LocomoQuestion {
  /** Stable id: `${sampleId}#${indexWithinSample}`. */
  id: string;
  question: string;
  /** Gold answer as a string (adversarial answers included for reference). */
  answer: string;
  evidence: string[];
  category: LocomoCategory;
  categoryId: number;
  isAdversarial: boolean;
}

export interface LocomoConversation {
  sampleId: string;
  speakerA: string;
  speakerB: string;
  /** Sessions in chronological order. */
  sessions: LocomoSession[];
  questions: LocomoQuestion[];
}

// ---------------------------------------------------------------------------
// Adapter + result contracts
// ---------------------------------------------------------------------------

/** Token/latency accounting for a single operation. */
export interface UsageStats {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs: number;
}

/**
 * A memory system under test. Every arm (minimem+cogcore, mem0, letta,
 * minimem-alone) implements this so the runner and cost accounting are uniform.
 *
 * Fair-fight invariant: all adapters use the SAME base LLM for extraction and
 * answer generation; only the memory layer differs.
 */
export interface MemorySystemAdapter {
  readonly name: string;
  /** Ingest an entire conversation (all sessions) into the memory store. */
  ingest(conversation: LocomoConversation): Promise<UsageStats>;
  /** Answer one question using the memory built during ingest. */
  answer(
    question: LocomoQuestion,
    conversation: LocomoConversation,
  ): Promise<{ text: string } & UsageStats>;
  /** Clear all state so the next conversation starts fresh. */
  reset(): Promise<void>;
  /** Release resources (db handles, servers, subprocesses). */
  close?(): Promise<void>;
}

/** Result for one (system × question). `correct` is null until judged. */
export interface QAResult {
  system: string;
  sampleId: string;
  questionId: string;
  categoryId: number;
  category: LocomoCategory;
  question: string;
  goldAnswer: string;
  predicted: string;
  correct: boolean | null;
  judgeRaw?: string;
  usage: UsageStats;
}

export interface SystemRunResult {
  system: string;
  /** One entry per conversation ingested. */
  ingestUsage: UsageStats[];
  qa: QAResult[];
}
