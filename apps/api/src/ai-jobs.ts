/**
 * The classification pass, on the server: the queue, the batch loop, the writes,
 * and the taxonomy acceptance that creates collections.
 *
 * This was apps/extension/lib/ai-runner.ts plus the impure half of
 * apps/extension/lib/ai-taxonomy.ts, both deleted by the cloud-runner migration
 * (docs/ai-cloud-contract.md). It was the only thing in the extension that needed
 * a service-worker alarm, a session, a cursor capped at 2,000 ids and a
 * `fetch`-to-our-own-server hop to do work the server can do with the rows it
 * already holds. The reasoning came with it, and most of this file is that
 * reasoning, retargeted: the batch and concurrency shape, the cooldowns, the two
 * option builders, the "a no-op write is a version bump" rule and the "never bill
 * the same bookmark twice" discipline all survive because the reasons survive.
 *
 * Three properties outrank the rest, and they are the three that are hard to
 * re-derive later:
 *
 * - **A decision is bought at most once, ever.** `nook_ai_decided` is the memory
 *   of "we already paid for this one", including for the decisions that filed
 *   nothing and therefore left no mark on the record at all. The extension kept
 *   that memory in a capped list, and the cap leaked money on any library past
 *   2,000 undecided ids (see the comment on the table in schema.sql). This is
 *   the reason the per-minute tick below is safe and not reckless.
 * - **A failed call and a cost-guard skip are different answers.** The
 *   `MIN_CLASSIFIABLE_CHARS` floor is applied here, per bookmark, *before* any
 *   request is built, so the neutral placeholder `classifyBookmarkOutcome`
 *   returns can only ever mean "the call did not happen or the model could not be
 *   reached" — which is the only thing that should stop a pool. The deleted runner
 *   collapsed three unrelated conditions into `model === "unavailable"` and
 *   stopped the batch on all of them; the comment on `classifyOne` is the long
 *   version of why that was a bug and what it cost.
 * - **The write cannot interleave with a sync.** A decision lands on a record a
 *   client may be editing at the same instant, and the lock that makes the two
 *   serialize is `pg_advisory_xact_lock(hashtext(user_id))` — the *same* one
 *   `syncRecords` takes. See `applyServerWrite`, which is the most delicate
 *   function in this file and now guards two features rather than one:
 *   `applyClassificationPatch` is its first caller and `ai-summary.ts`'s
 *   summarisation pass is its second, which is why the whole of that function's
 *   reasoning is written on the mechanism and not on the caller.
 *
 * Nothing in here throws. Every export degrades: a pass that fails returns a
 * result carrying the reason, a tick logs and carries on, and an enqueue that
 * fails is a queue that will be topped up again. A background pass must never be
 * able to fail a sync, kill the process, or interrupt the loop for the next
 * account.
 */

import type { Pool, PoolClient } from "pg";
import {
  MIN_CLASSIFIABLE_CHARS,
  UNAVAILABLE_MODEL,
  aiAvailability,
  buildClassificationState,
  classifyBookmarkOutcome,
  proposeTaxonomy,
  type AiDeps,
  type ClassifyResponse,
  type TaxonomyLanguage,
} from "./ai.js";
import { getAiUserSettings, type AiUserSettings } from "./ai-settings.js";
import {
  applyClassification,
  bookmarkNeedsClassification,
  foldCase,
  normalizeTagName,
  patchChangesSomething,
  toClassifiable,
  toClassifyRequest,
  withTaxonomyAt,
  type AiTaxonomyOption,
  type ClassifiableBookmark,
  type ClassifiableList,
  type ClassifyRequest,
  type TagVocabularyEntry,
} from "./ai-classify.js";
import {
  PROPOSAL_MAX_COLLECTIONS,
  PROPOSAL_MAX_TAGS,
  TAXONOMY_SAMPLE_SIZE,
  planLists,
  planTags,
  readProposals,
  readProposedTags,
  selectSample,
  toAcceptedTaxonomy,
  type AcceptedTaxonomy,
  type TagProposal,
  type TaxonomyProposal,
} from "./ai-taxonomy.js";
import {
  AI_BACKOFF_BASE_MS,
  AI_BACKOFF_CAP_MS,
  AI_UNAVAILABLE_COOLDOWN_MS,
  REVIEW_ROW_LIVE,
  acquireRunLease,
  activeCooldown,
  pushLogEntry,
  readAcceptedTaxonomy,
  readRunState,
  releaseRunLease,
  saveAcceptedTaxonomy,
  writeRunState,
  type AiRunState,
} from "./ai-store.js";
import { pruneSummaries, runSummarizationPass, topUpSummaryQueue } from "./ai-summary.js";
// Type-only, so it is erased and this is not a runtime cycle: sync.ts imports
// `enqueueClassification` from here, and a value import of the kind union would
// close the loop for no reason.
import type { RecordKind } from "./sync.js";


// -- configuration --------------------------------------------------------

/**
 * Bookmarks bought per pass, and requests in flight at once. Both are the
 * deleted runner's `AI_BATCH_SIZE` / `AI_CONCURRENCY`, unchanged, because neither
 * was a browser-shaped decision:
 *
 * - 25 bounds a pass's wall clock, its spend and what the panel can attribute to
 *   a single run. Throughput is not the constraint: cost is per bookmark, not per
 *   tick, and 5,000 bookmarks is $0.31 measured (docs/ai.md). Being able to say
 *   "this run filed 18, skipped 7" is the constraint.
 * - Concurrency 4 turns 25 serial round trips into ~7. More buys little, because
 *   per-call latency dominates and the upstream's published limit is 1,200
 *   requests/minute.
 *
 * What changed is who is waiting: the runner's justification for 4 was that an
 * MV3 service worker is torn down after ~30s idle, and that reason is gone. What
 * replaces it is the lease: a pass must finish inside `NOOK_AI_LEASE_SECONDS`, and
 * a lease that expires under a healthy pass is worse than a slightly slower one.
 */
export const CLASSIFY_BATCH_SIZE = 25;
export const CLASSIFY_CONCURRENCY = 4;

/**
 * How often the worker looks for work, and the rate that implies.
 *
 * Once every 10 seconds is 30x the extension's 5-minute alarm, and the *total*
 * cost is unchanged: a classification is billed per bookmark, not per tick, so
 * cost was never the reason the old runner (or this pass's earlier 60-second
 * default) polled slowly. A tick with a full 25-bookmark batch claimed is
 * `CLASSIFY_BATCH_SIZE / (AI_TICK_INTERVAL_MS / 60_000)` bookmarks a minute —
 * 25 at the old 60-second default, ≈150 at this one — so a 1,000-bookmark
 * backlog clears in roughly 7 minutes instead of roughly 40. The per-bookmark
 * price does not change: 5,000 bookmarks is still $0.31, once, whether it
 * clears in 40 minutes or in 7 (docs/ai.md, "The rate").
 *
 * A once-a-minute tick was never a cost guard, only an unexamined holdover from
 * the extension's polling cadence — the actual ceiling docs/ai.md calls out is
 * `CLASSIFY_CONCURRENCY` against the upstream's 1,200 requests/minute limit,
 * and four requests in flight at a time is nowhere near that regardless of how
 * often a tick fires.
 *
 * The reason a faster tick is safe rather than reckless is still
 * `nook_ai_decided`: with the old capped cursor, a faster tick would have
 * multiplied a permanent re-billing leak; with the unbounded table, a bookmark
 * is bought exactly once no matter how many ticks pass while it sits queued.
 * The lease is the other half of that safety, and it is unaffected by how often
 * a tick fires — see `acquireRunLease` and the re-entrancy guard on
 * `tickAiWorker` below, which is what keeps a tick that runs long from
 * overlapping the next one's work rather than merely its own clock.
 *
 * Overridable for tests and for a deployment that wants a slower meter; floored at
 * a second so a typo cannot turn the worker into a spin loop.
 */
export const AI_TICK_INTERVAL_MS = 10_000;

/** How often the same tick also reconciles. The reconciler is the backstop for
 *  everything the queue missed, so its cadence is a "how long can the index be
 *  behind" answer and nothing more — the same 15 minutes server.ts's embedding
 *  reconciler uses. */
export const AI_RECONCILE_INTERVAL_MS = 15 * 60_000;

/** Accounts considered per tick. A bound on how long one tick may take, not on
 *  the request rate: accounts are worked one at a time and each pass holds at
 *  most `CLASSIFY_CONCURRENCY` requests open, so the instantaneous rate is 4
 *  whatever this is set to. Chosen well above the single-account (or small
 *  family) shape a self-hosted Nook actually has; a deployment that outgrew it
 *  needs a last-run column and a rotation, not a bigger number. */
const TICK_ACCOUNT_LIMIT = 50;

/** First run, because the container may still be applying `schema.sql` and a tick
 *  that reads before `nook_ai_jobs` exists only logs a failure. Mirrors the 30s
 *  first run of the reconcile timer in server.ts. */
const FIRST_TICK_DELAY_MS = 30_000;

/** The reconciler's top-up, in one statement. Large enough to be a backstop rather
 *  than a refill: a library that has been offline for a week is filled in a few
 *  ticks instead of hundreds. */
const RECONCILE_TOP_UP_LIMIT = 500;

/** Existing tags offered as `Noul` options, highest frequency first. The doc's
 *  "top 20 by frequency". */
const AI_TAG_OPTION_LIMIT = 20;
/** Member titles carried per collection option. */
const AI_COLLECTION_SAMPLES = 5;
/** Member titles carried per tag option — there are up to 20 of these. */
const AI_TAG_SAMPLES = 3;

/** Names accepted in one taxonomy acceptance. The proposer offers at most 8
 *  collections and 20 tags, so this is a bound on a malformed or hostile body
 *  rather than on the feature. */
const MAX_ACCEPTED_NAMES = 100;
/** A name is a label, not a body of text. Same cap the proposal sample uses. */
const MAX_NAME_CHARS = 300;

// -- public types ---------------------------------------------------------

/** One decision's trip through the model. `classify` and `now` are injected so
 *  the pool's rules can be tested without an API key and without a clock; `fetch`
 *  and `sleep` are passed through to `classifyBookmarkOutcome` so a test can drive
 *  the real transport. */
export interface AiJobDeps {
  classify?: (request: ClassifyRequest) => Promise<{ response: ClassifyResponse; throttled: boolean }>;
  now?: () => number;
  newId?: () => string;
  fetch?: AiDeps["fetch"];
  sleep?: AiDeps["sleep"];
}

/**
 * What one pass did.
 *
 * `ran` is false when a gate declined to start one — the lease was held elsewhere,
 * the toggle is off, a cooldown is in effect, or there was nothing queued — which
 *  is the common case and not a failure. The counters are this pass's, not the
 *  account's lifetime totals; those live in `nook_ai_state` and are read back by
 *  the status route.
 */
export interface AiPassResult {
  ran: boolean;
  /** Rows the claim took. Rows the claim did not get are still in the queue. */
  claimed: number;
  processed: number;
  assigned: number;
  tagged: number;
  /** Bought and filed nothing, plus never bought because the pool stopped first. */
  skipped: number;
  error?: string;
}

/** `POST /api/ai/taxonomy/propose`, from docs/ai-cloud-contract.md. `sampleSize: 0`
 *  with empty arrays means there was nothing eligible to read, which the client
 *  reports as a different thing from "the model had nothing to say" and the
 *  review list renders as a different sentence. */
export interface ProposeTaxonomyResponse {
  /** How many bookmarks the proposal was drawn from. */
  sampleSize: number;
  collections: TaxonomyProposal[];
  tags: TagProposal[];
  /** Collection names the account already has, so the client can show them. */
  existingCollections: string[];
}

/** `PUT /api/ai/taxonomy`. */
export interface AcceptTaxonomyResponse {
  createdCollections: number;
  addedTags: number;
  /** Names dropped because a collection already had them. */
  dropped: number;
  /** The taxonomy now in force. */
  taxonomy: AcceptedTaxonomy;
}

/**
 * Thrown by `proposeTaxonomyForUser` when no proposer is configured, so the route
 * can answer 503 — "this server cannot do that" rather than a 200 carrying empty
 * arrays, which the client cannot tell from a model that declined to name
 * anything. A typed error rather than a discriminated result because the only
 * caller is a route, and the house style for a route is "parse or throw, throw
 * becomes 400/503".
 */
export class ProposerUnavailableError extends Error {
  constructor() {
    super("AI taxonomy proposal is not configured");
    this.name = "ProposerUnavailableError";
  }
}

// -- small helpers --------------------------------------------------------

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Interior whitespace collapsed, matching `collapseName` in ./ai.ts: a name
 *  rendered over two lines in the review list is still one name. */
function cleanName(value: unknown): string {
  return trimmed(value).replace(/\s+/g, " ").slice(0, MAX_NAME_CHARS);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function countOr(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value > 0 ? Math.floor(value) : 0;
}

function titleOf(bookmark: ClassifiableBookmark): string {
  return trimmed(bookmark.title);
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values)];
}

// -- reading the library, narrowly ----------------------------------------

/**
 * The columns a classification pass reads, and nothing else.
 *
 * `nook_records.data` is a whole captured page: `description` is the article body,
 * `media` is a list of image URLs, and both together are most of the payload of a
 * real library. A pass needs a page per *option builder* and per *candidate*, not
 * a page per bookmark in the account, so the projection is written out rather than
 * `SELECT data` — the difference between a pass that costs a few hundred
 * kilobytes on a 1,000-bookmark library and one that costs tens of megabytes on
 * every minute of every hour.
 *
 * Two rules decide what is here:
 *
 * 1. **Every field `toClassifyRequest` reads** — title, shortDescription, note,
 *    url, creator — because docs/ai-cloud-contract.md's own table lists them as
 *    the things the server has and classifies from, and dropping one would change
 *    the model's input rather than just make it cheaper. `shortDescription` is a
 *    mechanical 180-character truncation and a note is a sentence, so neither is
 *    the bulk the projection is avoiding.
 * 2. **Nothing else that the classifier does not read.** Which is why
 *    `description` is absent even though a summary feature would want it: that is
 *    a different route's query (see summarize.ts's own read).
 *
 * `data->'ai'` and `data->>'listId'` are the eligibility test
 * (`bookmarkNeedsClassification`), so they have to be in the projection or the
 * pass would build requests for records a human has already filed. Both are
 * carried as they are — `->` on jsonb yields SQL NULL for a missing key, which
 * arrives in JS as `undefined`/`null` and is exactly the "not filed" answer.
 */
const LIBRARY_PROJECTION = `id,
       data->>'title'           AS title,
       data->'shortDescription' AS short_description,
       data->>'note'            AS note,
       data->>'url'             AS url,
       data->'tags'             AS tags,
       data->>'listId'          AS list_id,
       data->>'listName'        AS list_name,
       data->'creator'          AS creator,
       data->'ai'               AS ai,
       data->>'savedAt'         AS saved_at,
       data->>'createdAt'       AS created_at,
       data->>'updatedAt'       AS updated_at,
       data->>'deletedAt'       AS data_deleted_at`;

interface LibraryRow {
  id: string;
  title: string | null;
  short_description: string | null;
  note: string | null;
  url: string | null;
  tags: unknown;
  list_id: string | null;
  list_name: string | null;
  creator: unknown;
  ai: unknown;
  saved_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  data_deleted_at: string | null;
}

/** Assembled back into a record and handed to `toClassifiable`, rather than being
 *  spread into a `ClassifiableBookmark` field by field here: that function is the
 *  one place that decides what a `nook_records` value is allowed to look like, and
 *  a second set of per-field `typeof` checks would be a second set of rules. */
function toRowBookmark(row: LibraryRow): ClassifiableBookmark {
  return toClassifiable({
    id: row.id,
    title: row.title,
    shortDescription: row.short_description,
    note: row.note,
    url: row.url,
    tags: row.tags ?? undefined,
    listId: row.list_id,
    listName: row.list_name,
    creator: row.creator ?? undefined,
    ai: row.ai ?? undefined,
    savedAt: row.saved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.data_deleted_at,
  });
}

/**
 * Every live bookmark of the account.
 *
 * Not the candidates: the option builders need the *whole* library (a collection
 * option's criteria are its actual member titles, and the tag options are ranked
 * by frequency across the account), so a narrow read would silently change the
 * questions. Tombstones are excluded at the query rather than filtered afterwards
 * — a deleted bookmark is not evidence about anything, and excluding it here is
 * what keeps a large account from paying for rows nothing can use.
 *
 * The taxonomy proposal reads through the same function on purpose. It wants a
 * narrower pool (title and site only) and could have had a second query, but the
 * proposal and the pass are both "the account's unfiled bookmarks" and two reads
 * that project the same table differently is one more thing to keep in step.
 */
async function readLibrary(pool: Pool, userId: string): Promise<ClassifiableBookmark[]> {
  const result = await pool.query<LibraryRow>(
    `SELECT ${LIBRARY_PROJECTION}
     FROM nook_records
     WHERE user_id=$1 AND kind='bookmark' AND deleted_at IS NULL`,
    [userId],
  );
  return result.rows.map(toRowBookmark);
}

interface ListRow {
  id: string;
  name: string | null;
  created_at: string | null;
  updated_at: string | null;
  data_deleted_at: string | null;
}

/** The live collections, by name and id. The accepted taxonomy is matched against
 *  these by name, so a soft-deleted list must not be here: a collection the user
 *  deliberately removed is a name that can be proposed again. */
async function readLiveLists(pool: Pool, userId: string): Promise<ClassifiableList[]> {
  const result = await pool.query<ListRow>(
    `SELECT id,
            data->>'name'     AS name,
            data->>'createdAt' AS created_at,
            data->>'updatedAt' AS updated_at,
            data->>'deletedAt' AS data_deleted_at
     FROM nook_records
     WHERE user_id=$1 AND kind='list' AND deleted_at IS NULL`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name ?? undefined,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
    deletedAt: row.data_deleted_at,
  }));
}

// -- the queue ------------------------------------------------------------

/**
 * The sync hook. Fire-and-forget from `POST /api/sync`, and the first thing a
 * saved bookmark touches on its way to being classified.
 *
 * A sync is the right place to enqueue for the same reason the embedding index
 * needed no client code: **the server already sees every bookmark through this
 * route.** A save is therefore queued for classification the moment it lands, on
 * any device, with nothing to install and nothing to configure. The extension
 * needed an alarm and a cursor for exactly this and still missed bookmarks saved
 * while its worker was asleep.
 *
 * The `autoClassify` guard is inside the statement rather than read first: reading
 * it first would cost every sync an extra round trip for one boolean, and the
 * decision has to be the *newest* one anyway — a user who turns the toggle off
 * should stop accumulating queue rows immediately, not after the next tick.
 *
 * `ON CONFLICT DO NOTHING` because a bookmark can be synced many times before it
 * is claimed, and a second copy of the same row is a duplicate decision waiting to
 * happen rather than a conflict worth reporting.
 */
export async function enqueueClassification(
  pool: Pool,
  userId: string,
  bookmarkIds: readonly string[],
): Promise<void> {
  const ids = dedupe(bookmarkIds.filter((id): id is string => typeof id === "string" && id !== ""));
  if (ids.length === 0) return;
  try {
    await pool.query(
      `INSERT INTO nook_ai_jobs (user_id, bookmark_id)
       SELECT $1, x.id FROM unnest($2::text[]) AS x(id)
       WHERE EXISTS (
         SELECT 1 FROM nook_ai_settings s
         WHERE s.user_id = $1 AND coalesce((s.data->>'autoClassify')::boolean, false)
       )
       ON CONFLICT DO NOTHING`,
      [userId, ids],
    );
  } catch (error) {
    // Never throws: this runs beside a sync that has already committed, and the
    // top-up would refill the queue on the next tick anyway. That is the whole
    // reason the top-up exists.
    console.warn(`[ai-jobs] could not enqueue classification for ${userId}: ${errorMessage(error)}`);
  }
}

/**
 * Take up to `limit` jobs, oldest first. **The row is the claim.**
 *
 * One DELETE ... RETURNING, so a claim is atomic and needs no second statement to
 * mark it, no `done` column, no per-job lease and no attempt counter. That is not
 * a simplification, it is the recovery mechanism: a process that dies between the
 * claim and the write has left the bookmark still eligible, still absent from
 * `nook_ai_decided`, and therefore re-enqueued by the next top-up — so the work
 * comes back by itself and nothing has to be told about the crash.
 *
 * Which means the absence of a "failed" state is deliberate. The alternative
 * design — a row with `attempts` and a `state` column — is the one that loses
 * work: a bookmark marked failed and never retried is a bookmark the model was
 * never asked about and the queue will never ask about again. This is the same
 * argument `reconcileIndex` makes about the embedding queue dropping jobs, and
 * the reconciler below is its backstop.
 *
 * Oldest first (FIFO) so a bookmark queued by a sync yesterday is not starved by
 * the newest saves, which arrive continuously and are the ones a top-up refills.
 */
export async function claimJobs(pool: Pool, userId: string, limit: number): Promise<string[]> {
  const batch = Math.max(0, Math.floor(limit));
  if (batch === 0) return [];
  const result = await pool.query<{ bookmark_id: string }>(
    `DELETE FROM nook_ai_jobs
     WHERE user_id=$1 AND bookmark_id IN (
       SELECT bookmark_id FROM nook_ai_jobs
       WHERE user_id=$1 ORDER BY created_at LIMIT $2
     )
     RETURNING bookmark_id`,
    [userId, batch],
  );
  return result.rows.map((row) => row.bookmark_id);
}

/**
 * Fill the queue from the library. The backstop, the "Classify now" button, and
 * the reason a lost job is a delay rather than a loss.
 *
 * One statement, and every exclusion in it is a reason not to buy a decision:
 *
 * - `kind='bookmark' AND deleted_at IS NULL` — a collection is not a candidate and
 *   a deleted bookmark never will be.
 * - `data->'ai' IS NULL AND data->'listId' IS NULL` — the eligibility rule, in
 *   SQL. `->` on jsonb yields NULL for a missing key, so this is exactly
 *   `bookmarkNeedsClassification`: a bookmark a human filed, or one the model has
 *   already ruled on, is not re-offered.
 * - `NOT EXISTS (nook_ai_jobs)` — one row per bookmark, not one per enqueue.
 * - `NOT EXISTS (nook_ai_decided)` — **the money.** A "nothing fit" verdict wrote
 *   nothing to the record, so this is the only thing standing between the model
 *   and a re-bill for every bookmark the account has ever declined.
 * - `autoClassify` must be on, for the reason `enqueueClassification` carries it
 *   inside its statement: otherwise the status route reports a queue that the
 *   worker will never drain, which is a lie in the one place a user checks.
 * - no lease held — a claimed row is the running pass's to write, and re-adding it
 *   mid-pass would queue a second decision for a bookmark that is already being
 *   decided. This is what keeps two replicas, or a top-up racing the pass it just
 *   filled, from buying the same bookmark twice.
 *
 * Ordered newest-first, matching `selectCandidates`' own sort and the partial
 * expression index in schema.sql. A backlog that only ever clears from the old end
 * starves the recent saves the user is actually looking at.
 */
export async function topUpClassificationQueue(
  pool: Pool,
  userId: string,
  limit: number = CLASSIFY_BATCH_SIZE,
): Promise<number> {
  const batch = Math.max(0, Math.floor(limit));
  if (batch === 0) return 0;
  try {
    const result = await pool.query<{ bookmark_id: string }>(
      `INSERT INTO nook_ai_jobs (user_id, bookmark_id)
       SELECT $1, r.id
       FROM nook_records r
       WHERE r.user_id = $1
         AND r.kind = 'bookmark'
         AND r.deleted_at IS NULL
         -- JSON null counts as absent: a client that writes "listId": null
         -- (or "ai": null) means "unfiled", and -> would read that as a
         -- non-NULL jsonb value and silently never enroll the bookmark.
         AND COALESCE(r.data->'ai', 'null'::jsonb) = 'null'::jsonb
         AND r.data->>'listId' IS NULL
         AND NOT EXISTS (SELECT 1 FROM nook_ai_jobs j WHERE j.user_id = r.user_id AND j.bookmark_id = r.id)
         AND NOT EXISTS (SELECT 1 FROM nook_ai_decided d WHERE d.user_id = r.user_id AND d.bookmark_id = r.id)
         AND EXISTS (
           SELECT 1 FROM nook_ai_settings s
           WHERE s.user_id = $1 AND coalesce((s.data->>'autoClassify')::boolean, false)
         )
         AND NOT EXISTS (
           SELECT 1 FROM nook_ai_state s
           WHERE s.user_id = $1 AND s.lease_until IS NOT NULL AND s.lease_until > now()
         )
       ORDER BY COALESCE(r.data->>'savedAt', r.data->>'createdAt', r.data->>'updatedAt') DESC NULLS LAST
       LIMIT $2
       ON CONFLICT DO NOTHING
       RETURNING bookmark_id`,
      [userId, batch],
    );
    return result.rows.length;
  } catch (error) {
    console.warn(`[ai-jobs] could not top up the queue for ${userId}: ${errorMessage(error)}`);
    return 0;
  }
}

/**
 * Drop the decisions whose bookmark is gone.
 *
 * `nook_ai_decided` is unbounded on purpose — that is the fix — so the price of
 * not capping it is a table that only ever grows. A bookmark deleted (or
 * tombstoned) while the process was down is a row nothing will ever read again,
 * and the only thing that removes it is this.
 *
 * Tombstones count as gone, not just missing rows: a deleted bookmark is not a
 * candidate for any future top-up, so remembering that we once decided on it buys
 * nothing. Restoring a deleted bookmark would re-enroll it for one decision, which
 * is the ordinary cost of a "Classify now" anyway.
 */
export async function pruneDecided(pool: Pool, userId: string): Promise<number> {
  try {
    const result = await pool.query(
      `DELETE FROM nook_ai_decided d
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
    console.warn(`[ai-jobs] could not prune decided ids for ${userId}: ${errorMessage(error)}`);
    return 0;
  }
}

/**
 * The backstop, and the only place `pruneDecided` is called.
 *
 * `scanned` is the account's live bookmark count — the population a top-up draws
 * from — read as a count on the partial index rather than as rows, because the
 * reconciler's job is to decide *whether* there is work, not to look at it. A
 * clean account costs three small statements and no data.
 *
 * A top-up at a larger limit rather than a full scan-and-plan, for the reason
 * `nook_ai_decided` gives one: the SQL exclusions are the plan, they are exact,
 * and they are already indexed. A reconciler that read the library and decided in
 * JS would be a second implementation of a rule that has to be identical to the
 * one the top-up runs on, and the two would drift.
 */
export async function reconcileClassification(
  pool: Pool,
  userId: string,
): Promise<{ scanned: number; scheduled: number; pruned: number; error?: string }> {
  try {
    const counted = await pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM nook_records WHERE user_id=$1 AND kind='bookmark' AND deleted_at IS NULL",
      [userId],
    );
    const scanned = countOr(counted.rows[0]?.count);
    const scheduled = await topUpClassificationQueue(pool, userId, RECONCILE_TOP_UP_LIMIT);
    const pruned = await pruneDecided(pool, userId);
    return { scanned, scheduled, pruned };
  } catch (error) {
    const message = errorMessage(error);
    console.warn(`[ai-jobs] reconciliation failed for ${userId}: ${message}`);
    return { scanned: 0, scheduled: 0, pruned: 0, error: message };
  }
}

// -- option builders ------------------------------------------------------

/**
 * Collection options are the account's real collections, each carrying its actual
 * member titles as `Choice` criteria — the doc's reason a single call can serve
 * the whole library, measured at 8.7 points of top-1 over names alone. The
 * accepted taxonomy only *enriches* them: an entry whose name matches no live list
 * is **ignored**, because offering it would hand back a `listId` no list backs and
 * render as a broken collection chip in the dashboard. The safe failure is not to
 * offer it.
 *
 * Matching by *name* is not a substitute for matching by id, it is the only way
 * this can work: `toAcceptedTaxonomy` stamps an option's `id` with the lowercased
 * name, because the real list id is a uuid that does not exist until the list row
 * is written. So the same name has to be the bridge in both directions, and the
 * key is folded per word (`foldCase`) rather than lowercased as a whole string —
 * "İş Akışları" and "iş akışları" are the same collection to the person who named
 * it, and `toLowerCase` would leave a combining dot in the first that the second
 * does not have.
 */
function buildCollectionOptions(
  lists: ClassifiableList[],
  bookmarks: ClassifiableBookmark[],
  taxonomy: AiTaxonomyOption[],
): { collections: AiTaxonomyOption[]; nameById: Map<string, string> } {
  const byId = new Map<string, string[]>();
  const byName = new Map<string, string[]>();
  const collect = (target: Map<string, string[]>, key: string, title: string) => {
    if (!title) return;
    const existing = target.get(key);
    if (existing) {
      if (existing.length < AI_COLLECTION_SAMPLES) existing.push(title);
    } else {
      target.set(key, [title]);
    }
  };

  for (const option of taxonomy) {
    for (const sample of option.samples) {
      collect(byId, option.id, sample);
      collect(byName, foldCase(option.name), sample);
    }
  }
  for (const bookmark of bookmarks) {
    if (typeof bookmark.listId === "string") collect(byId, bookmark.listId, titleOf(bookmark));
  }

  const collections: AiTaxonomyOption[] = [];
  const nameById = new Map<string, string>();
  for (const list of lists) {
    const name = trimmed(list.name);
    if (name === "") continue;
    const samples = dedupe([
      ...(byId.get(list.id) ?? []),
      ...(byName.get(foldCase(name)) ?? []),
    ]).slice(0, AI_COLLECTION_SAMPLES);
    collections.push({ id: list.id, name, samples });
    nameById.set(list.id, name);
  }
  return { collections, nameById };
}

/**
 * Tag options, highest frequency first, each with a few member titles.
 *
 * Ties break on the name so the option set — and therefore the questions the model
 * answers — is identical on every pass for the same library. A reshuffled option
 * set would make a recorded confidence meaningless to compare against a later run.
 *
 * **Accepted-but-unused names go last, with no samples.** They are the tail
 * because a tag with members behind it has evidence and one without has only its
 * own name, and the 20-question cap is spent on evidence first. It is also the
 * only reason a *proposed* tag can be offered at all: the questions above are built
 * from the tags bookmarks already carry, so without this tail a tag with no members
 * could never be asked about by any code that exists — which is what made the first
 * version of the taxonomy feature generate them, parse them, and drop them.
 * Verified against the live service: a zero-member vocabulary put
 * "yazılım geliştirme" on 20 of 60 real bookmarks in one pass.
 *
 * The member titles collected here are never sent: `toClassifyRequest` drops a
 * tag's `samples` on the wire, and `docs/ai-calibration.md` is explicit that
 * putting a `Noul`'s neighbours in the question costs 58% of the request's tokens
 * and halves tag recall (81.7% → 47.9%; `türkçe` 97% → 27%). A `Noul` is an
 * absolute question and a `Choice` is a relative one, and the digest that is
 * worth 8.7 points of top-1 on the second is destructive on the first. The two must
 * not be made to look alike. What a member-less tag has instead is its definition.
 */
function buildTagOptions(
  bookmarks: ClassifiableBookmark[],
  proposedTags: TagVocabularyEntry[] = [],
): AiTaxonomyOption[] {
  const counts = new Map<string, number>();
  const samples = new Map<string, string[]>();
  for (const bookmark of bookmarks) {
    const tags = Array.isArray(bookmark.tags) ? bookmark.tags : [];
    const title = titleOf(bookmark);
    for (const raw of tags) {
      if (typeof raw !== "string") continue;
      const name = normalizeTagName(raw);
      if (name === "") continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const existing = samples.get(name);
      if (existing) {
        if (title && existing.length < AI_TAG_SAMPLES) existing.push(title);
      } else {
        samples.set(name, title ? [title] : []);
      }
    }
  }
  // Keyed on the sample map, which is populated exactly when the count map is, so
  // the entries are `[name, samples]` and the frequency only decides the order.
  const live = [...samples.entries()]
    .sort(
      (left, right) =>
        (counts.get(right[0]) ?? 0) - (counts.get(left[0]) ?? 0) || left[0].localeCompare(right[0]),
    )
    .map(([name, list]) => ({ id: `tag:${name}`, name, samples: dedupe(list) }));

  const proposed = proposedTags
    .map((entry) => ({ name: normalizeTagName(entry?.name), definition: entry?.definition }))
    .filter((entry) => entry.name !== "" && !samples.has(entry.name));

  return [
    ...live,
    ...proposed.map((entry) => ({
      id: `tag:${entry.name}`,
      name: entry.name,
      samples: [],
      ...(entry.definition ? { definition: entry.definition } : {}),
    })),
  ].slice(0, AI_TAG_OPTION_LIMIT);
}

/**
 * The characters of state text a request would carry, measured exactly the way
 * `classifyBookmarkOutcome` measures them.
 *
 * Not a re-derivation of the floor: it builds the request and hands it to the same
 * `buildClassificationState` the real call uses, so the pass and the call can never
 * disagree about what "too short to be worth a request" means. If the filter in
 * ./ai.ts changes, this follows it with no edit here — which matters, because the
 * number below is the difference between "a legitimate skip" and "the model cannot
 * be reached", and the two drive opposite reactions.
 */
function stateTextLength(request: ClassifyRequest): number {
  const state = buildClassificationState(request.bookmark);
  return Object.values(state.item).reduce((sum, text) => sum + (text?.length ?? 0), 0);
}

// -- the pool -------------------------------------------------------------

/**
 * One outcome per candidate.
 *
 * `failed` is the only terminal kind, and it now means exactly one thing: the call
 * did not happen or the model could not be reached. A candidate the pool never
 * dispatched is `undefined`, which is a different thing entirely and is counted as
 * a skip without being remembered.
 */
type PassOutcome =
  | { kind: "decision"; response: ClassifyResponse }
  | { kind: "failed"; throttled: boolean };

/**
 * **The 40-character floor, and why it is applied here rather than in the
 * response.**
 *
 * `classifyBookmarkOutcome` returns `neutralClassification()` — `model:
 * "unavailable"` — for a bookmark whose state text is under
 * `MIN_CLASSIFIABLE_CHARS`, which is a *per-bookmark* cost guard: after the state
 * filter a media-only capture is a bare emoji or an author handle, and 39 of a real
 * 1,061-bookmark library fall under the line (15 under 20). Spending a request on
 * one of those returns a coin flip at full price.
 *
 * The deleted runner treated that `model === "unavailable"` as a terminal
 * `unhealthy` that **stopped the whole pool**. So one 39-character bookmark — a
 * bare X post, an emoji, a handle, and the *newest* saves are the most likely to be
 * one — silently ended the pass and burned the rest of the batch. The runner was
 * collapsing three unrelated conditions into one check: a missing key, a genuine
 * upstream failure, and a legitimate cost-guard skip.
 *
 * A client could not tell them apart. The server can, and must: the floor is
 * applied here, to the request we were about to build, and such a bookmark is
 * counted as skipped and recorded in `nook_ai_decided` — we have already read it,
 * it will never be worth another look, and recording it is what stops the top-up
 * from queueing it again. Then a neutral response *does* mean the call did not
 * happen or the model could not be reached, which is the only thing that should
 * stop a pool.
 *
 * Do not move this check back into the response handling. It is the kind of thing
 * that gets "simplified" into existence, and the symptom when it does is a
 * classification feature that mysteriously files nothing on a library full of
 * tweets.
 */
async function classifyOne(
  request: ClassifyRequest,
  classify: NonNullable<AiJobDeps["classify"]>,
): Promise<PassOutcome> {
  let outcome: { response: ClassifyResponse; throttled: boolean };
  try {
    outcome = await classify(request);
  } catch (error) {
    // A throw is the transport failing outright — the condition the deleted
    // runner called `unreachable`. Stopping beats firing the rest of the batch at
    // a connection that is already down.
    return { kind: "failed", throttled: false };
  }
  if (outcome.response.model === UNAVAILABLE_MODEL) {
    return { kind: "failed", throttled: outcome.throttled === true };
  }
  return { kind: "decision", response: outcome.response };
}

/**
 * The batch, as a pool of `CLASSIFY_CONCURRENCY` workers rather than a serial
 * loop.
 *
 * A terminal status stops the pool, so one unreachable model ends the pass instead
 * of spending the rest of the batch on an answer the pass already knows it cannot
 * use. Requests already in flight still resolve and are still applied: they were
 * billed, and their decisions are valid. That asymmetry is the same one the
 * extension's pool had, and it is the reason a stop is a stop rather than a
 * cancellation.
 *
 * The extension also had a single-flight guard here, so the alarm and a manual
 * "Classify now" could never classify the same bookmark twice. That job now belongs
 * to the lease plus the claim, and it is a better answer: the guard joined a
 * second run to the first, whereas the claim makes a second run *impossible*
 * rather than merely unlikely.
 */
async function runPool(
  jobs: ReadonlyArray<{ id: string; request: ClassifyRequest }>,
  classify: NonNullable<AiJobDeps["classify"]>,
): Promise<Array<PassOutcome | undefined>> {
  const outcomes: Array<PassOutcome | undefined> = new Array(jobs.length);
  let next = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const position = next++;
      if (position >= jobs.length) return;
      const outcome = await classifyOne(jobs[position].request, classify);
      outcomes[position] = outcome;
      if (outcome.kind === "failed") stopped = true;
    }
  };

  await Promise.all(Array.from({ length: Math.min(CLASSIFY_CONCURRENCY, jobs.length) }, () => worker()));
  return outcomes;
}

// -- the write path -------------------------------------------------------

export interface ClassificationWriteResult {
  /** The decision changed `listId`/`listName`. */
  assigned: boolean;
  /** The decision added at least one tag. */
  tagged: boolean;
  /** Nothing was written: gone, tombstoned, already filed by a human, a
   *  deliberate no-op, or a failure below. */
  skipped: boolean;
  wrote: boolean;
  error?: string;
}

const NOTHING_WRITTEN: ClassificationWriteResult = { assigned: false, tagged: false, skipped: true, wrote: false };

/**
 * The row `applyServerWrite` re-reads inside its transaction, as the two hooks
 * get to see it.
 *
 * The raw jsonb rather than a coerced bookmark, and that is what makes one
 * mechanism serve two features: classification reads `listId`/`tags`/`ai` and
 * summarisation reads `summary`/`description`, and neither set is knowable here.
 * The record's own `id` column travels separately because `data.id` is the
 * client's copy and a record where the two disagree is a sync bug no write path
 * can repair.
 */
export interface ServerRecord {
  id: string;
  data: Record<string, unknown>;
  /** `nook_records.deleted_at`, exactly as it was read. */
  deletedAt: string | null;
}

/**
 * What a caller of `applyServerWrite` decides, in two hooks and nothing else.
 *
 * Both are handed the *fresh* row — the one read inside the lock — and that is
 * the only moment either of them can be honestly evaluated. A guard answered at
 * the start of a pass is answered about a record that may already be gone, filed
 * by a human, or summarised by someone else; a patch built out there is a patch
 * built from data that no longer exists.
 */
export interface ServerWrite {
  /** Decided against the freshly-read row. False means "leave it alone". */
  guard(record: ServerRecord): boolean;
  /**
   * The patch, computed from the fresh row. null means "nothing to write" — and
   * a caller that would produce a no-op should return null here rather than rely
   * on the generic check, which is a floor and not the authority.
   */
  build(record: ServerRecord): Record<string, unknown> | null;
}

export type ServerWriteReason = "gone" | "guarded" | "no-change";

export interface ServerWriteResult {
  wrote: boolean;
  /** What was written, or null when nothing was. */
  patch: Record<string, unknown> | null;
  /** Why nothing was written. Absent exactly when `wrote` is true. */
  reason?: ServerWriteReason;
  /**
   * The row the guard and build were evaluated against, so a caller can report
   * *what changed* rather than only that something was written. Null when no row
   * came back.
   */
  record: ServerRecord | null;
  error?: string;
}

/**
 * Write one thing onto one record, in one transaction. This is the part
 * docs/ai-cloud-contract.md called "işin en hassas kısmı", extracted out of
 * `applyClassificationPatch` so the summarisation pass writes through exactly the
 * same mechanism instead of a second copy of it. Every comment below used to
 * describe one feature and now guards two, which is exactly why none of it was
 * summarised away in the extraction: the steps are in this order for reasons.
 *
 * 1. `pg_advisory_xact_lock(hashtext(user_id))` — **the same lock `syncRecords`
 *    takes** (sync.ts:178). This is the whole reason the write cannot interleave
 *    with a sync's read-check-write: a sync reads a record's version, compares it
 *    to the client's base version and upserts, all under this lock, so either the
 *    write lands first and the sync sees a bumped version (and answers with a
 *    conflict, which the client resolves by merging the newer side) or the sync
 *    lands first and step 2 reads the human's change. There is no interleaving in
 *    between. A different lock key would be worse than no lock at all: it would
 *    serialise the two subsystems against nobody and let both write at once. It
 *    is also what makes a summary write and a classification write for one
 *    account serialise against each other, which is why the two features do not
 *    need a shared lease to be safe against each other.
 * 2. `SELECT ... FOR UPDATE` on the record itself, so two passes on two replicas
 *    cannot both write about the same bookmark even if a lease expired.
 * 3. Gone or tombstoned → roll back. A record the user threw away is not written
 *    to by a model, whatever the model said.
 * 4. **Re-check the caller's guard on the fresh row.** `bookmarkNeedsClassification`
 *    for a decision; "live, still no summary, still long enough to be worth one"
 *    for a summary. Both are re-run here, on data read inside the lock, because
 *    both are rules about the state of the record and both can be broken between
 *    the caller's read and this one: a human who filed the bookmark, or a second
 *    writer that summarised it, while the request was in flight wins. The model is
 *    never asked about a bookmark twice and never overwrites a person.
 * 5. Recompute the patch against the *fresh* row rather than applying a patch
 *    built at the start of the pass. For classification this is the union of tags,
 *    so a tag the user added in the meantime has to survive; recomputing here is
 *    what makes that true, and applying the earlier patch to the fresh row would
 *    overwrite it with a `tags` array built from a record that no longer exists.
 *    **Do not "optimise" this into a patch computed once per pass** — the whole
 *    safety argument above rests on it.
 * 6. Write only if the patch changes something. Every write stamps `updatedAt` and
 *    takes `nextval('nook_sync_version_seq')`, which is what puts the change in
 *    front of every device through the ordinary sync pull *and* what makes
 *    `mergeBookmarks`' newer-wins resolve in the server's favour. A no-op write
 *    would therefore be a version bump and a dashboard resurfacing, for nothing —
 *    which is the harm the extension's `patchChangesSomething` check was there to
 *    avoid and why it is not optional here.
 *
 * `deleted_at` is written back from the row it was read from: this never
 * resurrects a tombstone and never invents one, so the write is a mirror of
 * `syncRecords`' own upsert rather than a second opinion about liveness.
 *
 * Never throws. A background write that threw would take down a pass that has
 * already billed its requests, and the caller has nowhere to put an exception: it
 * is a timer. The reason comes back on the result.
 */
export async function applyServerWrite(
  pool: Pool,
  userId: string,
  kind: RecordKind,
  id: string,
  nowIso: string,
  write: ServerWrite,
): Promise<ServerWriteResult> {
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);

    const read = await client.query<{ data: Record<string, unknown>; deleted_at: string | null }>(
      `SELECT data, deleted_at FROM nook_records
       WHERE user_id=$1 AND kind=$2 AND id=$3 FOR UPDATE`,
      [userId, kind, id],
    );
    const row = read.rows[0];
    if (!row || row.deleted_at || (typeof row.data?.deletedAt === "string" && row.data.deletedAt !== "")) {
      await client.query("ROLLBACK");
      return { wrote: false, patch: null, reason: "gone", record: null };
    }

    const record: ServerRecord = { id, data: row.data ?? {}, deletedAt: row.deleted_at ?? null };
    if (!write.guard(record)) {
      await client.query("ROLLBACK");
      return { wrote: false, patch: null, reason: "guarded", record };
    }

    const patch = write.build(record);
    // `patchChangesSomething` is a shallow `Record` comparison wearing a
    // `ClassifiableBookmark` signature for the convenience of its other caller —
    // its own comment says it reads both sides through a `Record` view, because
    // which fields it compares is not known until the patch is. The cast is what
    // lets the mechanism apply it to a record this feature knows nothing about.
    if (!patch || !patchChangesSomething(record.data as unknown as ClassifiableBookmark, patch as Partial<ClassifiableBookmark>)) {
      await client.query("ROLLBACK");
      return { wrote: false, patch: null, reason: "no-change", record };
    }

    const merged = { ...record.data, ...patch, updatedAt: nowIso };
    await client.query(
      `UPDATE nook_records SET
         data=$4::jsonb,
         deleted_at=$5,
         version=nextval('nook_sync_version_seq'),
         updated_at=now()
       WHERE user_id=$1 AND kind=$2 AND id=$3`,
      [userId, kind, id, JSON.stringify(merged), record.deletedAt],
    );
    await client.query("COMMIT");
    return { wrote: true, patch, record };
  } catch (error) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The connection is already unusable; releasing it is all that is left.
      }
    }
    const message = errorMessage(error);
    console.warn(`[ai-jobs] could not write to ${id}: ${message}`);
    return { wrote: false, patch: null, record: null, error: message };
  } finally {
    client?.release();
  }
}

/**
 * Write one decision. A caller of `applyServerWrite` and nothing else, and its
 * behaviour is the behaviour that shipped: the guard is `bookmarkNeedsClassification`
 * and the patch is `withTaxonomyAt(applyClassification(...))`, both recomputed from
 * the row the mechanism re-read.
 *
 * The `ServerWrite` is built per call rather than hoisted, because both of its
 * hooks are pure functions of the row they are handed and neither may hold state
 * between the two — `build` is where the recompute has to happen, and a closure
 * that remembered an earlier row would be exactly the bug step 5 exists to prevent.
 */
export async function applyClassificationPatch(
  pool: Pool,
  userId: string,
  bookmarkId: string,
  response: ClassifyResponse,
  nameById: Map<string, string>,
  maxTags: number,
  acceptedAt: string | null | undefined,
  nowIso: string,
): Promise<ClassificationWriteResult> {
  // The fresh row, read through the same tolerant reader every other read uses.
  // The `id` is the row's own column: `data.id` is the client's copy, and a record
  // where the two disagree is a sync bug this function cannot repair.
  const asBookmark = (row: ServerRecord): ClassifiableBookmark => toClassifiable({ ...row.data, id: row.id });

  const result = await applyServerWrite(pool, userId, "bookmark", bookmarkId, nowIso, {
    guard: (row) => bookmarkNeedsClassification(asBookmark(row)),
    build: (row) => {
      const fresh = asBookmark(row);
      const applied = applyClassification(fresh, response, nameById, maxTags, nowIso);
      const patch = applied ? withTaxonomyAt(applied, acceptedAt ?? undefined) : null;
      // This pass's own gate, and it is not the mechanism's: `patchChangesSomething`
      // below compares the *coerced* record, where `tags` is a `string[]`, and a
      // coercion that drops or normalises an entry is precisely the case where the
      // two views disagree. This one is the authority for a classification.
      return patch && patchChangesSomething(fresh, patch) ? { ...patch } : null;
    },
  });

  if (!result.wrote) return { ...NOTHING_WRITTEN, ...(result.error ? { error: result.error } : {}) };
  const patch = result.patch as Partial<ClassifiableBookmark>;
  const fresh = asBookmark(result.record as ServerRecord);
  const assigned = patch.listId != null && !Object.is(patch.listId, fresh.listId);
  const before = Array.isArray(fresh.tags) ? fresh.tags : [];
  const after = Array.isArray(patch.tags) ? patch.tags : [];
  const tagged = after.length !== before.length || after.some((value, index) => !Object.is(value, before[index]));
  return { assigned, tagged, skipped: false, wrote: true };
}

// -- the pass -------------------------------------------------------------

function passResult(): AiPassResult {
  return { ran: false, claimed: 0, processed: 0, assigned: 0, tagged: 0, skipped: 0 };
}

/**
 * One classification pass for one account, in the order the gates require.
 *
 * 1. **The lease.** Two api replicas must not run a pass for one account; the
 *    claim is what stops a double charge, and the lease stops the duplicated
 *    library read, the duplicated option build and two passes fighting over
 *    `nook_ai_state`.
 * 2. **`autoClassify`.** The gate the extension's 5-minute alarm and
 *    `aiIsArmable()` used to be. Neither exists any more: the alarm is this
 *    function, and the per-save check is the `autoClassify` guard inside the sync
 *    hook's INSERT.
 * 3. **The cooldowns.** A deployment with no `TYPESAFE_API_KEY` and a rate-limited
 *    model are different states and the panel renders them differently, so the
 *    stored stamps are kept apart rather than merged into one "retry later".
 * 4. **The claim, and then nothing.** An empty queue returns *before* the library
 *    is read. This is the cost gate and it is the most important line in the
 *    function: the option builders need the whole library, so a pass with nothing
 *    to do must not pay for reading it. Once a minute, forever, is a lot of ticks
 *    with nothing in them.
 * 5. The library, the lists and the accepted taxonomy, then the options.
 * 6. The pool.
 * 7. The writes, one transaction each.
 * 8. One state write: counters, the log, the cooldown windows and the ids we have
 *    now bought a decision for.
 * 9. The lease, released in a `finally` so a failed pass does not park the feature
 *    for the length of the lease.
 *
 * Never rejects. The caller is a timer, and a pass that has already billed its
 * requests must not be undone by the exception that followed them.
 */
export async function runClassificationPass(
  pool: Pool,
  userId: string,
  deps: AiJobDeps = {},
): Promise<AiPassResult> {
  const nowMs = (deps.now ?? Date.now)();
  const result = passResult();
  const classify =
    deps.classify ??
    ((request: ClassifyRequest) =>
      classifyBookmarkOutcome(request, { fetch: deps.fetch, sleep: deps.sleep }));
  let held = false;

  try {
    held = await acquireRunLease(pool, userId, "lease_until");
    if (!held) return result;

    const settings: AiUserSettings = await getAiUserSettings(pool, userId);
    if (!settings.autoClassify) return result;

    const state = await readRunState(pool, userId);
    if (activeCooldown(state, nowMs) !== null) return result;

    const claimed = await claimJobs(pool, userId, CLASSIFY_BATCH_SIZE);
    result.claimed = claimed.length;
    // The cost gate. Everything below reads the library.
    if (claimed.length === 0) return result;

    const [bookmarks, lists, taxonomy] = await Promise.all([
      readLibrary(pool, userId),
      readLiveLists(pool, userId),
      readAcceptedTaxonomy(pool, userId),
    ]);
    const byId = new Map(bookmarks.map((bookmark) => [bookmark.id, bookmark]));

    const { collections, nameById } = buildCollectionOptions(lists, bookmarks, taxonomy.collections);
    const tagOptions = buildTagOptions(bookmarks, taxonomy.tags);

    // The floor, applied here and never again: see `classifyOne`. A candidate that
    // cannot clear it is not asked about, is counted as a skip, and is remembered
    // in nook_ai_decided so the next top-up does not queue it again.
    const underFloor: string[] = [];
    const jobs: Array<{ id: string; request: ClassifyRequest }> = [];
    for (const id of claimed) {
      const bookmark = byId.get(id);
      if (!bookmark) {
        // Claimed, then gone: a tombstone between the claim and the read. Nothing
        // to decide about and nothing to remember.
        result.skipped++;
        continue;
      }
      const request = toClassifyRequest(bookmark, collections, tagOptions, settings);
      if (stateTextLength(request) < MIN_CLASSIFIABLE_CHARS) {
        underFloor.push(id);
        result.skipped++;
        continue;
      }
      jobs.push({ id, request });
    }

    const outcomes = jobs.length > 0 ? await runPool(jobs, classify) : [];
    const at = new Date(nowMs).toISOString();
    const log = [...state.log];
    const decided = [...underFloor];
    // Kept guesses for the review list (docs/ai.md, "Review list"): every
    // low-confidence decision that named a real collection above
    // REVIEW_MIN_CONFIDENCE, collected here and upserted in one statement
    // alongside `rememberDecided` below — not written per-bookmark inside the
    // loop, for the same batching reason `decided` itself is collected first
    // and inserted once.
    const reviewGuesses: ReviewGuess[] = [];

    for (let position = 0; position < jobs.length; position++) {
      const job = jobs[position];
      const outcome = outcomes[position];
      // A missing outcome means the pool stopped before dispatching this one. It
      // counts as skipped, so the panel's filed-vs-skipped always adds up to the
      // batch it was told about, and it is deliberately *not* remembered: this
      // bookmark still deserves its one classification.
      if (!outcome || outcome.kind !== "decision") {
        result.skipped++;
        continue;
      }
      result.processed++;
      const written = await applyClassificationPatch(
        pool,
        userId,
        job.id,
        outcome.response,
        nameById,
        settings.maxTags,
        taxonomy.acceptedAt,
        at,
      );
      if (written.error) result.error = result.error ?? written.error;
      if (written.assigned) result.assigned++;
      if (written.tagged) result.tagged++;
      if (written.skipped) result.skipped++;
      // A decision was bought, so the id is remembered whether or not it filed
      // anything — including the "nothing fit" case, which is the whole reason
      // nook_ai_decided exists.
      decided.push(job.id);
      pushLogEntry(log, {
        id: job.id,
        confidence: outcome.response.collection.confidence,
        assigned: written.assigned,
        at,
      });
      // The guess, independent of what `written` did: a response can carry both
      // a kept collection guess and a filed tag (the collection Choice and the
      // tag Nouls are separate questions), and the review list is about the
      // collection alone. Collected whether or not the write landed — even a
      // "gone" or "no-change" write still means the bookmark is genuinely
      // unfiled and the guess is genuinely worth offering.
      const guess = outcome.response.guess;
      if (outcome.response.skipped === "low-confidence" && guess) {
        reviewGuesses.push({ bookmarkId: job.id, listId: guess.id, confidence: guess.confidence });
      }
    }

    // Why the pass stopped, if it did. The pool stops on the first terminal status,
    // so at most a handful of outcomes carry one and they all carry the same
    // cause; which of the two sentences it gets is decided in `nextRunState`,
    // against whether this server has a key at all.
    let throttled = false;
    let unreachable = false;
    for (const outcome of outcomes) {
      if (outcome?.kind !== "failed") continue;
      if (outcome.throttled) throttled = true;
      else unreachable = true;
    }

    result.ran = true;
    await rememberDecided(pool, userId, decided);
    await upsertReviewGuesses(pool, userId, reviewGuesses);

    // The recorded state decides the sentence, because only it knows whether this
    // server has a key at all; the returned result then carries the same one rather
    // than a second, differently-worded answer. A caller that logs `result.error`
    // must not see nothing where the panel is about to show a reason — the two were
    // briefly allowed to disagree, and the pass result is the one nothing read.
    const next = nextRunState(state, result, nowMs, at, log, throttled, unreachable);
    if (next.lastError) result.error = next.lastError;
    await writeRunState(pool, userId, next);
    return result;
  } catch (error) {
    result.error = errorMessage(error);
    console.warn(`[ai-jobs] classification pass failed for ${userId}: ${result.error}`);
    try {
      const state = await readRunState(pool, userId);
      // Counters are left alone rather than guessed at: a pass that died part way
      // through has no single number to add, and the panel only has to show that
      // something went wrong.
      await writeRunState(pool, userId, { ...state, lastError: result.error });
    } catch {
      // Nothing left to report it to.
    }
    return result;
  } finally {
    if (held) {
      try {
        await releaseRunLease(pool, userId, "lease_until");
      } catch (error) {
        // The lease expires on its own; a pass that cannot release it is slow, not
        // stuck.
        console.warn(`[ai-jobs] could not release the lease for ${userId}: ${errorMessage(error)}`);
      }
    }
  }
}

/** The ids this pass has spent analysis on, remembered durably. One statement, and
 *  `ON CONFLICT DO NOTHING` because two passes can only ever overlap if a lease
 *  expired, in which case writing the same answer twice is the harmless outcome. */
async function rememberDecided(pool: Pool, userId: string, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    `INSERT INTO nook_ai_decided (user_id, bookmark_id)
     SELECT $1, x.id FROM unnest($2::text[]) AS x(id)
     ON CONFLICT DO NOTHING`,
    [userId, [...ids]],
  );
}

/** One kept guess: a low-confidence decision's top choice, worth offering in
 *  the review list. See `ReviewGuess` at the call site in `runClassificationPass`. */
interface ReviewGuess {
  bookmarkId: string;
  listId: string;
  confidence: number;
}

/**
 * Keeps this pass's low-confidence guesses in `nook_ai_review`, one statement
 * for the whole batch — the same batching `rememberDecided` uses, for the same
 * reason: a pass claims up to 25 bookmarks, so 25 individual upserts would be
 * 25 round trips for something one statement already does.
 *
 * `ON CONFLICT ... DO UPDATE` rather than `DO NOTHING`: unlike `nook_ai_decided`,
 * this table is not a permanent "we already paid for this" marker, it is the
 * current best guess, and a bookmark can only reach this function once anyway
 * (a decided bookmark is never reconsidered — until a taxonomy acceptance wipes
 * `nook_ai_decided` and makes it eligible again, at which point a fresh guess
 * against the new option set is exactly what should replace the stale one, not
 * be silently dropped in favour of it).
 */
async function upsertReviewGuesses(pool: Pool, userId: string, guesses: readonly ReviewGuess[]): Promise<void> {
  if (guesses.length === 0) return;
  await pool.query(
    `INSERT INTO nook_ai_review (user_id, bookmark_id, list_id, confidence, created_at)
     SELECT $1, x.bookmark_id, x.list_id, x.confidence, now()
     FROM unnest($2::text[], $3::text[], $4::real[]) AS x(bookmark_id, list_id, confidence)
     ON CONFLICT (user_id, bookmark_id) DO UPDATE SET
       list_id = EXCLUDED.list_id,
       confidence = EXCLUDED.confidence,
       created_at = EXCLUDED.created_at`,
    [userId, guesses.map((g) => g.bookmarkId), guesses.map((g) => g.listId), guesses.map((g) => g.confidence)],
  );
}

/**
 * The stored state after a pass: the counters added up, the log, and the two
 * cooldown windows.
 *
 * **`signedOutUntil` is gone, and deliberately so.** The extension had a 30-minute
 * park after a 401 because it was a client: a 401 meant the session was gone, and
 * only a re-sign-in in that browser could fix it, so re-probing every 5 minutes
 * for the rest of the session was pure waste. A background pass here holds no
 * session, cannot be signed out, and is not talking to an auth layer at all — the
 * window had no meaning to preserve. Its absence is the reason the remaining two
 * can be read: they are conditions of the *deployment and the upstream*, which is
 * what a server actually has.
 *
 * The distinction between the two survivors is the one a client could not make.
 * `unavailableUntil` is set when a response was neutral **and** this server has no
 * `TYPESAFE_API_KEY`: that is a deployment state, it takes a deploy, and an hour of
 * quiet is the right response. A neutral response *with* a key present is a failed
 * call, so it backs off exponentially instead of parking for an hour — and because
 * the panel renders "unavailable" from `isUnavailable` and an error from
 * `lastError`, setting both would show a quiet misconfiguration as a fault on the
 * user's account.
 */
function nextRunState(
  state: AiRunState,
  result: AiPassResult,
  nowMs: number,
  at: string,
  log: AiRunState["log"],
  throttled: boolean,
  unreachable: boolean,
): AiRunState {
  const keyPresent = aiAvailability().classify;
  const unavailable = !keyPresent && (throttled || unreachable);
  const backingOff = keyPresent && (throttled || unreachable);
  const previous = countOr(state.backoffMs);
  const step = backingOff ? (previous === 0 ? AI_BACKOFF_BASE_MS : Math.min(previous * 2, AI_BACKOFF_CAP_MS)) : 0;

  let lastError: string | null = result.error ?? null;
  if (!lastError && !unavailable) {
    // Deliberately nothing for `unavailable`: a missing TYPESAFE_API_KEY is a
    // deployment state, not something the user did or can fix, and
    // `unavailableUntil` already carries it. Setting both made the panel pick
    // "error" (a red dot, "needs attention") over its own "unavailable" state,
    // which checks `isUnavailable` first — so a quiet misconfiguration looked like
    // a fault on the user's account.
    if (throttled) lastError = "Rate limited by the classification model — backing off.";
    else if (unreachable) lastError = "Nook's server could not reach the classification model — backing off.";
  }

  return {
    processed: state.processed + result.processed,
    assigned: state.assigned + result.assigned,
    tagged: state.tagged + result.tagged,
    skipped: state.skipped + result.skipped,
    lastRunAt: at,
    lastError,
    // A pass that reached the model clears a stale backoff, so a window left behind
    // by an earlier 429 cannot park the feature after its cause is gone.
    unavailableUntil: unavailable ? new Date(nowMs + AI_UNAVAILABLE_COOLDOWN_MS).toISOString() : state.unavailableUntil,
    backoffUntil: backingOff ? new Date(nowMs + step).toISOString() : state.backoffUntil,
    backoffMs: step,
    log,
    // Carried, never computed: this function knows nothing about the summarisation
    // pass and must not touch its windows, and `writeRunState` does not send the
    // sub-record at all (see the note there on the two writers of one row).
    summarize: state.summarize,
  };
}

// -- "Classify now" -------------------------------------------------------

/**
 * `POST /api/ai/run`: enqueue the account's eligible bookmarks and wake the worker.
 *
 * It does **not** run a pass inline. 25 classify calls take tens of seconds, which
 * is not something to hold an HTTP request open for, and the client is told to
 * watch `GET /api/ai/status` drain instead. Waking the worker rather than waiting
 * for the next tick is the difference between a button that feels like a button and
 * one that takes up to a minute; the pass it starts takes the lease, so waking a
 * second worker is free rather than a second pass.
 */
export async function requestClassificationRun(pool: Pool, userId: string): Promise<{ queued: number }> {
  const queued = await topUpClassificationQueue(pool, userId);
  void runClassificationPass(pool, userId);
  return { queued };
}

// -- taxonomy -------------------------------------------------------------

/**
 * `POST /api/ai/taxonomy/propose`. The server samples *its own* library, so the
 * client sends no sample at all — it has nothing to contribute and therefore
 * nothing to get wrong about which bookmarks were read.
 *
 * The sample is a deterministic stride over the account's unfiled bookmarks rather
 * than the newest 200: a bulk read hands records back in id order, which for saved
 * posts is save order, so the newest 200 of a 1,061-bookmark library describe only
 * the last few weeks of someone's reading. Stepping across the pool means a
 * proposal is drawn from the whole library.
 *
 * The request carries the account's `taxonomyLanguage` setting unless the body
 * overrides it, so the panel does not have to send what the settings row already
 * says, and the two cannot disagree.
 *
 * Throws `ProposerUnavailableError` when no proposer is configured, which is the
 * one answer the route must turn into a 503. Everything else degrades to empty
 * arrays: a proposer that fails, is throttled, or declines to name anything is
 * "no suggestions", and the review list renders that far better than an error
 * inside a settings dialog.
 */
export async function proposeTaxonomyForUser(
  pool: Pool,
  userId: string,
  language?: TaxonomyLanguage,
  deps: AiDeps = {},
): Promise<ProposeTaxonomyResponse> {
  if (!aiAvailability().proposeTaxonomy) throw new ProposerUnavailableError();

  const [bookmarks, lists, settings] = await Promise.all([
    readLibrary(pool, userId),
    readLiveLists(pool, userId),
    getAiUserSettings(pool, userId),
  ]);
  const existingCollections = dedupe(lists.map((list) => trimmed(list.name))).filter((name) => name !== "");
  const sample = selectSample(bookmarks, TAXONOMY_SAMPLE_SIZE);
  if (sample.length === 0) {
    return { sampleSize: 0, collections: [], tags: [], existingCollections };
  }

  const generated = await proposeTaxonomy(
    {
      sample: sample.map((bookmark) => ({ title: titleOf(bookmark), site: siteOf(bookmark) })),
      existingCollections,
      maxCollections: PROPOSAL_MAX_COLLECTIONS,
      maxTags: PROPOSAL_MAX_TAGS,
      language: language ?? settings.taxonomyLanguage,
    },
    deps,
  );
  const collections = readProposals(generated);
  // `coveredBy` is computed here rather than in the client: the overlap test
  // compares Turkish word *stems* ("tasarımı" against "Tasarımları"), and the
  // review list starts a covered tag unticked and re-ticks it the moment the
  // matching collection is unticked. That is only correct if both halves read the
  // same fold, which only the server can guarantee.
  const tags = readProposedTags(generated, collections.map((proposal) => proposal.name));
  return { sampleSize: sample.length, collections, tags, existingCollections };
}

/** The host, never the URL: a query string can carry a session token, and all the
 *  proposer needs is which site an item came from. Mirrors `siteOf` in
 *  ai-taxonomy.ts, which reads the same field on the same records. */
function siteOf(bookmark: ClassifiableBookmark): string {
  const url = typeof bookmark.url === "string" ? bookmark.url : "";
  if (url === "") return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * `PUT /api/ai/taxonomy`: the names the user kept become real collections plus the
 * accepted vocabulary, in one transaction.
 *
 * **The request carries only names.** The sample, the account's live collections
 * and the library's own tags are all read from `nook_records` at acceptance time,
 * which is strictly more correct than the client re-sending a snapshot it may have
 * read before a concurrent change — a collection created in another tab a second
 * ago cannot be duplicated, and a tag the library already carries is not re-added
 * to a vocabulary that is only for names nothing carries.
 *
 * The list rows and the taxonomy row are written in the same transaction, which is
 * the thing the extension could not do: there, the collections were created in
 * IndexedDB and the taxonomy was a separate meta write, so a failure between them
 * left a collection the runner knew nothing about. Its comment explained that the
 * lists had to be written *before* the record because the two were separate writes
 * and only one of them could be undone; that ordering constraint is simply gone,
 * and what replaces it is that neither can be half-done.
 *
 * Each list takes `nextval('nook_sync_version_seq')`, which is what carries it to
 * every device through the ordinary sync pull. The server is the author here, and
 * that is the same position a client is in when it writes a record — the version is
 * the only thing that tells another device which side won.
 */
export async function acceptTaxonomyForUser(
  pool: Pool,
  userId: string,
  collections: readonly string[],
  tags: readonly AcceptedTagInput[],
  deps: AiJobDeps = {},
): Promise<AcceptTaxonomyResponse> {
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // The same lock a sync takes, so a collection cannot be created underneath a
    // device that is mid-sync, and two acceptances cannot both decide a name is
    // free.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);

    const existing = await readLiveListsOn(client, userId);
    const previous = await readAcceptedTaxonomy(client, userId);

    // The request carries names and the proposer's own line for each tag, and
    // nothing that can be read from the database instead. A collection's `why` is
    // genuinely lost here and provably does not matter: it only ever rendered in
    // the review list, and the digest that backs an accepted option is derived
    // from the library, not from the sentence. A tag's definition is the opposite
    // case — it is stored, sent to the model as the only evidence a member-less
    // tag has, and the server cannot invent it, so `parseTaxonomyAcceptance`
    // requires the client to send it back.
    const proposals: TaxonomyProposal[] = collections
      .map((name) => cleanName(name))
      .filter((name) => name !== "")
      .map((name) => ({ name, why: "" }));
    const proposedTags: TagProposal[] = tags
      .map((tag) => ({ name: normalizeTagName(tag.name), why: tag.definition }))
      .filter((tag) => tag.name !== "");

    const planned = planLists(proposals, existing, at, newId);
    for (const list of planned) {
      await client.query(
        `INSERT INTO nook_records (user_id, kind, id, data, deleted_at)
         VALUES ($1, 'list', $2, $3::jsonb, $4)
         ON CONFLICT (user_id, kind, id) DO UPDATE SET
           data=EXCLUDED.data,
           deleted_at=EXCLUDED.deleted_at,
           version=nextval('nook_sync_version_seq'),
           updated_at=now()`,
        [userId, list.id, JSON.stringify(list), list.deletedAt ?? null],
      );
    }

    // The library's real tags, so an accepted name that a bookmark already carries
    // is not stored: from that point on the library's own tags cover it.
    const libraryTags = await readLibraryTags(client, userId);
    const plannedTags = planTags(proposedTags, libraryTags);

    // The sample the collection digests are drawn from is read here, not sent: the
    // same deterministic stride the proposal was drawn from, over the same
    // population, so what backs an option is evidence the proposer actually saw.
    const library = await readLibraryOn(client, userId);
    const sample = selectSample(library, TAXONOMY_SAMPLE_SIZE);

    // `toAcceptedTaxonomy` merges: earlier batches of accepted names survive, so a
    // vocabulary accepted last spring is not emptied by one accepted today. A
    // collection entry is never dropped for being stale either — the classifier is
    // what ignores an option matching no live list.
    const taxonomy = toAcceptedTaxonomy(
      proposals,
      sample,
      at,
      previous.collections,
      plannedTags,
      previous.tags,
    );
    const saved = await saveAcceptedTaxonomy(client, userId, taxonomy);

    // A decision to file nothing was a decision against the options that existed
    // then. New collections or tags change the question, so every "nothing fit"
    // in `nook_ai_decided` is stale the moment they land — without this, a library
    // classified before it had any collections would never be filed into them.
    // Only the memory goes: a bookmark that was filed carries `ai`/`listId` and is
    // excluded by the eligibility rule itself, so this re-bills nothing already done.
    if (planned.length > 0 || plannedTags.length > 0) {
      await client.query("DELETE FROM nook_ai_decided WHERE user_id = $1", [userId]);
    }
    await client.query("COMMIT");

    return {
      createdCollections: planned.length,
      addedTags: plannedTags.length,
      // `planLists` drops the names that collided with a collection the account
      // already has, and maps what survives one-for-one, so the difference between
      // what was sent and what was created is the count of names already taken.
      dropped: proposals.length - planned.length,
      taxonomy: saved,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Unusable connection; releasing it is all that is left.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** `readLiveLists` on a transaction's own client. The variant exists because the
 *  acceptance has to read and then write the same rows without releasing the
 *  advisory lock, and a pool-level read would be a different session — a different
 *  snapshot, and outside the transaction entirely. */
async function readLiveListsOn(db: PoolClient, userId: string): Promise<ClassifiableList[]> {
  const result = await db.query<ListRow>(
    `SELECT id,
            data->>'name'      AS name,
            data->>'createdAt' AS created_at,
            data->>'updatedAt' AS updated_at,
            data->>'deletedAt' AS data_deleted_at
     FROM nook_records
     WHERE user_id=$1 AND kind='list' AND deleted_at IS NULL`,
    [userId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name ?? undefined,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
    deletedAt: row.data_deleted_at,
  }));
}

/** The library's own tag names, deduplicated. `planTags` normalises them itself, so
 *  this is the raw union of what `nook_records` carries. */
async function readLibraryTags(db: PoolClient, userId: string): Promise<string[]> {
  const result = await db.query<{ tags: unknown }>(
    `SELECT data->'tags' AS tags FROM nook_records
     WHERE user_id=$1 AND kind='bookmark' AND deleted_at IS NULL`,
    [userId],
  );
  const names: string[] = [];
  for (const row of result.rows) {
    if (!Array.isArray(row.tags)) continue;
    for (const name of row.tags) if (typeof name === "string") names.push(name);
  }
  return dedupe(names);
}

/** The same narrow projection `readLibrary` uses, on a transaction's client. */
async function readLibraryOn(db: PoolClient, userId: string): Promise<ClassifiableBookmark[]> {
  const result = await db.query<LibraryRow>(
    `SELECT ${LIBRARY_PROJECTION}
     FROM nook_records
     WHERE user_id=$1 AND kind='bookmark' AND deleted_at IS NULL`,
    [userId],
  );
  return result.rows.map(toRowBookmark);
}

// -- the review list (docs/ai.md, "Review list") ---------------------------
//
// A classification pass files what it is confident about and, since the
// change documented there, KEEPS its top guess for everything it wasn't —
// see `guess` on `ClassifyResponse` (ai.ts), `REVIEW_MIN_CONFIDENCE`, and the
// upsert in `runClassificationPass` above. This block is the other end of
// that: reading the kept guesses back (`readReviewList`, behind
// `GET /api/ai/review`) and letting a human accept or reject them
// (`resolveReviewItems`, behind `POST /api/ai/review/resolve`). Both routes
// live in server.ts, session-guarded the same way every other AI route is.

/** `GET /api/ai/review`'s one item. */
export interface AiReviewItem {
  bookmarkId: string;
  listId: string;
  listName: string;
  confidence: number;
}

/** `GET /api/ai/review`. `total` is the count before `limit` truncates it, so
 *  the client can show "200 of 340" instead of silently hiding the rest. */
export interface AiReviewList {
  items: AiReviewItem[];
  total: number;
}

/** Highest confidence first, capped here — the review list is a "look through
 *  these" queue for a human, not a paginated table, and 200 is generous next to
 *  the 25 a single classification pass ever claims at once. */
const REVIEW_LIST_LIMIT = 200;

function boundedConfidence(value: unknown): number {
  const num = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return num < 0 ? 0 : num > 1 ? 1 : num;
}

/**
 * `GET /api/ai/review`: the account's kept guesses, filtered to the ones still
 * worth acting on, highest confidence first.
 *
 * The DELETE is the "lazily pruned" half of docs/ai.md's Review list section —
 * nothing sweeps this table on a schedule the way `pruneDecided` sweeps
 * `nook_ai_decided`, because a stale row costs nothing sitting there and the
 * moment a human is about to look at the list is the cheapest possible moment
 * to notice one has gone stale. `REVIEW_ROW_LIVE` (ai-store.ts) is the exact
 * predicate `readReviewCount` uses for the status route's `reviewCount`, so the
 * two numbers can never quietly disagree about what "still pending" means —
 * see the comment on `AiStatusResponse.reviewCount` for why *that* read does
 * not also prune.
 *
 * The count and the page are two statements rather than one `count(*) over ()`
 * window: this route runs on demand, not on a tick, and a large library's list
 * is still two index-backed reads either way.
 */
export async function readReviewList(pool: Pool, userId: string): Promise<AiReviewList> {
  await pool.query(`DELETE FROM nook_ai_review r WHERE r.user_id = $1 AND NOT (${REVIEW_ROW_LIVE})`, [userId]);

  const [{ rows: countRows }, { rows: itemRows }] = await Promise.all([
    pool.query<{ count: number }>("SELECT count(*)::int AS count FROM nook_ai_review WHERE user_id = $1", [userId]),
    pool.query<{ bookmark_id: string; list_id: string; list_name: string | null; confidence: number }>(
      `SELECT r.bookmark_id, r.list_id, l.data->>'name' AS list_name, r.confidence
       FROM nook_ai_review r
       JOIN nook_records l ON l.user_id = r.user_id AND l.kind = 'list' AND l.id = r.list_id AND l.deleted_at IS NULL
       WHERE r.user_id = $1
       ORDER BY r.confidence DESC
       LIMIT $2`,
      [userId, REVIEW_LIST_LIMIT],
    ),
  ]);

  return {
    total: countOr(countRows[0]?.count),
    items: itemRows.map((row) => ({
      bookmarkId: row.bookmark_id,
      listId: row.list_id,
      // The JOIN above guarantees a live list, which `buildCollectionOptions`
      // never offers without a name — so an empty name here would mean this
      // join found a collection the classifier itself would have skipped.
      // Falling back to the id rather than an empty string is defensive, not
      // expected to ever be exercised.
      listName: trimmed(row.list_name) || row.list_id,
      confidence: boundedConfidence(row.confidence),
    })),
  };
}

/** One instruction in `POST /api/ai/review/resolve`'s body. */
export interface ReviewResolveItem {
  bookmarkId: string;
  action: "accept" | "reject";
  /** Overrides the stored guess's collection. Optional: the common case is
   *  accepting the guess Nook already made. */
  listId?: string;
}

/** `POST /api/ai/review/resolve`'s response. */
export interface ReviewResolveResult {
  filed: number;
  rejected: number;
  skipped: number;
}

/** A generous bound on one request, not a feature limit: the review list itself
 *  is capped at `REVIEW_LIST_LIMIT` (200), so a well-behaved client resolving
 *  "everything on screen" in one call never gets close to this. */
const MAX_REVIEW_RESOLVE_ITEMS = 200;

/**
 * `POST /api/ai/review/resolve`'s body: 1 to 200 instructions, each a bookmark
 * id, an action, and — for an `accept` that overrides the stored guess — a
 * collection id. Strict in the style of `parseTaxonomyAcceptance`: a malformed
 * entry is a 400 for the whole request rather than a silently dropped one,
 * because the caller is about to tell the user "N filed, M rejected" and a
 * quietly ignored item would make that count a lie.
 */
export function parseReviewResolveRequest(value: unknown): ReviewResolveItem[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  const body = value as Record<string, unknown>;
  if (!Array.isArray(body.items)) throw new Error("Invalid items array");
  if (body.items.length < 1 || body.items.length > MAX_REVIEW_RESOLVE_ITEMS) {
    throw new Error("Invalid items array");
  }
  const items: ReviewResolveItem[] = [];
  for (const entry of body.items) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid item");
    const record = entry as Record<string, unknown>;
    const bookmarkId = trimmed(record.bookmarkId);
    if (bookmarkId === "") throw new Error("Invalid bookmarkId");
    if (record.action !== "accept" && record.action !== "reject") throw new Error("Invalid action");
    let listId: string | undefined;
    if (record.listId !== undefined) {
      listId = trimmed(record.listId);
      if (listId === "") throw new Error("Invalid listId");
    }
    items.push({ bookmarkId, action: record.action, ...(listId ? { listId } : {}) });
  }
  return items;
}

/**
 * The receipt written when a reviewed guess is accepted — the same shape a
 * classification decision writes onto `ai` (`attribution()` in
 * ai-classify.ts: `model`, `at`, `collectionConfidence`), plus `source:
 * "review"` so this can be told apart from a decision the pass itself filed.
 * `model` is deliberately the generic "jev" rather than a specific version
 * string: `nook_ai_review` never stored which exact model version answered,
 * only the confidence, so restating a version here would be a guess dressed
 * as a fact — precisely what this codebase's own comments elsewhere warn
 * against doing with a stored number.
 */
function reviewAttribution(confidence: number, at: string): Record<string, unknown> {
  return { model: "jev", at, collectionConfidence: confidence, source: "review" };
}

async function readReviewRow(
  pool: Pool,
  userId: string,
  bookmarkId: string,
): Promise<{ listId: string; confidence: number } | null> {
  const result = await pool.query<{ list_id: string; confidence: number }>(
    "SELECT list_id, confidence FROM nook_ai_review WHERE user_id = $1 AND bookmark_id = $2",
    [userId, bookmarkId],
  );
  const row = result.rows[0];
  return row ? { listId: row.list_id, confidence: row.confidence } : null;
}

async function deleteReviewRow(pool: Pool, userId: string, bookmarkId: string): Promise<void> {
  await pool.query("DELETE FROM nook_ai_review WHERE user_id = $1 AND bookmark_id = $2", [userId, bookmarkId]);
}

/** The target collection's live name, or null when it is gone — the same
 *  "offering a dead collection is worse than skipping it" reasoning
 *  `buildCollectionOptions` applies to the classifier's own options. */
async function readLiveListName(pool: Pool, userId: string, listId: string): Promise<string | null> {
  const result = await pool.query<{ name: string | null }>(
    "SELECT data->>'name' AS name FROM nook_records WHERE user_id = $1 AND kind = 'list' AND id = $2 AND deleted_at IS NULL",
    [userId, listId],
  );
  const name = trimmed(result.rows[0]?.name);
  return name === "" ? null : name;
}

/**
 * `POST /api/ai/review/resolve`: accept or reject each instruction, one at a
 * time. Sequential, not pooled: the caller is a human clicking a button, not a
 * background pass, and up to 200 individual writes is not a rate that needs
 * the classification pool's concurrency bound.
 *
 * **accept** files the bookmark through the *exact same write path* a
 * classification decision uses, `applyServerWrite`, with the same
 * guard-then-build shape:
 *
 * - The guard re-checks the row `applyServerWrite` re-reads inside its lock,
 *   and it is deliberately `listId == null` rather than
 *   `bookmarkNeedsClassification` (which also demands `ai == null`) — a
 *   bookmark whose *tags* were already filed by this same low-confidence
 *   decision carries a non-null `ai` already, and it must still be acceptable
 *   here. Only the collection assignment is what "still unfiled" means for
 *   this route.
 * - The patch is built from that same fresh row, so a filing that lands here
 *   can never be computed against data a concurrent sync has since replaced.
 * - A bookmark some other write already filed between the guess being kept and
 *   this call landing reports `skipped`, not `filed` — the same "a human wins"
 *   rule the classification pass itself follows against its own re-check.
 *
 * **reject** only deletes the review row. `nook_ai_decided` — written when the
 * pass first decided on this bookmark — is left alone on purpose: rejecting a
 * suggestion must not make the bookmark billable again, which is the entire
 * reason this route never touches that table.
 *
 * The review row is deleted in **both** outcomes of an accept — whether or not
 * the file actually lands — and on every reject, so a resolved item never
 * reappears on the next `GET /api/ai/review`.
 */
export async function resolveReviewItems(
  pool: Pool,
  userId: string,
  items: readonly ReviewResolveItem[],
  deps: AiJobDeps = {},
): Promise<ReviewResolveResult> {
  const at = new Date((deps.now ?? Date.now)()).toISOString();
  let filed = 0;
  let rejected = 0;
  let skipped = 0;

  for (const item of items) {
    const stored = await readReviewRow(pool, userId, item.bookmarkId);
    if (!stored) {
      // Nothing to resolve: already resolved by an earlier call, already
      // pruned as stale, or a bookmarkId the client made up. Either way there
      // is no guess left to act on.
      skipped++;
      continue;
    }

    if (item.action === "reject") {
      await deleteReviewRow(pool, userId, item.bookmarkId);
      rejected++;
      continue;
    }

    const listId = item.listId ?? stored.listId;
    const listName = await readLiveListName(pool, userId, listId);
    // Deleted here, before the write attempt and regardless of its outcome —
    // see the doc comment above for why an accept always clears the row.
    await deleteReviewRow(pool, userId, item.bookmarkId);
    if (!listName) {
      skipped++;
      continue;
    }

    const result = await applyServerWrite(pool, userId, "bookmark", item.bookmarkId, at, {
      guard: (record) => toClassifiable({ ...record.data, id: record.id }).listId == null,
      build: (record) => {
        const fresh = toClassifiable({ ...record.data, id: record.id });
        // Merged, not replaced: the same low-confidence decision may have
        // filed tags, and its receipt for those must survive the accept.
        const previous = fresh.ai && typeof fresh.ai === "object" ? (fresh.ai as Record<string, unknown>) : {};
        const patch: Partial<ClassifiableBookmark> = {
          listId,
          listName,
          ai: { ...previous, ...reviewAttribution(stored.confidence, at) },
        };
        return patchChangesSomething(fresh, patch) ? patch : null;
      },
    });
    if (result.wrote) filed++;
    else skipped++;
  }

  return { filed, rejected, skipped };
}

// -- request validation ---------------------------------------------------

/**
 * `POST /api/ai/taxonomy/propose`'s body. Tolerant of an absent `language` and
 * strict about a wrong one, in the style of `parseAiUserSettingsPatch`: "auto" is
 * the server's own default, so the client omits it rather than sending the word,
 * and a language nobody has heard of is a 400 rather than a silent fallback to
 * English. An unknown language falls back inside `parseLanguage` in ./ai.ts when it
 * is absent; this rejects it when it is present and wrong.
 */
export function parseTaxonomyProposeBody(value: unknown): { language?: TaxonomyLanguage } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  const record = value as Record<string, unknown>;
  if (record.language === undefined) return {};
  if (typeof record.language !== "string") throw new Error("Invalid language");
  const allowed = ["auto", "en", "tr", "de", "fr", "es"];
  if (!allowed.includes(record.language)) throw new Error("Invalid language");
  return { language: record.language as TaxonomyLanguage };
}

/** One tag the user kept, with the proposer's own line for what it means. */
export interface AcceptedTagInput {
  name: string;
  definition?: string;
}

/**
 * `PUT /api/ai/taxonomy`'s body: collection names, and tags as name + definition.
 *
 * A name that is not a non-empty string is a 400, not a silently dropped entry —
 * the review list tells the user what it is about to create, and quietly skipping
 * one of the names they ticked is exactly the "nothing you ticked should vanish"
 * failure `MAX_TAXONOMY_TAGS` was raised to avoid.
 *
 * **The tag definition is the client's to send and the server cannot reconstruct
 * it.** The proposer wrote it, the review list showed it, the user accepted it
 * against that text, and it is the only evidence a member-less tag will ever
 * have: `buildTagOptions` can offer "yazılım geliştirme" by name, but the whole
 * point of storing a definition is that the name alone is the thinnest possible
 * input to ask a model "does this belong under it?". Measured over 80 real
 * bookmarks, definitions put **12 of 12** vocabulary entries to use against
 * **10 of 12** for bare names, at 24% more input tokens (docs/ai.md,
 * "Two things about the vocabulary that were wrong first"). Dropping the
 * definition on the way in is a measured regression, so the body carries it even
 * though the sample, the existing lists and the library's tags are all read from
 * `nook_records` instead of being sent.
 *
 * `definition` is optional, because a proposer that omitted its `why` yields a
 * perfectly usable tag — just one asked about by name alone, which is what every
 * tag was before definitions existed.
 */
export function parseTaxonomyAcceptance(value: unknown): {
  collections: string[];
  tags: AcceptedTagInput[];
} {
  if (value === undefined || value === null) throw new Error("Invalid request");
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  const record = value as Record<string, unknown>;
  return {
    collections: parseNameList(record.collections, "collections"),
    tags: parseAcceptedTags(record.tags),
  };
}

function parseNameList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid ${field}`);
  if (value.length > MAX_ACCEPTED_NAMES) throw new Error(`Too many ${field}`);
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") throw new Error(`Invalid ${field}`);
    const name = cleanName(entry);
    if (name === "") throw new Error(`Invalid ${field}`);
    // Exact-duplicate names are not an error, they are the same name ticked twice;
    // `planLists` and `planTags` do the real case-folding dedupe.
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

function parseAcceptedTags(value: unknown): AcceptedTagInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Invalid tags");
  if (value.length > MAX_ACCEPTED_NAMES) throw new Error("Too many tags");
  const tags: AcceptedTagInput[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    // A bare string is accepted so an older panel still works; it just arrives
    // without a definition, which is a weaker tag rather than a broken one.
    const record = (typeof entry === "string" ? { name: entry } : entry) as Record<string, unknown> | null;
    if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid tags");
    const name = cleanName(record.name);
    if (name === "") throw new Error("Invalid tags");
    const definition = typeof record.definition === "string" ? cleanName(record.definition) : "";
    if (seen.has(name)) continue;
    seen.add(name);
    tags.push(definition ? { name, definition } : { name });
  }
  return tags;
}

// -- the tick -------------------------------------------------------------

/** Accounts whose queue is not empty, plus accounts that want a pass, capped and
 *  ordered by how much work each has. Accounts with nothing queued but
 *  `autoClassify` on are considered on every tick so a bookmark saved while the
 *  worker was down is picked up even if the sync hook that enqueued it was
 *  missed.
 *
 *  The third branch is the same idea for summarisation. There is no
 *  `nook_ai_summary_jobs` to read for depth — a candidate is a candidate at any
 *  moment, and the attempt table is a memory of what has already been asked
 *  about rather than a queue — so an account with `autoSummarize` on is
 *  considered on every tick and its own top-up decides in one indexed read
 *  whether there is anything to do. That read is the whole cost of considering
 *  every account with the toggle on, which is why it is acceptable to do it. */
const TICK_ACCOUNTS_SQL = `SELECT user_id AS id
  FROM (
    SELECT user_id, 1 AS queued FROM nook_ai_jobs
    UNION ALL
    SELECT s.user_id, 0 AS queued
    FROM nook_ai_settings s
    WHERE coalesce((s.data->>'autoClassify')::boolean, false)
    UNION ALL
    SELECT s.user_id, 0 AS queued
    FROM nook_ai_settings s
    WHERE coalesce((s.data->>'autoSummarize')::boolean, false)
  ) AS candidates
  GROUP BY user_id
  ORDER BY max(queued) DESC, user_id
  LIMIT $1`;

let lastReconcileAt = 0;

/**
 * Whether a tick is already in flight. `startAiWorker`'s `setInterval` fires on
 * a fixed clock regardless of whether the previous tick's promise has settled,
 * and at the 10-second default a tick over a handful of accounts — each up to
 * 25 classify calls at concurrency 4, plus the summarisation half — can easily
 * still be running when the next one is due. This is the guard that keeps a
 * slow tick from piling up concurrent `tickAiWorker` runs rather than simply
 * running back-to-back.
 *
 * It is a throughput and load guard, not a correctness one — see the note on
 * `tickAiWorker` below for why an overlap could never double-bill even without
 * it. It is worth having anyway: an unguarded pile-up would run the accounts
 * query and, for every account already mid-pass, an `acquireRunLease` call
 * that is certain to fail, over and over, for as long as the slow tick keeps
 * running — work that buys nothing and only grows the number of ticks stacked
 * up behind it.
 */
let tickInFlight = false;

/**
 * One tick: consider the accounts, and for each one refill, run, and — every
 * fifteen minutes — reconcile.
 *
 * Sequential, and one pass at a time, deliberately: the instantaneous request rate
 * is then `CLASSIFY_CONCURRENCY` however many accounts are waiting, which is the
 * number the upstream's limit is about. Concurrency here would buy a few minutes
 * on a 50-account deployment and cost a rate limit. The summarisation pass is
 * sequenced the same way for the same reason: it is a window of concurrent calls
 * at `SUMMARY_CONCURRENCY` (also 4), and running the two at once would double the
 * instantaneous rate against the same proposer.
 *
 * Reconcile instead of topping up on the reconcile tick, because
 * `reconcileClassification` is a top-up at a larger limit plus a prune, and doing
 * both would be the same statement twice. The summarisation prune rides along on
 * the same tick, beside `pruneDecided` and for the same reason: both tables are
 * unbounded by design and both are only dead weight once the bookmark behind them
 * is gone.
 *
 * **A tick that outlives its own interval cannot double-process, with or
 * without `tickInFlight` above.** The claim in `nook_ai_jobs` is one atomic
 * `DELETE ... RETURNING`, so two ticks can never claim the same row; and
 * `runClassificationPass`'s first gate is `acquireRunLease`, so a second tick
 * that reaches an account already mid-pass fails the lease and returns
 * immediately rather than reading the library or claiming anything a second
 * time (see `acquireRunLease` in ai-store.ts and the lease note on
 * `AI_TICK_INTERVAL_MS` above). `tickInFlight` exists on top of that guarantee
 * for a narrower reason: without it, an overlap would still be *safe*, but it
 * would also re-run `TICK_ACCOUNTS_SQL` and a doomed `acquireRunLease` call per
 * account for as long as the slow tick kept running, which is waste rather
 * than risk. It also keeps `lastReconcileAt` honest — updated by at most one
 * tick at a time — so two overlapping ticks cannot both decide they are the
 * reconcile tick and run the larger top-up and prune twice.
 *
 * Never throws. This runs from a bare `setInterval`, where a rejection is an
 * unhandled rejection and an unhandled rejection is a dead process. Each account is
 * guarded separately too: one account's broken row must not cost the other
 * forty-nine their pass.
 */
export async function tickAiWorker(pool: Pool): Promise<void> {
  if (tickInFlight) return;
  tickInFlight = true;
  try {
    const accounts = await pool.query<{ id: string }>(TICK_ACCOUNTS_SQL, [TICK_ACCOUNT_LIMIT]);
    const nowMs = Date.now();
    const reconciling = nowMs - lastReconcileAt >= AI_RECONCILE_INTERVAL_MS;

    for (const account of accounts.rows) {
      try {
        if (reconciling) {
          await reconcileClassification(pool, account.id);
          await pruneSummaries(pool, account.id);
        } else {
          await topUpClassificationQueue(pool, account.id);
        }
        await runClassificationPass(pool, account.id);
        // The summarisation half, after the classification one and gated on its own
        // toggle inside its own top-up: the two passes never read each other's
        // state, and an account with only one of them on pays only for that one.
        await topUpSummaryQueue(pool, account.id);
        await runSummarizationPass(pool, account.id);
      } catch (error) {
        console.warn(`[ai-jobs] tick failed for ${account.id}: ${errorMessage(error)}`);
      }
    }
    if (reconciling) lastReconcileAt = nowMs;
  } catch (error) {
    console.error("[ai-jobs] AI worker tick failed:", error);
  } finally {
    tickInFlight = false;
  }
}

function tickIntervalMs(): number {
  const parsed = Number(process.env.NOOK_AI_TICK_MS);
  if (!Number.isFinite(parsed) || parsed < 1_000) return AI_TICK_INTERVAL_MS;
  return Math.floor(parsed);
}

/**
 * The worker's clock. A per-minute tick, because a pass is a queue and a queue
 * needs a clock — the same relationship server.ts's reconcile timer has with the
 * embedding index.
 *
 * The first run is delayed rather than immediate for the same reason that one is:
 * the container may still be applying `schema.sql`, and a tick that reads before
 * `nook_ai_jobs` exists only logs a failure.
 */
export function startAiWorker(pool: Pool): void {
  setTimeout(() => void tickAiWorker(pool), FIRST_TICK_DELAY_MS);
  setInterval(() => void tickAiWorker(pool), tickIntervalMs());
}
