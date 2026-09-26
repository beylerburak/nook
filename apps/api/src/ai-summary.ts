/**
 * The summarisation pass, on the server: the work list, the memory of what has
 * already been bought, the batch, the writes, and the tick's summarisation half.
 *
 * This is the second half of the job `docs/ai-cloud-contract.md` did for
 * classification, and it is deliberately the same shape rather than a variation
 * on it. `autoSummarize` has been a real field of the account's settings row and
 * a switch in Settings → AI on both hosts for the life of the product, and
 * nothing has ever acted on it; `POST /api/summarize` had no caller anywhere, and
 * what it did have was a documented contract — *"the server does not write
 * `summary` anywhere, and that is the design"* — that the move made false. See
 * the note on `summarizeRecords` in ./summarize.ts for what happened to that
 * argument, item by item, and `docs/ai-summarize-contract.md` for the seam.
 *
 * Three properties outrank everything else here, and all three exist because of
 * money or because of a user:
 *
 * - **A summary has to stay re-writable.** Everything else about this feature is
 *   ordinary; this is the part that is genuinely hard. `nook_ai_summaries` may not
 *   be a permanent "already tried" marker the way `nook_ai_decided` is for
 *   classification, because a marker that outlived the summary would make a
 *   summary undeletable in the only sense that matters: the user clears it, and it
 *   does not come back. The row is therefore written **only** for an attempt that
 *   produced nothing, and **deleted** the moment a summary is written — so clearing
 *   a summary leaves no memory behind and the record is summarised again, which is
 *   the documented meaning of `null` and `""`
 *   (`apps/extension/lib/types.ts`). The content hash is what makes "this exact
 *   text" mean *the text*: it covers `title`, `description` and `note` and
 *   **deliberately not `summary`**, so it moves when the user edits their note —
 *   the summary on the record would otherwise be of something else — and does not
 *   move when a summary is written onto it, so the memory can never mistake our
 *   own write for a change in the source.
 * - **A model that declined and a network that failed are different answers.**
 *   `empty-output` means the text was read and the model had nothing to say about
 *   it, so asking again in a minute gets the same answer: seven days.
 *   `failed` means a request never landed, which is transient and is not the
 *   model's opinion of anything: thirty minutes. Everything else is *not an
 *   attempt* and leaves no row at all, which is what lets a 380-character
 *   description that grows past 400 be picked up on the very next tick instead of
 *   a week later. See `summaryOutcomeWindow`.
 * - **Nothing here throws.** Every export degrades. This runs from a bare
 *   `setInterval` and from a detached `void`, where a rejection is an unhandled
 *   rejection and an unhandled rejection is a dead process.
 *
 * The prose — the prompt, the length gate, the post-processing, the measured
 * numbers — is not here and was not touched. `summarize.ts` owns all of it and
 * this module calls into it, which is the same split `ai-jobs.ts` keeps between
 * `ai.ts` and itself.
 *
 * On cost: at `gpt-4o-mini` ($0.15/1M in, $0.60/1M out) a call is roughly
 * 1,000–1,300 input tokens and about 100 output, so ≈$0.00026 per bookmark — about
 * 4× a classification call, and bounded by the *library* rather than by the tick.
 * A full pass over 5,000 bookmarks with a third of them clearing the 400-character
 * gate is about $0.43. There is deliberately **no spend cap**: embeddings and
 * classification have none either, and a cap introduced for one feature and not
 * the others is a worse surprise than the bill it prevents. The batch size and the
 * decline memory are the controls.
 */

// The one dependency on ./ai-jobs.js is deliberate: `applyServerWrite` is the
// shared conflict-safe write path and it lives beside the classification caller
// that established it. ai-jobs imports this module back, for the tick, so the two
// are a cycle — safe because every use on both sides is inside a function body and
// neither module does anything at load time, and worth the alternative, which is a
// second copy of a transaction that must not be copied.
import type { Pool } from "pg";
import { getAiUserSettings } from "./ai-settings.js";
import { applyServerWrite, type ServerRecord } from "./ai-jobs.js";
import {
  AI_BACKOFF_BASE_MS,
  AI_BACKOFF_CAP_MS,
  AI_UNAVAILABLE_COOLDOWN_MS,
  acquireRunLease,
  activeCooldownBetween,
  inEffect,
  readRunState,
  releaseRunLease,
  writeSummarizeRunState,
  type SummarizeRunState,
  type SummarizeStatus,
} from "./ai-store.js";
import { contentHash } from "./embeddings.js";
import {
  buildSummaryPrompt,
  hasSummary,
  isWorthSummarising,
  MAX_IDS_ACCEPTED,
  MIN_SUMMARISABLE_CHARS,
  summarizeAvailability,
  summarizeRecords,
  summarySkipReason,
  UNAVAILABLE_MODEL,
  type SummaryDeps,
  type SummaryRecord,
  type SummarySkipReason,
} from "./summarize.js";

// -- configuration --------------------------------------------------------

/**
 * Bookmarks summarised per pass, overridable with `NOOK_AI_SUMMARY_BATCH`.
 *
 * The same number and the same reasoning as `CLASSIFY_BATCH_SIZE`: 25 bounds a
 * pass's wall clock, its spend and what the panel can attribute to one run, and
 * it is not a throughput limit — cost is per bookmark, not per tick, so a
 * 1,000-bookmark library costs the same whether it clears in 40 minutes or in
 * 3.5 hours. The concurrency is `SUMMARY_CONCURRENCY` (4) inside
 * `summarizeRecords`, also unchanged and for the same reason it was not raised:
 * a shared proposer's rate limit is the constraint.
 *
 * There is no spend cap and no per-account budget. See the file header.
 */
export const SUMMARY_BATCH_SIZE = 25;

/**
 * How long a *failed* call is remembered, overridable with
 * `NOOK_AI_SUMMARY_RETRY_MS`. Thirty minutes because a transport error or a 429
 * is transient and carries no information about the text: the next attempt
 * should not be more expensive to justify, and should not be a week away either.
 */
export const SUMMARY_RETRY_MS = 30 * 60_000;

/**
 * How long a *declined* text is remembered, overridable with
 * `NOOK_AI_SUMMARY_DECLINE_MS`. Seven days because the model read the text and
 * had nothing to say about it. The text does not change on its own, and asking
 * again the same question gets the same empty answer at full price — this is the
 * row that stops a library of 400-character-plus X posts from being re-bought
 * every half hour forever.
 */
export const SUMMARY_DECLINE_MS = 7 * 24 * 60 * 60_000;

function envMs(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  // Not floored at a second the way the tick interval is: there is no spin loop
  // to protect here, but a zero would be a rule that says "ask about this again
  // immediately", which is the one value an operator must not be able to set by
  // accident.
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.floor(parsed);
}

function batchSize(): number {
  // Clamped to the per-call ceiling in `summarizeRecords`, so an over-eager
  // `NOOK_AI_SUMMARY_BATCH` is refused at the one place that knows the limit rather
  // than silently truncating the tail of every pass — the ids past the ceiling
  // would be planned, not called, and would come back as candidates next tick.
  return Math.min(envMs("NOOK_AI_SUMMARY_BATCH", SUMMARY_BATCH_SIZE), MAX_IDS_ACCEPTED);
}

function retryMs(): number {
  return envMs("NOOK_AI_SUMMARY_RETRY_MS", SUMMARY_RETRY_MS);
}

function declineMs(): number {
  return envMs("NOOK_AI_SUMMARY_DECLINE_MS", SUMMARY_DECLINE_MS);
}

/** Postgres interval literal for a millisecond span. A parameter rather than an
 *  interpolation: this one *is* a value, unlike the identifier in the lease. */
function intervalLiteral(ms: number): string {
  return `${Math.floor(ms / 1000)} seconds`;
}

// -- public types ---------------------------------------------------------

/** What one pass did. `ran` is false when a gate declined to start one — the lease
 *  was held elsewhere, the toggle is off, a cooldown is in effect, or there was
 *  nothing to summarise — which is the common case and not a failure. The
 *  counters are this pass's, not the account's totals; those live in
 *  `nook_ai_state` and are read back by the status route. */
export interface SummaryPassResult {
  ran: boolean;
  /** Summaries the model actually produced. */
  processed: number;
  /** Of those, the ones that reached a record. The gap is a user who won a race. */
  written: number;
  /** Everything in the batch that was not written, for any reason. */
  skipped: number;
  error?: string;
}

/**
 * Injectable so the pass can be tested with no network, no key and no real
 * clock — the three things every one of its tests would otherwise have to fake.
 * There is no `newId`: this pass mints no identifier. Every row it writes is
 * keyed by a `bookmark_id` it read out of `nook_records`, which is the other half
 * of why the attempt table is keyed that way.
 */
export interface SummaryJobDeps {
  now?: () => number;
  fetch?: SummaryDeps["fetch"];
  sleep?: SummaryDeps["sleep"];
}

/** One row of `nook_ai_summaries`, which is a memory of an attempt rather than a
 *  queue: the row exists because a call was made and produced nothing. */
export interface SummaryAttempt {
  /** sha256 of the prompt's own text for the record as it was when we asked. */
  contentHash: string;
  /** ISO of the attempt. The only clock the retry window is measured from. */
  at: string;
  /** Which window applies. See `SummaryOutcomeWindow` on why this is stored. */
  outcome: SummaryOutcome;
}

/** The two outcomes that are attempts. Everything else in `SummarySkipReason`
 *  describes a record we never asked the model about, and leaves no row. */
export type SummaryOutcome = "declined" | "failed";

/** `GET /api/ai/status`'s `summarize`. Declared in ai-store.ts beside the rest of
 *  the wire shapes and re-exported here because this is the module that fills
 *  it; a reader looking for the summarisation status finds it in both, which is
 *  the lesser of the two duplications the type system cannot avoid. */
export type { SummarizeStatus } from "./ai-store.js";

// -- small helpers --------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function countOr(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value > 0 ? Math.floor(value) : 0;
}

/** The candidate's own hash, from the row the work list read. See the note in
 *  `runSummarizationPass` on why a hash from *this* read is the safe one. */
function hashOf(record: SummaryRecord): string {
  return summaryContentHash(record.data ?? {});
}

function asSummaryRecord(row: ServerRecord): SummaryRecord {
  return { id: row.id, data: row.data, deletedAt: row.deletedAt };
}

// -- pure: the text a summary is of ---------------------------------------

/**
 * The exact text a summary would be asked for, as one string.
 *
 * **This is the prompt's own user half, not a second rendering of the record.**
 * `buildSummaryPrompt` is the measured, tested thing that decides what the model
 * reads — which fields, in which order, with which per-field caps and which
 * `shortDescription` fallback — and a hash taken over anything else would be a
 * second implementation of a rule that has to be identical to the first. The two
 * would drift the moment a cap moved, and the drift would be invisible: the
 * summary would be considered stale (or current) against text the model never
 * saw.
 *
 * `summary` is absent from that text, and that is the load-bearing part. It is not
 * a field the prompt reads, and more importantly it is the one field whose
 * presence must not decide whether we ask again: a hash taken over the record
 * would change every time a summary landed on it, so every write would look like
 * a change in the source and the attempt memory would never suppress anything.
 * Hashing the text means the memory answers exactly one question — "have we
 * already asked about *this*?" — which is the only question it is there to answer.
 */
export function summarySourceText(data: Record<string, unknown>): string {
  return buildSummaryPrompt({ id: "", data: data ?? {} }).user;
}

/**
 * sha256 over `summarySourceText`, and the whole of the work list's memory.
 *
 * The same function `embeddings.ts` takes the embedded text to, deliberately
 * rather than for brevity: this is that content-hash discipline applied to prose
 * instead of vectors, and the point of it is identical. A second pass over an
 * unchanged library costs zero requests because the hash matches, and a changed
 * note costs exactly one because it does not.
 */
export function summaryContentHash(data: Record<string, unknown>): string {
  return contentHash(summarySourceText(data));
}

// -- pure: the retry window ------------------------------------------------

/**
 * The earliest moment this outcome may be asked about again, in ms since the
 * epoch — or `0` when the outcome is not an attempt and the record therefore
 * carries no memory at all.
 *
 * Returning an absolute deadline rather than a duration is what lets
 * `planSummaryWork` be one comparison: the stored row says *when we asked* and
 * this says *when we may*, and a row with an unparseable `at` therefore falls out
 * as due rather than needing a special case.
 *
 * The two that have a window are the two where a repeat call buys nothing:
 *
 * - `empty-output` → **seven days.** The model read the text and declined. The
 *   text has not changed and asking the same question again gets the same answer
 *   at full price, so this is not a retry policy at all — it is the bill. A
 *   shorter window here does not make the feature more reliable, it makes it
 *   re-buy every text the model has already declined.
 * - `failed` → **thirty minutes.** A timeout, a 429, a dropped socket. Nothing
 *   was learned about the text, and this is emphatically *not* the model's
 *   opinion of it, so it gets the same short window a throttled classification
 *   call gets.
 *
 * Everything else is `0`, and that is the part worth being careful about.
 * `too-short`, `already-summarised`, `not-found`, `deleted` and `unavailable` are
 * all **not attempts**: no call was made, so there is nothing to remember and
 * writing a row would *invent* a memory. The concrete case is `too-short` — a
 * 380-character description is refused by the gate, and if refusing it left a row
 * the record would be parked for seven days after the user added a paragraph that
 * took it past 400. `unavailable` is the same argument at a different scale: the
 * pass-level cooldown in `nook_ai_state` parks the whole account for an hour, so
 * a per-record row would buy nothing and hide the deployment state behind 500
 * identical rows.
 */
export function summaryOutcomeWindow(outcome: SummaryOutcome | SummarySkipReason, nowMs: number): number {
  // "declined" is the column's word for "empty-output", the response's. Accepting
  // both is what lets this one function answer both questions it is asked — "how
  // long does this refusal park the record?" when a pass is deciding whether to
  // write a row, and "when is this stored row due?" when a plan is reading one —
  // without a caller having to remember to translate.
  if (outcome === "empty-output" || outcome === "declined") return nowMs + declineMs();
  if (outcome === "failed") return nowMs + retryMs();
  return 0;
}

/** The column value for an outcome, and `null` for one that leaves no row. */
function attemptOutcomeFor(reason: SummarySkipReason): SummaryOutcome | null {
  if (reason === "empty-output") return "declined";
  if (reason === "failed") return "failed";
  return null;
}

// -- pure: the work plan ---------------------------------------------------

/**
 * The ids worth a request, given what has already been asked about. Pure and
 * total, in the style of `planSummaries` and `planEmbeddingWork`: a record with
 * no usable id is ignored rather than thrown on, and an attempt row that is
 * malformed is treated as no attempt at all rather than as a permanent block.
 *
 * **This is the authority, and the SQL that fed it is not.** The candidate query
 * is an index-friendly pre-filter and there are three things it cannot express
 * exactly, all of which land here:
 *
 * 1. *The content hash.* Postgres has no sha256 for text without an extension,
 *    and computing one here would mean re-implementing `summarySourceText` in
 *    SQL — a second copy of the prompt's own field order and caps, which is the
 *    drift this file exists to prevent. So the query excludes a record whose
 *    attempt is still inside the *short* window and leaves the rest to this
 *    function. The consequence is a delay and never a wrong answer: a record
 *    whose text you edited is picked up once its attempt is
 *    `NOOK_AI_SUMMARY_RETRY_MS` old instead of instantly. The opposite
 *    approximation — filtering on the long window in SQL — would park an edited
 *    note for seven days, which is a visible bug, and this direction is also
 *    bounded by the newest-first `ORDER BY`, so a fresh save is never the thing
 *    that waits.
 * 2. *The length gate.* The query interpolates the same
 *    `MIN_SUMMARISABLE_CHARS` from the same place, so it cannot drift, and
 *    `summarySkipReason` re-applies it anyway over the batch. A filter that is
 *    somehow too wide costs a SELECT; a filter that is too narrow would cost a
 *    missed summary, which is why the plan is the one that gets the last word.
 * 3. *Which window applies.* The query only knows the short one; the long one
 *    for a decline is `summaryOutcomeWindow`'s business.
 *
 * So: eligible by the existing gate (`summarySkipReason` is the tested rule and
 * is not re-implemented), and then either nothing was ever attempted on this
 * exact text, or the last attempt was long enough ago to be worth repeating.
 */
export function planSummaryWork(
  records: readonly SummaryRecord[],
  attempts: ReadonlyMap<string, SummaryAttempt>,
  nowMs: number,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (!record || typeof record.id !== "string" || record.id === "") continue;
    if (seen.has(record.id)) continue;
    if (summarySkipReason(record) !== null) continue;
    seen.add(record.id);

    const attempt = attempts.get(record.id);
    if (attempt) {
      // A different hash means the stored answer is about text that no longer
      // exists, so it says nothing about this one. That is the rule behind the
      // edited note: you changed what you saved, and the summary on the record
      // would otherwise be of something else. Note the other direction is not
      // possible — writing a summary cannot change this hash, so a write can never
      // present itself as a change in the source.
      if (attempt.contentHash !== hashOf(record)) {
        ids.push(record.id);
        continue;
      }
      const askedAt = Date.parse(attempt.at);
      const due = Number.isNaN(askedAt) ? 0 : summaryOutcomeWindow(attempt.outcome, askedAt);
      // A row whose outcome is not one of the two we write is treated as due
      // rather than as a block, for the same reason a malformed date is: a row
      // nothing can read must not park a record forever.
      if (nowMs < due) continue;
    }
    ids.push(record.id);
  }
  return ids;
}

// -- the work list --------------------------------------------------------

/**
 * The candidate rule, written once and used twice: by the top-up that the tick
 * calls and by the count the status route reports. Two copies of a rule that has
 * to be identical is the failure this repo keeps warning about — the reconciler's
 * exclusions are SQL precisely so they *are* the plan — and here the second
 * reader is the panel, which would otherwise show a queue depth the worker is
 * not going to drain.
 *
 * `MIN_SUMMARISABLE_CHARS` is interpolated rather than parameterised, which is
 * the one value in this file that is written into SQL text. It is a module-level
 * `const` number read out of another module at load, not a request value, so
 * there is nothing to sanitise; and interpolating it is what keeps the SQL copy
 * of the 400-character rule from becoming a second place it can drift.
 *
 * Every clause is a reason not to *buy a call*:
 *
 * - `kind='bookmark' AND deleted_at IS NULL` — a collection is not a candidate
 *   and a deleted bookmark never will be. `applyServerWrite` re-checks the
 *   tombstone, but paying for a call to find that out would be silly.
 * - `coalesce(btrim(data->>'summary'), '') = ''` — the documented semantics of
 *   `null` and `""` are both "no summary": a cleared one is summarised again
 *   rather than merged as a permanent blank. `btrim` so a whitespace-only summary
 *   is the same answer as none, which is what `cleanText` says on the JS side.
 * - the length filter, above.
 * - the attempt exclusion, above. `NOT IN` rather than a `LEFT JOIN` because
 *   `bookmark_id` is `NOT NULL` on both sides, so the `NOT IN` null trap cannot
 *   fire, and because the planner can hash this one once instead of probing
 *   per row: measured against Postgres 17, the whole top-up is a single ordered
 *   index scan on `nook_records_ai_summary_candidates_idx` that stops after 25
 *   rows, with no sort node — 0.20ms on a measured 1,061-record library and
 *   0.14ms on a 60,000-record one. A `LEFT JOIN` chose a hash join and a sort,
 *   which returns the same rows for 1.4ms and has to look at all of them first.
 * - `autoSummarize`, inside the statement rather than read first, for the reason
 *   `enqueueClassification` carries it inside its own: the decision has to be the
 *   newest one, and the status route must never report a queue the worker will
 *   not drain.
 *
 * **There is deliberately no lease clause here, and the classification top-up has
 * one.** That top-up *inserts*, and a row it added for a record the running pass
 * is holding is a second decision waiting to be bought — so it has to ask. This
 * one only reads, and the pass that acts on the answer takes the lease for itself:
 * a record offered while another pass holds the lease is simply not picked up,
 * because the second pass declines to start. The first version of this query
 * carried the guard anyway, and the effect was that the pass's own read saw
 * nothing — it holds the lease for the whole of its own work, so it filtered out
 * its own candidates. A guard that has to be re-derived per caller is a guard
 * somebody will get wrong; the lease is the whole mechanism here, and one thing
 * that does it is better than two things where one of them lies.
 */
const SUMMARY_CANDIDATE_WHERE = `r.user_id = $1
          AND r.kind = 'bookmark'
          AND r.deleted_at IS NULL
          AND coalesce(btrim(r.data->>'summary'), '') = ''
          AND length(coalesce(r.data->>'description', '')) > ${MIN_SUMMARISABLE_CHARS}
          AND r.id NOT IN (
            SELECT s.bookmark_id FROM nook_ai_summaries s
            WHERE s.user_id = $1 AND s.at >= now() - $2::interval
          )
          AND EXISTS (
            SELECT 1 FROM nook_ai_settings st
            WHERE st.user_id = $1 AND coalesce((st.data->>'autoSummarize')::boolean, false)
          )`;

const SUMMARY_CANDIDATES_SQL = `SELECT r.id, r.data, r.deleted_at
     FROM nook_records r
     WHERE ${SUMMARY_CANDIDATE_WHERE}
     ORDER BY COALESCE(r.data->>'savedAt', r.data->>'createdAt', r.data->>'updatedAt') DESC NULLS LAST
     LIMIT $3`;

/**
 * `summarised` and `pending`, as exact counts.
 *
 * One statement, and the two numbers therefore come from one snapshot — a panel
 * that showed 40 summarised and 41 pending from two reads taken a few
 * milliseconds apart would be reporting an arithmetic error as a fact. It also
 * carries the settings guard, which is why `pending` is a number the worker can
 * actually act on rather than a bound.
 *
 * These are the two counts that are honestly answerable. The panel used to
 * compute this row from its own library, which could only ever produce an
 * *upper* bound: it counted every record with no summary, including the ones the
 * 400-character gate would never accept, and had to say so in the copy. The
 * server can apply the same gate in the query, so the hedge is gone.
 *
 * Cost, measured on Postgres 17 with this exact statement: **0.8ms** on a
 * 1,061-record library, which is the shape the product actually has. At 60,000
 * records it is 47ms — 15ms to find the 3,000 records that carry a summary and
 * 30ms to walk 57,000 index entries to count 15,000 candidates — which is why
 * this lives on a route the panel reads and not on the tick, and why `pending` is
 * not a number anything writes.
 */
export async function countSummarizeStatus(
  pool: Pool,
  userId: string,
): Promise<{ summarised: number; pending: number }> {
  const result = await pool.query<{ summarised: number; pending: number }>(
    `SELECT
       (SELECT count(*)::int FROM nook_records r
         WHERE r.user_id = $1
           AND r.kind = 'bookmark'
           AND r.deleted_at IS NULL
           AND coalesce(btrim(r.data->>'summary'), '') <> '') AS summarised,
       (SELECT count(*)::int FROM nook_records r WHERE ${SUMMARY_CANDIDATE_WHERE}) AS pending`,
    [userId, intervalLiteral(retryMs())],
  );
  return {
    summarised: countOr(result.rows[0]?.summarised),
    pending: countOr(result.rows[0]?.pending),
  };
}

interface CandidateRow {
  id: string;
  data: Record<string, unknown>;
  deleted_at: string | null;
}

/**
 * The work list, read. This *is* the queue: there is nothing to insert, because a
 * candidate is a candidate at every moment and a row claiming one would be a
 * second thing to keep in step with the record. The classification pass needs a
 * table because a decision is bought once and the queue row is how that is
 * enforced; here the attempt table is the memory and the record itself is the
 * claim.
 */
async function readSummaryCandidates(pool: Pool, userId: string, limit: number): Promise<SummaryRecord[]> {
  const batch = Math.max(0, Math.floor(limit));
  if (batch === 0) return [];
  const result = await pool.query<CandidateRow>(SUMMARY_CANDIDATES_SQL, [userId, intervalLiteral(retryMs()), batch]);
  return result.rows.map((row) => ({ id: row.id, data: row.data ?? {}, deletedAt: row.deleted_at }));
}

/**
 * How many bookmarks are waiting. `POST /api/ai/run`'s `summariesQueued`, and the
 * tick's way of asking the same question.
 *
 * Named for its sibling rather than for what it does, because what it does is
 * *read* the work list rather than fill one, and the number is the direct
 * analogue of a queue depth: candidates the next pass would take. Never rejects,
 * for the reason every function in this file does not: the schema may still be
 * applying, and a tick that has to survive that is the point of degrading.
 */
export async function topUpSummaryQueue(
  pool: Pool,
  userId: string,
  limit: number = batchSize(),
): Promise<number> {
  try {
    return (await readSummaryCandidates(pool, userId, limit)).length;
  } catch (error) {
    console.warn(`[ai-summary] could not read the work list for ${userId}: ${errorMessage(error)}`);
    return 0;
  }
}

// -- the attempt memory ----------------------------------------------------

async function readAttempts(
  pool: Pool,
  userId: string,
  ids: readonly string[],
): Promise<Map<string, SummaryAttempt>> {
  if (ids.length === 0) return new Map();
  const result = await pool.query<{ bookmark_id: string; content_hash: string; at: string; outcome: SummaryOutcome }>(
    `SELECT bookmark_id, content_hash, at, outcome FROM nook_ai_summaries
     WHERE user_id = $1 AND bookmark_id = ANY($2::text[])`,
    [userId, [...ids]],
  );
  return new Map(
    result.rows.map((row) => [row.bookmark_id, { contentHash: row.content_hash, at: row.at, outcome: row.outcome }]),
  );
}

/** `at` is `now()` and not the pass's clock: the window is measured from when the
 *  attempt happened, and the pass's `now` is a test's injected constant.
 *
 *  One statement for the whole batch, as `rememberDecided` does, because 25 round
 *  trips to record 25 refusals is a pass whose bookkeeping costs more than its
 *  model calls. `unnest` pairs the ids with their hashes and outcomes by
 *  position, which is the same reason `indexRecords` carries an offset rather
 *  than recovering it: a duplicated id in the array would otherwise take two
 *  different hashes, and the later one silently wins. */
async function rememberAttempts(
  pool: Pool,
  userId: string,
  rows: ReadonlyArray<{ id: string; hash: string; outcome: SummaryOutcome }>,
): Promise<void> {
  if (rows.length === 0) return;
  await pool.query(
    `INSERT INTO nook_ai_summaries (user_id, bookmark_id, content_hash, at, outcome)
     SELECT $1, x.id, x.hash, now(), x.outcome::text
     FROM unnest($2::text[], $3::text[], $4::text[]) AS x(id, hash, outcome)
     ON CONFLICT (user_id, bookmark_id) DO UPDATE SET
       content_hash = EXCLUDED.content_hash,
       at = EXCLUDED.at,
       outcome = EXCLUDED.outcome`,
    [
      userId,
      rows.map((row) => row.id),
      rows.map((row) => row.hash),
      rows.map((row) => row.outcome),
    ],
  );
}

/** A written summary DELETEs its row, and that is what keeps a summary
 *  re-writable. With the row gone there is no memory of the attempt, so clearing
 *  the summary makes the record a candidate again — the documented behaviour of
 *  `null` and `""`. Keeping the row instead would freeze a cleared summary for the
 *  length of the window, which is the one thing this table must never be: a
 *  permanent "already tried" marker, like `nook_ai_decided`, is correct for a
 *  decision that may only be bought once and wrong for a field the user is allowed
 *  to clear. */
async function forgetAttempts(pool: Pool, userId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query("DELETE FROM nook_ai_summaries WHERE user_id = $1 AND bookmark_id = ANY($2::text[])", [
    userId,
    [...ids],
  ]);
}

/**
 * Drop the attempts whose bookmark is gone.
 *
 * The same argument as `pruneDecided`, and it runs on the reconciler's
 * 15-minute cadence rather than on every tick for the same reason: `at` and
 * `content_hash` of a record that no longer exists are not urgent, and a minute is
 * far too often to answer a question that is not. One row per bookmark, so the
 * table is bounded by the library rather than by the life of the account.
 */
export async function pruneSummaries(pool: Pool, userId: string): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM nook_ai_summaries d
       WHERE d.user_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM nook_records r
           WHERE r.user_id = d.user_id AND r.kind = 'bookmark' AND r.id = d.bookmark_id
             AND r.deleted_at IS NULL
         )`,
      [userId],
    );
    return result.rowCount ?? 0;
  } catch (error) {
    console.warn(`[ai-summary] could not prune summary attempts for ${userId}: ${errorMessage(error)}`);
    return 0;
  }
}

// -- the pass --------------------------------------------------------------

function passResult(): SummaryPassResult {
  return { ran: false, processed: 0, written: 0, skipped: 0 };
}

/**
 * The write guard, re-evaluated on the row `applyServerWrite` re-read inside the
 * lock. The same three questions `summarySkipReason` asks, on the only row where
 * an answer can still be true:
 *
 * - still live — the tombstone check happens before the guard is called, so this
 *   is about the summary and the gate;
 * - still no summary — a summary that arrived while the call was in flight wins.
 *   That is another pass on another replica, or a device that already had one and
 *   synced it in, and overwriting it would replace one model's words with
 *   another's on a record the user may be reading;
 * - still worth summarising — the description may have been shortened back under
 *   the gate while the request was out.
 *
 * **What is deliberately not here is a "the user cleared it" case**, because there
 * is not one: `null` and `""` both mean *no summary* on this field
 * (`apps/extension/lib/types.ts`), and a cleared summary is documented to be
 * summarised again. The hash is what keeps that honest in the other direction — a
 * cleared record looks like the same text, so the memory written for a *refusal*
 * is not what stops it, and the row a *written* summary deleted is. See the file
 * header.
 *
 * The hash is not re-checked here either. It does not need to be: the guard is
 * about the record, and the stored row is a statement about what we asked, which a
 * concurrent edit does not falsify — it makes the *next* pass re-ask, which is the
 * next pass's job.
 */
function summaryWriteGuard(row: ServerRecord): boolean {
  const record = asSummaryRecord(row);
  return !hasSummary(record) && isWorthSummarising(record);
}

/**
 * One summarisation pass for one account, in the order the gates require — the
 * same order `runClassificationPass` uses, for the same reasons.
 *
 * 1. **The lease**, on `summary_lease_until`. Two replicas must not run a pass for
 *    one account. What it protects is the expensive half — the work list, the
 *    model calls — and not the double buy: the content hash is, exactly as the
 *    claim in `nook_ai_jobs` is for classification. A lease that expires early
 *    costs a second pass finding an empty work list.
 * 2. **`autoSummarize`.** The gate a switch nobody acted on used to be.
 * 3. **The cooldowns**, the same two windows with the same two meanings: no
 *    `NOOK_AI_PROPOSER` key is a deployment state and gets a quiet hour, and an
 *    upstream that throttles or is unreachable gets an exponential backoff. They
 *    live in the sub-record because `readRunState` is the account's one state
 *    read and a second table would be a second thing to keep in step.
 * 4. **The work list, and then nothing.** An empty list returns *before* any
 *    request is built, which is the cost gate: once a minute, forever, is a lot
 *    of ticks with nothing in them, and this is the one place in the feature that
 *    spends money.
 * 5. `summarizeRecords`, which **re-reads the records and re-plans over them**.
 *    That is not a duplicate of steps 4 and the plan below; it is a second gate
 *    on a *later* read, and it is a good one. Between the work list and the call,
 *    the record can be deleted, tombstoned or summarised by something else, and
 *    `planSummaries` inside that function is the tested rule that catches all
 *    three. It also resolves the proposer and the model once for the whole batch
 *    and reports the model it actually called, so the status row and the
 *    summaries on the records cannot disagree about which model wrote them.
 * 6. One `applyServerWrite` per summary, with the guard above.
 * 7. The attempt memory: a written summary deletes its row, a declined or failed
 *    one upserts it, and the other five reasons write nothing.
 * 8. One state write: counters, the two windows, the last run.
 * 9. The lease, released in a `finally` so a failed pass does not park the
 *    feature for the length of the lease.
 *
 * Never rejects. The caller is a timer, and a pass that has already billed its
 * requests must not be undone by the exception that followed them.
 */
export async function runSummarizationPass(
  pool: Pool,
  userId: string,
  deps: SummaryJobDeps = {},
): Promise<SummaryPassResult> {
  const nowMs = (deps.now ?? Date.now)();
  const result = passResult();
  let held = false;

  try {
    held = await acquireRunLease(pool, userId, "summary_lease_until");
    if (!held) return result;

    const settings = await getAiUserSettings(pool, userId);
    if (!settings.autoSummarize) return result;

    const summarize: SummarizeRunState = (await readRunState(pool, userId)).summarize;
    if (activeCooldownBetween(summarize.unavailableUntil, summarize.backoffUntil, nowMs) !== null) return result;

    const candidates = await readSummaryCandidates(pool, userId, batchSize());
    // The cost gate. Everything below this line costs money.
    if (candidates.length === 0) return result;

    const attempts = await readAttempts(pool, userId, candidates.map((record) => record.id));
    const ids = planSummaryWork(candidates, attempts, nowMs);
    // The work list can be non-empty and the plan still empty: the query's attempt
    // filter is the *short* window, so a text declined an hour ago is offered here
    // and refused by `summaryOutcomeWindow`'s long one. That costs a SELECT per
    // such record per tick, and it is the price of the other direction of the
    // approximation, which is an edited note waiting a week.
    if (ids.length === 0) return result;

    const response = await summarizeRecords(pool, userId, ids, { fetch: deps.fetch, sleep: deps.sleep });
    const at = new Date(nowMs).toISOString();
    const byId = new Map(candidates.map((record) => [record.id, record]));
    const summarised: string[] = [];

    for (const summary of response.summaries) {
      result.processed++;
      const written = await applyServerWrite(pool, userId, "bookmark", summary.id, at, {
        guard: summaryWriteGuard,
        // A summary is a replacement, not a union, so this patch is the same
        // whatever the fresh row says — and that is the one place the two features
        // genuinely differ inside the shared seam. Classification has to *rebuild*
        // its patch from the row the lock handed it or it would clobber a tag the
        // user added in the meantime; there is nothing to clobber here, because
        // the only field this touches is the one the guard has just established is
        // empty. Which is not a reason to skip the guard: a second pass or a device
        // writing a summary in between is exactly what it catches.
        build: () => ({ summary: summary.summary }),
      });
      if (written.error) result.error = result.error ?? written.error;
      if (written.wrote) {
        result.written++;
        summarised.push(summary.id);
        continue;
      }
      // Refused: a summary arrived while the call was out, the user deleted the
      // bookmark, or the description fell back under the gate. The attempt row is
      // left exactly as it was — it is still a true statement about that text — and
      // nothing is written, which is the whole point of the guard.
      result.skipped++;
    }

    // A written summary DELETEs its attempt row, and that is what keeps a summary
    // re-writable: with the memory gone, clearing the summary makes the record a
    // candidate again, which is the documented behaviour of `null` and `""`.
    await forgetAttempts(pool, userId, summarised);

    const refusals: Array<{ id: string; hash: string; outcome: SummaryOutcome }> = [];
    for (const skip of response.skipped) {
      const outcome = attemptOutcomeFor(skip.reason);
      const record = byId.get(skip.id);
      if (outcome && record) {
        // The hash is of the row the *work list* read rather than of the row
        // `summarizeRecords` read a moment later, and the skew is in the safe
        // direction: a stale hash reads as "the text changed", so the next pass
        // asks again. It costs one call. The unsafe direction would be the other
        // one — storing a newer hash than the attempt was made on, which would
        // park a record whose text the user had just changed.
        refusals.push({ id: skip.id, hash: hashOf(record), outcome });
      }
      result.skipped++;
    }
    await rememberAttempts(pool, userId, refusals);

    result.ran = true;
    const next = nextSummarizeRunState(summarize, result, response, nowMs, at);
    if (next.lastError) result.error = result.error ?? next.lastError;
    await writeSummarizeRunState(pool, userId, next);
    return result;
  } catch (error) {
    result.error = errorMessage(error);
    console.warn(`[ai-summary] pass failed for ${userId}: ${result.error}`);
    try {
      const state = await readRunState(pool, userId);
      // Counters left alone rather than guessed at: a pass that died part way
      // through has no single number to add, and the panel only has to show that
      // something went wrong.
      await writeSummarizeRunState(pool, userId, { ...state.summarize, lastError: result.error });
    } catch {
      // Nothing left to report it to.
    }
    return result;
  } finally {
    if (held) {
      try {
        await releaseRunLease(pool, userId, "summary_lease_until");
      } catch (error) {
        // The lease expires on its own; a pass that cannot release it is slow, not
        // stuck.
        console.warn(`[ai-summary] could not release the summary lease for ${userId}: ${errorMessage(error)}`);
      }
    }
  }
}

/**
 * The stored state after a pass. The same decision `nextRunState` makes for
 * classification, on the same two windows, because they mean the same two
 * things: a missing proposer key is a deployment state that takes a deploy and a
 * quiet hour, and anything else that failed is a real failure that backs off.
 *
 * The one thing borrowed rather than re-derived is the model: `unavailable` is
 * `summarizeRecords`' own answer when it made no call at all
 * (`SummarizeResponse.model` is `UNAVAILABLE_MODEL`, and it is the *same* string
 * it reported on the response rather than a re-derivation here), so the panel and
 * the pass cannot disagree about whether a call was attempted.
 */
function nextSummarizeRunState(
  state: SummarizeRunState,
  result: SummaryPassResult,
  response: { model: string; skipped: Array<{ reason: SummarySkipReason }> },
  nowMs: number,
  at: string,
): SummarizeRunState {
  const keyPresent = summarizeAvailability().summarize;
  const calledNothing = response.model === UNAVAILABLE_MODEL;
  const failed = calledNothing || response.skipped.some((skip) => skip.reason === "failed");
  const unavailable = !keyPresent && failed;
  const backingOff = keyPresent && failed;
  const previous = countOr(state.backoffMs);
  const step = backingOff
    ? previous === 0
      ? AI_BACKOFF_BASE_MS
      : Math.min(previous * 2, AI_BACKOFF_CAP_MS)
    : 0;

  let lastError: string | null = result.error ?? null;
  if (!lastError && !unavailable) {
    // Deliberately nothing for `unavailable`, the same decision `nextRunState`
    // makes: a deployment that has no key is not something the user did or can
    // fix, and the panel renders "unavailable" from `isUnavailable` before it
    // looks at `lastError` — so setting both would show a quiet misconfiguration
    // as a fault on their account. The two sentences below are about the *call*,
    // not about the account: `calledNothing` is `summarizeRecords` reporting that
    // it resolved no proposer, and only the panel's `available` dot says anything
    // about the deployment.
    if (calledNothing) lastError = "Nook's server has no summarisation model configured.";
    else if (response.skipped.some((skip) => skip.reason === "failed")) {
      lastError = "Nook's server could not reach the summarisation model — backing off.";
    }
  }

  return {
    processed: state.processed + result.processed,
    written: state.written + result.written,
    skipped: state.skipped + result.skipped,
    lastRunAt: at,
    lastError,
    unavailableUntil: unavailable
      ? new Date(nowMs + AI_UNAVAILABLE_COOLDOWN_MS).toISOString()
      : state.unavailableUntil,
    backoffUntil: backingOff ? new Date(nowMs + step).toISOString() : state.backoffUntil,
    backoffMs: step,
  };
}

// -- "Run now" -------------------------------------------------------------

/**
 * `POST /api/ai/run`'s summarisation half: the work list is already the queue, so
 * this is a read and a wake-up rather than an enqueue.
 *
 * It does not run a pass inline, for the reason its sibling does not: 25 calls at
 * concurrency 4 take tens of seconds, which is not something to hold an HTTP
 * request open for. Waking the worker rather than waiting out the tick is the
 * difference between a button that feels like a button and one that takes up to a
 * minute, and the pass it starts takes the lease, so waking a second worker is
 * free rather than a second pass.
 *
 * Gated on `autoSummarize` inside the query rather than read first, so a user with
 * the switch off is told zero and gets zero — and so a deployment with the switch
 * on but no model configured reports the candidates honestly rather than an
 * empty answer that reads like "nothing to do".
 */
export async function requestSummaryRun(pool: Pool, userId: string): Promise<{ queued: number }> {
  const queued = await topUpSummaryQueue(pool, userId);
  void runSummarizationPass(pool, userId);
  return { queued };
}

// -- the status ------------------------------------------------------------

/**
 * The summarisation half of `GET /api/ai/status`.
 *
 * `available` is `summarizeAvailability().summarize`, the same value the deleted
 * `POST /api/summarize` answered 503 from, so the panel's dot and the worker's
 * willingness to run cannot describe two different deployments. `model` is the
 * same call's `model`, which is `summarizeRecords`' own resolution of the same
 * three environment variables, so what the panel names is what would be called.
 *
 * The two cooldown stamps become booleans for the same reason the classification
 * ones do: "when" is a thing only the worker acts on, and "is it in effect right
 * now" is the only thing a panel can render.
 */
export async function readSummarizeStatus(
  pool: Pool,
  userId: string,
  nowMs: number = Date.now(),
): Promise<SummarizeStatus> {
  const availability = summarizeAvailability();
  const [state, counts] = await Promise.all([
    readRunState(pool, userId),
    countSummarizeStatus(pool, userId),
  ]);
  const summarize = state.summarize;
  return {
    available: availability.summarize,
    model: availability.model,
    pending: counts.pending,
    summarised: counts.summarised,
    written: summarize.written,
    skipped: summarize.skipped,
    lastRunAt: summarize.lastRunAt,
    lastError: summarize.lastError,
    isUnavailable: inEffect(summarize.unavailableUntil, nowMs),
    isBackingOff: inEffect(summarize.backoffUntil, nowMs),
  };
}
