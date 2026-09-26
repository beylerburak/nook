/**
 * Server side of bookmark summaries — the summary half of docs/retrieval.md,
 * and the only part of it that has to be a server call.
 *
 * Jev cannot generate text. It evaluates a `state` against typed questions and
 * returns calibrated answers (see ai.ts), so there is no call to make that
 * produces prose. Summarisation therefore uses the same proposer plumbing
 * `proposeTaxonomy` already establishes: an env-driven provider, raw `fetch`,
 * injectable `deps`, and a degradation to nothing rather than a throw.
 *
 * The provider dispatch below is duplicated from ai.ts rather than shared, and
 * that is deliberate. ai.ts pins its prompts to JSON
 * (`response_format: { type: "json_object" }` on OpenAI, `responseMimeType:
 * "application/json"` on Gemini) because a taxonomy is a structure that has to
 * come back parseable. A summary is prose, and a JSON envelope would add a
 * failure mode — a model that wraps its answer in a fence, or emits a string
 * with the sentence still inside it — to a value whose whole point is that a
 * human reads it. The retry policy is copied for the same reason: it is about
 * the transport rather than the payload. **If one of these moves, both move.**
 *
 * Three things make the contract hold, and the file is organised around them:
 *
 * - **Only where a summary earns its place.** `shortDescription` is a
 *   mechanical 180-character truncation of `description` (lib/page-capture.ts
 *   and lib/x-parser.ts both slice at 180), so the library row already shows
 *   the first 180 characters of most of the library. See
 *   MIN_SUMMARISABLE_CHARS and `isWorthSummarising`.
 * - **In the content's own language.** A Turkish article gets a Turkish summary
 *   whatever the collections are called, so `TaxonomyLanguage` is deliberately
 *   *not* reused here: that setting is about the names the model invents, this
 *   is about words it was given.
 * - **The model's words, not the user's.** Which used to be the reason the
 *   server did not write a summary anywhere, and is no longer a reason for
 *   anything — see the note on `summarizeRecords`, which is the long version of
 *   what changed and why the old argument does not hold.
 *
 * What is left here is the *prose*: the prompt, the post-processing, the length
 * gate and the transport. The pass that decides what to summarise, when, and
 * what to remember about it is `ai-summary.ts`, and this file is what that pass
 * calls. `docs/ai-summarize-contract.md` is the seam.
 */

import type { Pool } from "pg";

// -- types --

/**
 * A synced bookmark, in the shape `syncRecords` returns it. Duplicated from
 * embeddings.ts's `IndexableRecord` rather than imported: same shape, because
 * both read the same table the same way, and a type-only import between two
 * feature modules buys nothing.
 */
export interface SummaryRecord {
  id: string;
  /** The record as the client authored it — the jsonb that is authoritative. */
  data: Record<string, unknown>;
  /**
   * `nook_records.deleted_at`, set by the reconciler and by sync. Read *as well
   * as* `data.deletedAt` rather than instead of it, for the reason
   * embeddings.ts gives: a record must not be a tombstone to one caller and a
   * live bookmark to another.
   */
  deletedAt?: string | null;
}

export interface SummaryResult {
  id: string;
  summary: string;
}

/**
 * Why a bookmark did not get a summary. Machine-readable on purpose: somebody has
 * to tell "nothing to do" (`too-short`, `already-summarised`, `not-found`) from
 * "it tried and could not" (`empty-output`, `failed`, `unavailable`), or a
 * throttled key looks exactly like a library with nothing worth summarising. That
 * somebody was a client and is now the pass in ./ai-summary.ts, which branches on
 * the same values to decide what is worth remembering; a reason it cannot compare
 * against is not a reason, it is a sentence.
 */
export type SummarySkipReason =
  | "not-found"
  | "deleted"
  | "already-summarised"
  | "too-short"
  | "empty-output"
  | "unavailable"
  | "failed";

export interface SummarizeResponse {
  summaries: SummaryResult[];
  skipped: Array<{ id: string; reason: SummarySkipReason }>;
  /**
   * The model that answered, or `unavailable` when no call was made. Reported
   * but *not* stored: the classification's `ai.model` exists because the
   * attribution is a receipt the UI can show, whereas a summary carries its own
   * provenance on its face — it is the model's words, and the panel says so
   * rather than implying the user wrote it.
   */
  model: string;
}

/**
 * A call that never happened has no model, same rule as ai.ts's
 * UNAVAILABLE_MODEL: nothing was written, so nothing is claimed.
 */
export const UNAVAILABLE_MODEL = "unavailable";

/** The system half of the prompt, shared by every record in a batch. */
export interface SummaryPrompt {
  system: string;
  user: string;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Injectable so the unit tests never touch the network. */
export interface SummaryDeps {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface SummaryAvailability {
  /** Configured proposer id, or null when unset or unknown. */
  proposer: "openai" | "gemini" | null;
  /** Whether the proposer named above actually has an API key. */
  summarize: boolean;
  /** The model a call would use right now, defaults included. */
  model: string;
}

// -- constants --

/**
 * The length gate, and the number in this file most likely to be argued with.
 *
 * 180 is the truncation `shortDescription` already applied, so a description at
 * or below it is text the user can read in the library row *today*. A summary
 * of one of those is the same 180 characters a second time.
 *
 * 400 rather than 2x180 because 2x is still one paragraph. At 400 the
 * description carries at least 220 characters — roughly forty words in Turkish
 * or English — that the row does not show, which is the smallest amount of text
 * a one-or-two-sentence summary can say something *new* about. Below that the
 * answer is a compression of something the user could just read.
 *
 * And the reason it is a gate at all: on a real 1,061-bookmark library most
 * records are X posts whose `description` *is* the truncation (x-parser.ts
 * slices the tweet text at 180 and stores it as both fields). Summarising those
 * would pay twice for the same text, and would bury the handful of long-form
 * reads that actually need a summary under a thousand rows that never did.
 *
 * This is a cost guard *and* a quality one, and it is deliberately not
 * re-measured: 180 is a constant in the extension, so the ratio is the only
 * thing that could drift, and 400/180 is a judgement about how much unseen text
 * a summary is worth, which no measurement settles.
 *
 * Exported because `ai-summary.ts` interpolates it into the candidate query's
 * length filter. Not a re-measurement and not a second copy of the rule: the SQL
 * copy is the same number from this one place, and the work plan
 * (`planSummaryWork`, over the same `isWorthSummarising`) is the authority on top
 * of it, so a filter that is somehow too wide costs a pass rather than an answer.
 */
export const MIN_SUMMARISABLE_CHARS = 400;

/** Per-field caps on what reaches the prompt. */
const MAX_TITLE_CHARS = 300;
const MAX_NOTE_CHARS = 2000;

/**
 * 4,000 characters of a page is about six hundred words, and a summary is one or
 * two sentences — so the rest of an article cannot change the answer, while
 * inlining a 40,000-character capture whole is exactly the request that would
 * make a batch fail on a length the model was never asked to respect. Same cap
 * ai.ts puts on its own state fields, for the same reason.
 */
const MAX_PROMPT_DESCRIPTION_CHARS = 4000;

/**
 * The stored-value cap. A summary is read in a detail view, not scrolled as a
 * body of text, so this is a "that is a summary, not a summary of the summary"
 * guard on a model that ignored "one or two sentences" — not a budget knob.
 * Generous next to the ~250 characters two sentences actually run to, so a
 * Turkish sentence that tokenises densely is not clipped for being Turkish.
 */
const MAX_SUMMARY_CHARS = 400;

/** Generation budget. Two sentences run to roughly a hundred tokens; this is
 *  room for a dense Turkish two-sentence answer, and it is the parameter that
 *  actually stops a paragraph rather than the prompt asking nicely. */
const MAX_COMPLETION_TOKENS = 300;

const REQUEST_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_JITTER_MS = 250;
const MAX_RETRY_AFTER_MS = 5_000;

/** Throttling and gateway-busy are worth retrying; everything else is our own
 *  bug or our own configuration and retrying only delays it by two round trips. */
const RETRY_STATUSES = new Set([429, 529]);

/**
 * Ids one call will take, which is now the worker's per-pass ceiling rather than
 * a route's.
 *
 * The number did not change and neither did the reason. 50 is a wall-clock bound,
 * not a billing one — the doc's cost table puts the whole library at fractions of
 * a cent — and it is here because one call is one window of work, not a library:
 * `SUMMARY_CONCURRENCY` requests in flight over however many ids arrive, and a
 * caller that hands over a library would be paying for a pass's worth of latency
 * inside somebody else's request. The worker plans a batch of
 * `NOOK_AI_SUMMARY_BATCH` (25) and is therefore always under it; this is the
 * ceiling for a caller that is not, and `ai-summary.ts` clamps its batch to it so
 * an over-eager `NOOK_AI_SUMMARY_BATCH` is refused here rather than silently
 * truncated.
 */
export const MAX_IDS_ACCEPTED = 50;

/**
 * One request per record, this many in flight.
 *
 * "Batched" here means a window of concurrent single-record calls rather than
 * one request carrying every article, and that is a deliberate trade. A single
 * request would save round trips, which the measured cost says are not the
 * constraint — but it would also mean one malformed answer loses twenty
 * bookmarks, and a model asked for twenty summaries at once spreads its
 * attention across them, which shows up in exactly the place the user reads.
 * Four in flight overlaps the round trip the way ai-runner.ts overlaps its
 * classify calls, and stays nowhere near a low-tier key's limit.
 */
const SUMMARY_CONCURRENCY = 4;

// -- small helpers --

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size));
  return chunks;
}

function capText(value: unknown, max: number): string | undefined {
  const text = cleanText(value);
  return text === undefined ? undefined : truncate(text, max);
}

/** A tombstone, by either signal. See `SummaryRecord.deletedAt`. */
function isDeleted(record: SummaryRecord): boolean {
  return cleanText(record?.deletedAt) !== undefined || cleanText(record?.data?.deletedAt) !== undefined;
}

/** A summary the client already holds. `""` counts as none, so a cleared
 *  summary is summarised again rather than merged as a permanent blank.
 *
 *  Exported for the pass's write guard, which re-checks this on the row it
 *  re-reads inside the lock. That is the only moment the claim can be broken:
 *  between the top-up query and the write, the user can delete the summary, and
 *  the pass must not put it back. */
export function hasSummary(record: SummaryRecord): boolean {
  return cleanText(record?.data?.summary) !== undefined;
}

// -- pure: the length gate --

/**
 * Whether this record is worth a request, which is a question about the
 * *description* and not about the summary. `shortDescription` is never the
 * subject: on this library it is a truncation of `description`, and a record
 * that has one but no `description` has nothing beyond the row.
 *
 * Returns false for a missing description rather than falling back to
 * `shortDescription`, and that is the one case a reader is most likely to want
 * to "fix": the fallback would summarise text the user can already see, and
 * would do it for every record where the two fields happen to diverge.
 */
export function isWorthSummarising(record: SummaryRecord): boolean {
  const description = cleanText(record?.data?.description);
  if (!description) return false;
  return description.length > MIN_SUMMARISABLE_CHARS;
}

// -- pure: the prompt --

/**
 * The system half. Shared by every record in a batch, so it is a constant
 * rather than something rebuilt per call.
 *
 * The real work here is negative. A model asked for a summary will very often
 * answer "Bu bir özet: …" or "Here is a summary: …" — the caller already has
 * somewhere to put this, so a label is text the user has to scroll past — and
 * will reach for markdown or a bullet list. Naming those three failures is what
 * actually reduces them; `cleanSummary` then removes whatever survives.
 */
export const SUMMARY_SYSTEM_PROMPT = [
  "You summarise a saved page or post for someone's bookmark library.",
  "",
  "Reply with the summary only: one or two sentences of plain text.",
  "No preamble, no label, no markdown, no bullet points, and no quotation marks around it.",
  "Never start with words like \"Here is a summary\" or \"Bu bir özet\" - the caller already has a place to put this and adds nothing above it.",
  "",
  // Measured, not anticipated: forbidding the obvious labels changed nothing, and
  // 53 of 57 real outputs still opened by referring to the artifact rather than its
  // content - "Bu sayfa, ...", "The page introduces ...". Naming the thing being
  // summarised is the same habit as the label, wearing a sentence's clothes, and
  // `cleanSummary` cannot remove it: stripping "Bu sayfa," off "Bu sayfa, Google'ın
  // yeni modelini tanıtarak ..." leaves a dangling participle about the page, which
  // is worse than the preamble. So it has to be forbidden rather than cleaned.
  "Never refer to the thing you are summarising. Do not write \"this page\", \"this",
  "article\", \"the post\", \"Bu sayfa\", \"Bu yazı\", \"the author explains\". Start with",
  "the subject itself: what it is, what it argues, what it contains.",
  "",
  "Write in the same language as the text you were given. Do not translate it, and do",
  "not answer in the language of anything else: not the site, not the caller, not the",
  "rest of the library.",
  "",
  "Say what the page is and what it argues or contains. No opinion, no advice,",
  "no offer to help, and nothing the text does not say.",
].join("\n");

/**
 * The per-record half: the title as a label, then the text to summarise.
 *
 * `note` is carried but never as the body, which is the distinction. It is the
 * user's own words *about* the page, so a prompt that let the model summarise it
 * would produce a summary of why they saved it rather than of what it says — and
 * a bare link is often nothing but the title plus that note. So it goes in as
 * its own labelled line after the text, where it can only add context.
 */
export function buildSummaryPrompt(record: SummaryRecord): SummaryPrompt {
  const data = (record?.data ?? {}) as Record<string, unknown>;
  const title = capText(data.title, MAX_TITLE_CHARS);
  // `description` is what `isWorthSummarising` required, so this fallback is
  // unreachable in a normal run; it is here so a direct caller gets a prompt
  // with a body rather than one that asks the model to summarise nothing.
  const body = capText(data.description, MAX_PROMPT_DESCRIPTION_CHARS) ?? capText(data.shortDescription, MAX_PROMPT_DESCRIPTION_CHARS);
  const note = capText(data.note, MAX_NOTE_CHARS);
  const user = [
    title ? `Title: ${title}` : undefined,
    body ? "Text:" : undefined,
    body,
    // A note is not the text, but it is often the only hint that a bare link
    // is worth reading at all, and it costs one line.
    note ? `Saved with this note: ${note}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
  return { system: SUMMARY_SYSTEM_PROMPT, user };
}

// -- pure: the post-processing --

/**
 * The label a model adds unasked, in the languages this library is written in.
 *
 * Ordered so the longer phrases are tried first, and matched only with a
 * separator after them — which is what makes this a label rather than a guess:
 * a summary that begins with one of these words as an ordinary word ("Özetlemekte
 * fayda var…") has no colon after it and is left alone.
 */
const SUMMARY_LABELS = [
  "here is a summary",
  "here's a summary",
  "in short",
  "short summary",
  "bu bir özet",
  "işte özet",
  "kısa özet",
  "özet",
  "summary",
  "tl;dr",
  "tl dr",
  "tl-dr",
  "abstract",
  "résumé",
  "resume",
];

const LEADING_LABEL = new RegExp(
  `^(?:(?:${SUMMARY_LABELS.join("|")})\\s*[:\\-–—]\\s*)+`,
  "i",
);

/**
 * A line that is nothing *but* a label, which is the shape a heading takes
 * ("## Özet", "Summary" on its own line). Matched per line rather than allowed
 * an optional separator, because making the separator optional would also eat
 * "Summary of the paper: …" — a sentence that happens to begin with one of
 * these words. A whole line is unambiguous: a summary is one or two sentences,
 * and a line containing nothing but "Özet" is a heading rather than content.
 */
const LABEL_ONLY_LINE = new RegExp(`^[ \\t]*(?:${SUMMARY_LABELS.join("|")})[ \\t]*$`, "gim");

/**
 * Only the pairs a model uses to wrap a whole answer. Single quotes are
 * excluded on purpose: they are also apostrophes and the quote marks *inside* a
 * sentence, so peeling them turns `‘tl;dr’ means dead on arrival` into
 * `tl;dr’ means dead on arrival`. Double quotes and the two guillemet pairs only
 * ever arrive around the whole answer.
 */
const WRAPPING_QUOTES: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["“", "”"],
  ["«", "»"],
];

/** Bullet and marker prefixes, before whitespace is collapsed. */
const LIST_MARKER = /^[ \t]*(?:[-*+•·–—]|\d+[.)])[ \t]+/gm;
const HEADING_MARKER = /^[ \t]*#{1,6}[ \t]*/gm;

/**
 * Emphasis that spans whole words. The single-character rules require the
 * opening marker to start a word and the closing one to end one, so `snake_case`
 * and `2 * 3` survive while `*emphasis*` does not. The double-character rules
 * need no such guard, because `**` and `__` are not interior punctuation.
 */
const EMPHASIS_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\*\*(.+?)\*\*/g, "$1"],
  [/__(.+?)__/g, "$1"],
  [/~~(.+?)~~/g, "$1"],
  [/(^|\s)\*([^*\n]+?)\*(?=\s|$|[.,;:!?)])/g, "$1$2"],
  [/(^|\s)_([^_\n]+?)_(?=\s|$|[.,;:!?)])/g, "$1$2"],
];

/** A letter or a digit. See the check it guards at the end of `cleanSummary`. */
const HAS_WORD_CHARACTER = /[\p{L}\p{N}]/u;

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return (fenced ? fenced[1] : trimmed).trim();
}

function stripLabels(text: string): string {
  let current = text.trim();
  // Both rules, repeatedly: a heading has to lose its "#" before the line is
  // recognisable as a bare label, and removing a label line can expose a
  // colon-form one underneath. Bounded so a pathological input cannot walk it.
  for (let pass = 0; pass < 3; pass++) {
    const stripped = current.replace(LABEL_ONLY_LINE, "").replace(LEADING_LABEL, "").trim();
    if (stripped === current) break;
    current = stripped;
  }
  return current;
}

function stripWrappingQuotes(text: string): string {
  let current = text.trim();
  for (let pass = 0; pass < 3; pass++) {
    const opening = current.charAt(0);
    const pair = WRAPPING_QUOTES.find(([open]) => open === opening);
    if (!pair || current.length <= pair[0].length + pair[1].length) break;
    if (!current.endsWith(pair[1])) break;
    current = current.slice(pair[0].length, current.length - pair[1].length).trim();
  }
  return current;
}

/**
 * The cap. A cut at a sentence end is preferred over a cut anywhere else,
 * because what survives is then still true — a half sentence in a detail view
 * reads as a broken summary rather than as a truncated one, and the ellipsis on
 * the fallback is the honest version of the same cut.
 */
function capLength(text: string): string {
  if (text.length <= MAX_SUMMARY_CHARS) return text;
  const head = text.slice(0, MAX_SUMMARY_CHARS);
  const boundary = Math.max(head.lastIndexOf(". "), head.lastIndexOf("! "), head.lastIndexOf("? "));
  if (boundary > Math.floor(MAX_SUMMARY_CHARS * 0.4)) return head.slice(0, boundary + 1).trimEnd();
  const lastSpace = head.lastIndexOf(" ");
  return `${(lastSpace > 0 ? head.slice(0, lastSpace) : head).trimEnd()}…`;
}

/**
 * The post-processing that makes the contract hold, and load-bearing rather
 * than cosmetic: a bookmark whose summary opens "Bu bir özet:" is a bug the
 * user reads, and the model that writes it is the *same* model whose JSON
 * envelopes ai.ts has to fence-peel and brace-scrape.
 *
 * Total: every input, including a non-string, a refusal, a fence, a bullet list
 * and a string of markdown punctuation, produces a string — and `""` whenever
 * nothing usable is left, so a caller can treat an empty summary as "no summary"
 * without a second validity check.
 */
export function cleanSummary(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let text = stripCodeFence(raw);
  text = stripLabels(text);
  text = stripWrappingQuotes(text);
  text = text.replace(LIST_MARKER, "").replace(HEADING_MARKER, "");
  for (const [pattern, replacement] of EMPHASIS_RULES) text = text.replace(pattern, replacement);
  // Again, and not for symmetry: a labelled answer is often labelled in
  // markdown ("**Özet:** …"), and the label only becomes visible to the pattern
  // once the emphasis around it is gone.
  text = stripLabels(text);
  text = text.replace(/\s+/g, " ").trim();
  text = capLength(text);
  // A result with no letter or digit in it is decoration the model left behind
  // — "***", "—", an emptied label. Storing it would put that on a bookmark in
  // the library, so it is the one case where nothing is the right answer.
  return HAS_WORD_CHARACTER.test(text) ? text : "";
}

// -- pure: the work plan --

/**
 * Why a record will not be summarised, or `null` when it will. The single place
 * the exclusions live, so `planSummaries` and the impure half cannot drift into
 * disagreeing about what "skipped" means — which is how a client ends up
 * counting a bookmark as outstanding forever.
 */
export function summarySkipReason(record: SummaryRecord): SummarySkipReason | null {
  if (isDeleted(record)) return "deleted";
  if (hasSummary(record)) return "already-summarised";
  if (!isWorthSummarising(record)) return "too-short";
  return null;
}

/**
 * The ids worth a request. Pure and total: a record with no usable id is
 * ignored rather than thrown on, because the caller is a loop over a list that
 * came off the wire.
 *
 * `alreadyDone` is a parameter rather than a read so this stays pure and
 * testable, and so the two answers to "does this already have a summary" can be
 * combined by the caller: `summarizeRecords` derives it from the stored records,
 * and a client-side runner knows about summaries it has written that have not
 * synced yet. Taking only the server's copy would re-bill for the same summary
 * on every run.
 */
export function planSummaries(
  records: readonly SummaryRecord[],
  alreadyDone: ReadonlySet<string> = new Set<string>(),
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (!record || typeof record.id !== "string" || record.id === "") continue;
    if (seen.has(record.id)) continue;
    if (alreadyDone.has(record.id)) continue;
    if (summarySkipReason(record) !== null) continue;
    seen.add(record.id);
    ids.push(record.id);
  }
  return ids;
}

// -- request validation ---------------------------------------------------

// None, and that is a change rather than an omission. `parseSummarizeRequest` was
// the whole of this section and went with `POST /api/summarize`: the body it
// validated was a list of ids for a route that computed summaries and discarded
// them, and the only caller left is the worker, which builds its own list out of
// `nook_records` and cannot hand over a malformed one. What survives of that
// route's shape is `MAX_IDS_ACCEPTED`, which `summarizeRecords` now enforces on
// itself as a per-pass ceiling.

// -- the proposer --

/**
 * The provider, the model, and the API key — all three from the environment, at
 * call time, exactly as ai.ts resolves them. A rotated key is then picked up
 * without a restart, and a unit test needs no key to exercise the degradation
 * paths.
 */
const DEFAULT_OPENAI_MODEL = "gpt-4o-mini";
const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models";

type ProposerId = "openai" | "gemini";

interface ResolvedProposer {
  provider: ProposerId;
  apiKey: string;
}

function resolveProposer(): ResolvedProposer | null {
  const selected = (process.env.NOOK_AI_PROPOSER ?? "").trim().toLowerCase();
  const provider: ProposerId | null = selected === "openai" || selected === "gemini" ? selected : null;
  if (!provider) return null;
  const apiKey = cleanText(provider === "openai" ? process.env.OPENAI_API_KEY : process.env.GEMINI_API_KEY);
  return apiKey ? { provider, apiKey } : null;
}

/**
 * `NOOK_SUMMARY_MODEL` wins, then the taxonomy proposer's own model, then the
 * default — the order docs/retrieval.md's Configuration table specifies. The
 * taxonomy knob is read for OpenAI only, because that is the only provider
 * ai.ts reads it for (Gemini is pinned to its own flash model), and one
 * environment variable should keep meaning one thing.
 */
function summaryModel(provider: ProposerId | null): string {
  const explicit = cleanText(process.env.NOOK_SUMMARY_MODEL);
  if (explicit) return explicit;
  if (provider === "gemini") return GEMINI_MODEL;
  return cleanText(process.env.NOOK_AI_MODEL) || DEFAULT_OPENAI_MODEL;
}

/** Whether summaries can run at all, and under what model. Mirrors
 *  `aiAvailability`, so the route can answer 503 before doing any work. */
export function summarizeAvailability(): SummaryAvailability {
  const proposer = resolveProposer();
  return {
    proposer: proposer ? proposer.provider : null,
    summarize: Boolean(proposer),
    model: summaryModel(proposer?.provider ?? null),
  };
}

/** Exponential backoff with jitter, copied from ai.ts. The jitter is what keeps
 *  a window of records that all hit the same 429 from retrying in lockstep. */
function backoffDelay(attempt: number, retryAfter: string | null): number {
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter);
  const base = Number.isFinite(seconds)
    ? Math.min(Math.max(seconds, 0) * 1000, MAX_RETRY_AFTER_MS)
    : BACKOFF_BASE_MS * 2 ** (attempt - 1);
  return Math.min(base + Math.random() * BACKOFF_JITTER_MS, MAX_RETRY_AFTER_MS);
}

async function requestJson(
  url: string,
  init: RequestInit,
  label: string,
  deps: SummaryDeps,
): Promise<{ ok: true; body: unknown } | { ok: false; error: string }> {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      // Network-level failure: worth one more try, then give up quietly. One
      // record lost is a bookmark with no summary, which is the ordinary state
      // of a background pass — not a failure.
      if (attempt === MAX_ATTEMPTS) return { ok: false, error: `${label} request failed: ${errorMessage(error)}` };
      await sleep(backoffDelay(attempt, null));
      continue;
    }
    if (response.ok) {
      try {
        return { ok: true, body: await response.json() };
      } catch (error) {
        return { ok: false, error: `${label} returned malformed JSON: ${errorMessage(error)}` };
      }
    }
    if (!RETRY_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
      return { ok: false, error: `${label} request failed: ${response.status}` };
    }
    await sleep(backoffDelay(attempt, response.headers.get("retry-after")));
  }
  return { ok: false, error: `${label} request failed` };
}

/** gpt-5 and the o-series reason before they answer, and the gpt-4 family
 *  answers 400 on the parameter at all. Same branch as ai.ts. */
function usesReasoning(model: string): boolean {
  return /^gpt-5|^o[1-9]/.test(model);
}

/**
 * One summary, from whichever proposer is configured. Never throws, and its
 * errors are strings rather than exceptions so a failed record can be reported
 * as `skipped` next to the ones that worked.
 */
async function generateSummary(
  prompt: SummaryPrompt,
  proposer: ResolvedProposer,
  model: string,
  deps: SummaryDeps,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  if (proposer.provider === "openai") {
    const result = await requestJson(
      OPENAI_ENDPOINT,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${proposer.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          ...(usesReasoning(model) ? { reasoning_effort: "minimal" } : {}),
          max_completion_tokens: MAX_COMPLETION_TOKENS,
          // No `response_format`, unlike ai.ts: the payload here is prose, and a
          // JSON envelope would only give the model a way to fail.
          messages: [
            { role: "system", content: prompt.system },
            { role: "user", content: prompt.user },
          ],
        }),
      },
      "OpenAI",
      deps,
    );
    if (!result.ok) return result;
    const body = result.body as { choices?: Array<{ message?: { content?: unknown } }> };
    const text = cleanText(body.choices?.[0]?.message?.content);
    return text ? { ok: true, text } : { ok: false, error: "OpenAI returned no content" };
  }

  const result = await requestJson(
    `${GEMINI_ENDPOINT}/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(proposer.apiKey)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: prompt.system }] },
        contents: [{ role: "user", parts: [{ text: prompt.user }] }],
        generationConfig: { maxOutputTokens: MAX_COMPLETION_TOKENS, temperature: 0.2 },
      }),
    },
    "Gemini",
    deps,
  );
  if (!result.ok) return result;
  const body = result.body as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }>;
  };
  const text = cleanText(body.candidates?.[0]?.content?.parts?.[0]?.text);
  return text ? { ok: true, text } : { ok: false, error: "Gemini returned no content" };
}

// -- persistence --

/**
 * The records the server already has, read by id.
 *
 * The client does not re-send any content: `POST /api/sync` has been carrying
 * every bookmark since before this feature existed, and asking for the same
 * text twice would put the whole library over the wire again for no reason.
 *
 * Tombstones are read rather than filtered out, so a soft-deleted bookmark comes
 * back as `deleted` instead of `not-found` — different answers, and the pass
 * counts them separately.
 */
async function readRecords(
  pool: Pool,
  userId: string,
  ids: readonly string[],
): Promise<SummaryRecord[]> {
  const result = await pool.query<{ id: string; data: Record<string, unknown>; deleted_at: string | null }>(
    `SELECT id, data, deleted_at FROM nook_records
     WHERE user_id=$1 AND kind='bookmark' AND id = ANY($2::text[])`,
    [userId, [...ids]],
  );
  return result.rows.map((row) => ({ id: row.id, data: row.data ?? {}, deletedAt: row.deleted_at }));
}

// -- the pass --

function emptyResponse(model: string): SummarizeResponse {
  return { summaries: [], skipped: [], model };
}

function uniqueIds(ids: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of ids) {
    if (typeof entry !== "string") continue;
    const id = entry.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

type SingleOutcome = { id: string; summary: string } | { id: string; reason: SummarySkipReason };

/** One record's whole trip. `empty-output` and `failed` are kept apart because
 *  they mean different things to a retry: one is a model that declined, the
 *  other is a model that could not be reached. */
async function summarizeOne(
  record: SummaryRecord,
  proposer: ResolvedProposer,
  model: string,
  deps: SummaryDeps,
): Promise<SingleOutcome> {
  const generated = await generateSummary(buildSummaryPrompt(record), proposer, model, deps);
  if (!generated.ok) {
    console.warn(`[summarize] ${record.id} failed: ${generated.error}`);
    return { id: record.id, reason: "failed" };
  }
  const summary = cleanSummary(generated.text);
  if (!summary) {
    console.warn(`[summarize] ${record.id} returned nothing usable`);
    return { id: record.id, reason: "empty-output" };
  }
  return { id: record.id, summary };
}

/**
 * Summarise the requested bookmarks, in a window of concurrent calls.
 *
 * **This function used to carry a long argument that the server must not write
 * `summary` anywhere, and that argument is now wrong.** It was not a small
 * correction, so here is what happened to it rather than a deletion — three of its
 * four reasons did not survive the pass moving server-side, and the fourth never
 * applied.
 *
 * - *"A summary is user-visible prose, not derived data like a vector. The client
 *   owns it: it shows it, the user can delete or re-run it, and signing out has to
 *   take it with everything else on that device."* — **Half right, and the half
 *   that is right is why the work list is shaped the way it is.** Two of the three
 *   claims survive: the user can still clear a summary, and they can still
 *   re-run one. The third does not: a summary is a *synced* field, so signing out
 *   on a device has never taken it off the server or off the other devices, and
 *   never did for a note. `apps/extension/lib/types.ts` still says `null` and `""`
 *   both mean "no summary, so a cleared one is summarised again", and that remains
 *   the behaviour — the user's own words, unchanged, and the reason the memory of
 *   a written summary is *deleted* rather than kept. See `nook_ai_summaries` in
 *   schema.sql, and the note on `summaryWriteGuard` in ai-summary.ts for what the
 *   write path does and does not re-check.
 * - *"Going through `POST /api/sync` is what puts the summary on every device. A
 *   server-side write would have to invent a second push path."* — **False, and
 *   false for a long time.** There is no second push path and none was invented.
 *   There is exactly the one the classification write already uses: bump the
 *   version, and let the ordinary sync pull carry it. The premise underneath it —
 *   that the device which asked for the summary still held the record the merge
 *   is computed over — stopped being true the moment the pass stopped running in
 *   the extension's service worker.
 * - *"A write here would move the record's version, and every other device would
 *   pull a change it never made."* — **True, and deliberate, and identical to what
 *   a classification write already does** on the same record, under the same
 *   advisory lock, for the same reason. The pass runs where the library is; a
 *   device that did not make the change learning about it through the ordinary
 *   pull is what sync is for, and `AiAttribution` set the precedent a release
 *   earlier.
 * - *"...and it would also break the merge rule this field exists to get:
 *   newer-wins on `summary` itself, which only runs if the client is the author."*
 *   — **This one was already wrong when it was written.** `summary` is top-level
 *   and not in `BOOKMARK_SPECIAL_KEYS`, so `mergeBookmarks` has always given it a
 *   generic newer-wins whichever side authored it. The server is simply the newest
 *   side, which is the case newer-wins exists to resolve.
 *
 * The rule that made the old design coherent — the client owns the write, so the
 * device that asks holds the record the merge is computed over — is the thing
 * that no longer holds, and it is the only thing that ever made all four reasons
 * fit together. What replaces it is the write path in `ai-jobs.ts`: the same
 * advisory lock a sync takes, `FOR UPDATE`, a guard re-evaluated on the row
 * re-read inside the lock, and a patch recomputed from that row. So the deletion
 * case — the one genuine hazard the old comment was reaching for — is now handled
 * by re-reading rather than by not writing at all, which is a stronger answer
 * than the one it replaced.
 *
 * This function still does not write anything: it returns what the model said, and
 * `ai-summary.ts` is what writes it. That split is the same one `ai-jobs.ts` keeps
 * between `classifyBookmarkOutcome` and `applyClassificationPatch`, and for the
 * same reason — a function that both calls a model and writes a record is a
 * function with two reasons to change.
 *
 * Degrades rather than throws, and a database error is the one thing that does
 * propagate — there is nothing to degrade to when the records could not be read
 * at all, and a pass that has billed nothing should still say so rather than
 * answer with a confident empty batch.
 */
export async function summarizeRecords(
  pool: Pool,
  userId: string,
  ids: readonly string[],
  deps: SummaryDeps = {},
): Promise<SummarizeResponse> {
  // Resolved once and derived from, rather than through `summarizeAvailability`,
  // so the model reported back and the model actually called cannot disagree —
  // the failure that would otherwise show up as a summary attributed to a model
  // that was never asked. `ai-summary.ts` reports this same `model` in the status
  // row, which is the other half of why it has to be the one value.
  const proposer = resolveProposer();
  const model = summaryModel(proposer?.provider ?? null);
  // The per-pass ceiling, applied here rather than by a route: the ids arrive from
  // the worker's plan, and the caller's own batch is already under it.
  const wanted = uniqueIds(ids).slice(0, MAX_IDS_ACCEPTED);
  if (wanted.length === 0) return emptyResponse(model);

  // Checked before the read: an unconfigured optional feature must not become a
  // red error on the Settings screen, and there is nothing to read for.
  if (!proposer) {
    console.warn("[summarize] no proposer configured; set NOOK_AI_PROPOSER and its API key");
    return {
      summaries: [],
      skipped: wanted.map((id) => ({ id, reason: "unavailable" })),
      model: UNAVAILABLE_MODEL,
    };
  }

  const records = await readRecords(pool, userId, wanted);
  const byId = new Map(records.map((record) => [record.id, record]));
  // The stored record says what has been synced; the caller may know about a
  // summary it wrote that has not landed yet. Both are answers to "does this
  // already have one", and taking only the first re-bills the same summary on
  // every run.
  const alreadyDone = new Set(
    records.filter((record) => hasSummary(record)).map((record) => record.id),
  );
  const todo = planSummaries(records, alreadyDone);

  const skipped = new Map<string, SummarySkipReason>();
  for (const id of wanted) {
    const record = byId.get(id);
    if (!record) {
      skipped.set(id, "not-found");
      continue;
    }
    const reason = alreadyDone.has(id) ? "already-summarised" : summarySkipReason(record);
    if (reason) skipped.set(id, reason);
  }

  // Only the ids with text go to the model, in one deterministic order.
  const work = todo
    .map((id) => byId.get(id))
    .filter((record): record is SummaryRecord => record !== undefined);
  const done = new Map<string, string>();
  for (const window of chunk(work, SUMMARY_CONCURRENCY)) {
    const settled = await Promise.all(window.map((record) => summarizeOne(record, proposer, model, deps)));
    for (const outcome of settled) {
      if ("summary" in outcome) done.set(outcome.id, outcome.summary);
      else skipped.set(outcome.id, outcome.reason);
    }
  }

  // In the order the caller asked, so a runner paging through a library can read
  // the response as the page it sent.
  return {
    summaries: wanted
      .filter((id) => done.has(id))
      .map((id) => ({ id, summary: done.get(id) as string })),
    skipped: wanted
      .filter((id) => skipped.has(id))
      .map((id) => ({ id, reason: skipped.get(id) as SummarySkipReason })),
    model,
  };
}
