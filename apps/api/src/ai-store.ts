/**
 * The server's answer to the extension's `ai.cursor`, `ai.log` and
 * `ai.taxonomy` IndexedDB meta keys: persisted run state, the decision log and
 * the accepted taxonomy, one row per account in `nook_ai_state` and
 * `nook_ai_taxonomy`. See docs/ai.md, "Storage" and "Progress notes", and
 * docs/ai-cloud-contract.md for the routes that read them.
 *
 * Those keys were per-origin and did not sync, which is why the status surface
 * could only ever be rendered on the host that had run a pass. Both records are
 * account rows now, so the panel shows the same numbers on every host and the
 * worker's only memory of what it has already bought is on the server rather
 * than in a browser that may not exist.
 *
 * The discipline here is the one `ai-settings.ts` already keeps, and it is
 * copied deliberately rather than reinvented: **never trust a stored value.**
 * These columns are jsonb written by a background pass, read by a route, and
 * handed to a panel that renders the numbers as fact — so every read runs the
 * value through a normaliser with a defined answer for every input, and every
 * write is a single statement rather than a read-modify-write.
 *
 * One thing is *not* normalised, on purpose: `nook_ai_state.lease_until` and its
 * sibling `summary_lease_until` are columns rather than fields of `data`, and
 * their acquire is a single conditional statement. A lock you read, merge and
 * write back is a lock two replicas can both take.
 *
 * This module imports `readSummarizeStatus` from ai-summary.ts, and ai-summary.ts
 * imports the lease from here — a cycle, and a deliberate one. Every use on both
 * sides is inside a function body, neither module does anything at load time, and
 * the alternatives are worse: either the account's single state row is read twice
 * per status call, or the composition of the whole Settings -> AI surface lives
 * somewhere that does not own the run state.
 */

import type { Pool, PoolClient } from "pg";
import { aiAvailability } from "./ai.js";
import { getAiUserSettings, type AiUserSettings } from "./ai-settings.js";
import { normalizeAcceptedTaxonomy, type AcceptedTaxonomy } from "./ai-taxonomy.js";
import { readSummarizeStatus } from "./ai-summary.js";

// -- types ----------------------------------------------------------------

/**
 * One decision, kept for the confidence histogram in Settings → AI.
 *
 * `confidence` is the `Choice` confidence for the collection decision, and 0
 * for a decision that filed nothing. The `__none__` option is the model's most
 * confident answer on this library (median 0.99 — docs/ai.md), so the histogram
 * is not a quality signal and is not a threshold; it is the record of what the
 * model said, which is what the panel has to be able to show.
 */
export interface AiLogEntry {
  id: string;
  confidence: number;
  assigned: boolean;
  at: string;
}

/**
 * `nook_ai_state.data`, as code.
 *
 * `unavailableUntil` and `backoffUntil` are the only two cooldowns, and they are
 * two conditions rather than two stances: no `TYPESAFE_API_KEY` configured
 * (a deployment state, so a quiet hour rather than an error) and a rate limit or
 * an unreachable model (a real failure, so an exponential backoff). The
 * extension had a third — a 30-minute park after a 401 — because it was a client
 * and a 401 meant the session was gone. A background pass here holds no session,
 * so it cannot be signed out and that window has no meaning.
 *
 * `backoffMs` is the current step rather than a boolean, so the next backoff
 * doubles instead of restarting at the floor.
 */
export interface AiRunState {
  processed: number;
  assigned: number;
  tagged: number;
  skipped: number;
  /** ISO of the last pass that got past the cooldowns, or null. */
  lastRunAt: string | null;
  lastError: string | null;
  unavailableUntil: string | null;
  backoffUntil: string | null;
  backoffMs: number;
  log: AiLogEntry[];
  /**
   * The same two cooldown windows and a third set of counters, for the
   * summarisation pass, under `data.summarize`.
   *
   * A sub-record and not a second table because there is one row per account and
   * the two passes' states answer the same questions: how many times did this
   * thing run, when, what went wrong, and is anything stopping it right now.
   * `unavailableUntil` in particular means the same sentence for both — no
   * `NOOK_AI_PROPOSER` key — so a single column could have carried both, and two
   * counters on one row is a far smaller thing than a second table with its own
   * cascade and its own lease to keep in step. What is deliberately *not* shared
   * is the lease; see the two columns in schema.sql for why.
   */
  summarize: SummarizeRunState;
}

/** `nook_ai_state.data.summarize`. See `AiRunState.summarize`. */
export interface SummarizeRunState {
  processed: number;
  written: number;
  skipped: number;
  lastRunAt: string | null;
  lastError: string | null;
  unavailableUntil: string | null;
  backoffUntil: string | null;
  backoffMs: number;
}


/**
 * The wire shape, from docs/ai-cloud-contract.md.
 *
 * The counters are the same numbers; the two cooldown stamps become booleans,
 * because "when" is a thing only the worker acts on and "is it in effect right
 * now" is the only thing a panel can render. A cooldown in the past reads as not
 * in effect, which is why these are derived here rather than stored twice.
 */
export interface AiRunSummary {
  processed: number;
  assigned: number;
  tagged: number;
  skipped: number;
  lastRunAt: string | null;
  lastError: string | null;
  /** True while the no-AI-key cooldown is still in effect. */
  isUnavailable: boolean;
  /** True while a rate-limit / network backoff is still in effect. */
  isBackingOff: boolean;
  /** Last 200 decisions, newest last. */
  log: AiLogEntry[];
}

/** `GET /api/ai/status`: one read for the whole Settings → AI surface, so the
 *  panel never renders a state stitched together from three endpoints. */
export interface AiStatusResponse {
  /** Whether this server can classify at all: TYPESAFE_API_KEY is present. */
  available: boolean;
  settings: AiUserSettings;
  /** Jobs waiting to be classified. */
  pending: number;
  /** The accepted taxonomy currently in force. */
  taxonomy: AcceptedTaxonomy;
  run: AiRunSummary;
  /** The summarisation pass's half of the same surface. Additive, so an older
   *  panel that ignores it keeps working. */
  summarize: SummarizeStatus;
}

/**
 * The summarisation half of `GET /api/ai/status`.
 *
 * `summarised` and `pending` are SQL counts over `nook_records`, so they are the
 * real numbers rather than an upper bound. The panel used to count its own
 * library for this row, which could only ever produce a bound: it counted every
 * record with no summary, including the ones the 400-character gate would never
 * accept, and had to say so in the copy. The server can apply the same gate in
 * the query, so the hedge is gone.
 *
 * `available` is `summarizeAvailability().summarize` — the same value the
 * deleted `POST /api/summarize`'s 503 was built from — so the panel's dot and the
 * worker's willingness to run cannot describe two different deployments.
 */
export interface SummarizeStatus {
  /** Whether a summariser is configured: NOOK_AI_PROPOSER plus its key. */
  available: boolean;
  /** The model a call would use right now, defaults included. */
  model: string;
  /** Candidates waiting to be summarised. */
  pending: number;
  /** Live records carrying a non-empty summary. */
  summarised: number;
  written: number;
  skipped: number;
  lastRunAt: string | null;
  lastError: string | null;
  /** True while the no-proposer-key cooldown is still in effect. */
  isUnavailable: boolean;
  /** True while a rate-limit / network backoff is still in effect. */
  isBackingOff: boolean;
}


/** Ring-buffer size for the decision log. Fixed, not a growing log: see
 *  `pushLogEntry`. The extension's `AI_LOG_MAX_ENTRIES`, kept at 200 because the
 *  panel's histogram is only ever drawn from the tail and 200 is what it draws. */
export const AI_LOG_MAX_ENTRIES = 200;

/** The backoff floor and ceiling, in ms. 60s is the natural floor because the
 *  upstream's limit is per minute; 30 minutes is well below what it would cost
 *  to keep re-probing a key that is being throttled. Shared by both passes,
 *  because an upstream that throttles is the same condition whichever model it
 *  was asked. */
export const AI_BACKOFF_BASE_MS = 60_000;
export const AI_BACKOFF_CAP_MS = 30 * 60_000;

/** No model key at all: a quiet hour, not an error and not a backoff. A missing
 *  key is a deployment state — it takes a deploy, and re-probing it every minute
 *  for the life of the account helps nobody. Shared rather than duplicated for
 *  the same reason, and it is a store constant because both cooldown windows
 *  live in the row this module owns. */
export const AI_UNAVAILABLE_COOLDOWN_MS = 60 * 60_000;


/**
 * How long a pass may hold the lease.
 *
 * 120 seconds is chosen to be enormous next to a real pass and small next to an
 * outage. A healthy batch is 25 requests at concurrency 4 — seven waves, and a
 * measured round trip of well under a second, so a pass is a few seconds of work
 * plus database time; 120s is two orders of magnitude of headroom, and it is
 * still far below the interval at which a user would notice the feature has
 * stopped after a replica is killed mid-pass. A longer lease would also not buy
 * correctness: the claim in `nook_ai_jobs` is what stops a bookmark being bought
 * twice, so a lease that expired early costs a second pass finding an empty queue
 * and a slightly stale counter, not a second charge.
 */
const DEFAULT_LEASE_SECONDS = 120;

function leaseSeconds(): number {
  const parsed = Number(process.env.NOOK_AI_LEASE_SECONDS);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_LEASE_SECONDS;
  return Math.floor(parsed);
}

// -- pure: reading a stored row -------------------------------------------

function countOr(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return value > 0 ? Math.floor(value) : 0;
}

function probabilityOr(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * An ISO stamp, or null. Kept as written when it parses — a cooldown in the
 * future is the whole point of a cooldown, and a `lastRunAt` that reads later than
 * "now" is a clock difference, not damage. An unparseable one is dropped rather
 * than guessed at, exactly as `normalizeAcceptedTaxonomy` drops `acceptedAt`.
 */
function stampOrNull(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function normalizeLog(value: unknown): AiLogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: AiLogEntry[] = [];
  for (const raw of value.slice(-AI_LOG_MAX_ENTRIES)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const record = raw as { id?: unknown; confidence?: unknown; assigned?: unknown; at?: unknown };
    if (typeof record.id !== "string" || record.id === "") continue;
    entries.push({
      id: record.id,
      confidence: probabilityOr(record.confidence),
      assigned: record.assigned === true,
      at: typeof record.at === "string" ? record.at : "",
    });
  }
  return entries;
}

/**
 * Coerces anything — no row, a row written by an older build, a hand-edited one,
 * a half-written one — into a complete `AiRunState`. Total by construction, in
 * the style of `normalizeAiUserSettings`, so nothing downstream has to
 * special-case a missing or partial record.
 *
 * The counters are cumulative display values, so a garbage one is zeroed rather
 * than propagated: a panel showing "processed: NaN" is worse than a panel showing
 * a count that restarted.
 *
 * The `summarize` sub-record goes through the same discipline and has to tolerate
 * being *absent*, not merely malformed: every row written before the summarisation
 * pass existed has no such key, and a normaliser that threw on one would take the
 * classification pass's status down with it.
 */
export function normalizeAiRunState(value: unknown): AiRunState {
  const raw = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return {
    processed: countOr(raw.processed),
    assigned: countOr(raw.assigned),
    tagged: countOr(raw.tagged),
    skipped: countOr(raw.skipped),
    lastRunAt: stampOrNull(raw.lastRunAt),
    lastError: typeof raw.lastError === "string" && raw.lastError.trim() !== "" ? raw.lastError : null,
    unavailableUntil: stampOrNull(raw.unavailableUntil),
    backoffUntil: stampOrNull(raw.backoffUntil),
    backoffMs: countOr(raw.backoffMs),
    log: normalizeLog(raw.log),
    summarize: normalizeSummarizeRunState(raw.summarize),
  };
}

/** See `normalizeAiRunState`. Total over a missing, partial or hostile value. */
function normalizeSummarizeRunState(value: unknown): SummarizeRunState {
  const raw = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as Record<string, unknown>;
  return {
    processed: countOr(raw.processed),
    written: countOr(raw.written),
    skipped: countOr(raw.skipped),
    lastRunAt: stampOrNull(raw.lastRunAt),
    lastError: typeof raw.lastError === "string" && raw.lastError.trim() !== "" ? raw.lastError : null,
    unavailableUntil: stampOrNull(raw.unavailableUntil),
    backoffUntil: stampOrNull(raw.backoffUntil),
    backoffMs: countOr(raw.backoffMs),
  };
}


/** The latest window still in effect, or null when the worker may run. A window
 *  whose end has passed is not in effect, which is the whole difference between
 *  a stored stamp and a rendered boolean.
 *
 *  Exported because the summarisation pass resolves its own pair against the same
 *  clock: a second copy of "is this window still open" is exactly the kind of
 *  thing that ends up answering two different questions. */
export function inEffect(until: string | null, nowMs: number): boolean {
  if (until === null) return false;
  const parsed = Date.parse(until);
  return !Number.isNaN(parsed) && parsed > nowMs;
}

/**
 * The cooldown that currently applies, as its ISO stamp, or null.
 *
 * The *latest* of the two, deliberately: whichever window ends last is the one
 * that decides how long the worker must stay quiet, and it is the one a `lastError`
 * should describe. The extension's version sorted the windows it had (three of
 * them) the same way for the same reason.
 *
 * The two stamps are parameters rather than read off an `AiRunState` because the
 * summarisation pass keeps its own pair under `data.summarize` and wants the same
 * answer to the same question — `ai-summary.ts` cannot construct a whole
 * `AiRunState` out of a sub-record, and it must not be a second implementation of
 * "which window governs".
 */
export function activeCooldown(state: AiRunState, nowMs: number): string | null {
  return activeCooldownBetween(state.unavailableUntil, state.backoffUntil, nowMs);
}

export function activeCooldownBetween(
  unavailableUntil: string | null,
  backoffUntil: string | null,
  nowMs: number,
): string | null {
  const windows = [unavailableUntil, backoffUntil].filter(
    (value): value is string => value !== null && inEffect(value, nowMs),
  );
  if (windows.length === 0) return null;
  return windows.sort()[windows.length - 1];
}


/** The wire view of the stored state, with the two windows resolved against the
 *  clock the caller is holding. `nowMs` is a parameter so the same state reads
 *  the same way twice in a test and so the worker and the route cannot disagree
 *  about whether a cooldown is in effect. */
export function summarizeRunState(state: AiRunState, nowMs: number): AiRunSummary {
  return {
    processed: state.processed,
    assigned: state.assigned,
    tagged: state.tagged,
    skipped: state.skipped,
    lastRunAt: state.lastRunAt,
    lastError: state.lastError,
    isUnavailable: inEffect(state.unavailableUntil, nowMs),
    isBackingOff: inEffect(state.backoffUntil, nowMs),
    log: [...state.log],
  };
}

/**
 * Appends one decision and drops the oldest overflow. A ring buffer, not a log:
 * the panel only ever reads the tail for its histogram, and an append-only array
 * in a jsonb column is rewritten on every pass and would grow for the life of the
 * account.
 */
export function pushLogEntry(log: AiLogEntry[], entry: AiLogEntry): void {
  log.push(entry);
  if (log.length > AI_LOG_MAX_ENTRIES) log.splice(0, log.length - AI_LOG_MAX_ENTRIES);
}

// -- reads and writes -----------------------------------------------------

/** Anything that can run a statement: a pool, or the client an open transaction
 *  is running on. Only the taxonomy pair needs the second form — an acceptance
 *  reads the previous taxonomy and writes the new one inside its own
 *  transaction, so a pool-level read would read a row the transaction is about to
 *  replace. */
export type Queryable = Pick<PoolClient, "query">;

interface StateRow {
  data: unknown;
}

/** Defaults when no row exists. An account that has never run a pass has not
 *  failed, it simply has no history — and the values below are all zero/null, so
 *  there is nothing to distinguish. */
export async function readRunState(pool: Pool, userId: string): Promise<AiRunState> {
  const result = await pool.query<StateRow>("SELECT data FROM nook_ai_state WHERE user_id = $1", [userId]);
  return normalizeAiRunState(result.rows[0]?.data);
}

/**
 * The classification half of the row, in one statement.
 *
 * A jsonb `||` merge rather than a replacement, which is the opposite of what
 * this said while the row had one writer, and the reason is that it now has two.
 * A pass still reads the whole row, mutates its own half and writes it back, so a
 * full replacement would let a classification pass that read the row at T0
 * overwrite a summarisation pass that wrote the `summarize` counters at T1. The
 * two leases do not prevent it — they are separate columns on purpose — so each
 * writer's payload carries only its own half and the merge keeps the other.
 *
 * Within the classification half the merge is still a replacement: `normalizeAiRunState`
 * produces every key, so each one is overwritten with the value this pass read and
 * changed, and a stale counter is replaced rather than accumulated.
 */
export async function writeRunState(pool: Pool, userId: string, next: AiRunState): Promise<void> {
  // The sub-record is deliberately not sent: it is not this writer's to write, and
  // sending the copy this pass happened to read is how a lost update happens.
  const { summarize: _summarize, ...classification } = next;
  await pool.query(
    `INSERT INTO nook_ai_state (user_id, data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET
       data = nook_ai_state.data || EXCLUDED.data,
       updated_at = now()`,
    [userId, JSON.stringify(classification)],
  );
}

/**
 * The summarisation half, in one statement. The mirror of `writeRunState`, and
 * disjoint from it by construction: the payload is wrapped so that the merge can
 * only ever touch the `summarize` key.
 */
export async function writeSummarizeRunState(
  pool: Pool,
  userId: string,
  next: SummarizeRunState,
): Promise<void> {
  await pool.query(
    `INSERT INTO nook_ai_state (user_id, data)
     VALUES ($1, jsonb_build_object('summarize', $2::jsonb))
     ON CONFLICT (user_id) DO UPDATE SET
       data = nook_ai_state.data || EXCLUDED.data,
       updated_at = now()`,
    [userId, JSON.stringify(next)],
  );
}


/** Jobs waiting. A count on the queue's own index, so the status route costs
 *  nothing on a large library. */
export async function readPendingCount(pool: Pool, userId: string): Promise<number> {
  const result = await pool.query<{ count: number }>(
    "SELECT count(*)::int AS count FROM nook_ai_jobs WHERE user_id = $1",
    [userId],
  );
  return countOr(result.rows[0]?.count);
}

/** Defaults when no row exists: never accepted, nothing proposed. */
export async function readAcceptedTaxonomy(db: Queryable, userId: string): Promise<AcceptedTaxonomy> {
  const result = await db.query<StateRow>("SELECT data FROM nook_ai_taxonomy WHERE user_id = $1", [userId]);
  return normalizeAcceptedTaxonomy(result.rows[0]?.data);
}

/** The whole record, normalized on the way out so a hand-edited row cannot put a
 *  malformed option in front of the model. */
export async function saveAcceptedTaxonomy(
  db: Queryable,
  userId: string,
  taxonomy: AcceptedTaxonomy,
): Promise<AcceptedTaxonomy> {
  const result = await db.query<StateRow>(
    `INSERT INTO nook_ai_taxonomy (user_id, data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET
       data = EXCLUDED.data,
       updated_at = now()
     RETURNING data`,
    [userId, JSON.stringify(normalizeAcceptedTaxonomy(taxonomy))],
  );
  return normalizeAcceptedTaxonomy(result.rows[0]?.data);
}

/**
 * The whole status surface, in one read.
 *
 * `available` is `aiAvailability().classify` — the same value the classify
 * route's 503 is built from — so the panel's dot and the route cannot disagree
 * about whether this server can classify. Deriving it from anything else (a
 * successful call, a stored settings row) would let a misconfigured deployment
 * render a feature as available and then 503 on the only call that would have
 * proven otherwise. `summarize.available` is the same argument one feature over:
 * it is `summarizeAvailability().summarize`, the value the deleted
 * `POST /api/summarize` answered 503 from.
 *
 * The reads are independent, so they are concurrent: one round trip's latency
 * instead of five, and nothing here is slow enough to be worth serialising. The
 * two SQL counts behind `summarize.pending` / `summarize.summarised` are the most
 * expensive of the six on a large library and still sub-millisecond on the
 * measured 1,061-bookmark one, which is the arrangement the whole route rests on:
 * exact numbers, read on demand, rather than a bound the client could compute
 * itself and had to hedge in the copy.
 */
export async function readAiStatus(pool: Pool, userId: string, nowMs: number = Date.now()): Promise<AiStatusResponse> {
  const [settings, pending, taxonomy, run, summarize] = await Promise.all([
    getAiUserSettings(pool, userId),
    readPendingCount(pool, userId),
    readAcceptedTaxonomy(pool, userId),
    readRunState(pool, userId),
    readSummarizeStatus(pool, userId, nowMs),
  ]);
  return {
    available: aiAvailability().classify,
    settings,
    pending,
    taxonomy,
    run: summarizeRunState(run, nowMs),
    summarize,
  };
}


// -- the lease ------------------------------------------------------------

/**
 * The two lease columns, as a union rather than a string.
 *
 * One lease for both passes would couple them for no benefit: a classification
 * pass holds its lease for the whole duration of its batch, a summarisation pass
 * would then be locked out behind it, and at a 60-second tick the two would
 * starve each other for the lease indefinitely. They write different fields —
 * `listId`/`tags`/`ai` against `summary` — and the advisory lock
 * `applyServerWrite` takes already serialises the writes that could actually
 * conflict, so there is nothing a shared lease would protect.
 */
export type RunLeaseColumn = "lease_until" | "summary_lease_until";

/**
 * Take the pass lease for this account, or report that someone else holds it.
 *
 * One statement, and it is an upsert rather than the bare UPDATE because a bare
 * UPDATE matches nothing on an account that has never run a pass — the row does
 * not exist yet — which would leave the lease free forever on exactly the
 * accounts most likely to be first. `ON CONFLICT ... DO UPDATE ... WHERE` is the
 * conditional write: the row comes back if the lease was free and not at all if
 * it was held, so "did a row come back" is the answer, with no second statement
 * and no read-then-write window between two replicas.
 *
 * The column is interpolated rather than parameterised, and cannot be: an
 * identifier is not a value. It is a union of two literals at every call site, so
 * there is nothing to sanitise, and the two callers below cannot disagree about
 * which lease they are taking.
 */
export async function acquireRunLease(pool: Pool, userId: string, column: RunLeaseColumn): Promise<boolean> {
  const result = await pool.query<{ user_id: string }>(
    `INSERT INTO nook_ai_state (user_id, ${column})
     VALUES ($1, now() + $2::interval)
     ON CONFLICT (user_id) DO UPDATE SET
       ${column} = EXCLUDED.${column},
       updated_at = now()
     WHERE nook_ai_state.${column} IS NULL OR nook_ai_state.${column} < now()
     RETURNING user_id`,
    [userId, `${leaseSeconds()} seconds`],
  );
  return result.rows.length > 0;
}

/**
 * Release it. Called from a `finally`, so a pass that failed still lets the next
 * tick work rather than waiting out the lease — and a crash still costs at most
 * `leaseSeconds()`, which is why that number is sized as carefully as it is.
 *
 * `updated_at` moves for a release, same as for an acquire: the row is written,
 * and a row whose `updated_at` never moves is a row nothing can reason about.
 */
export async function releaseRunLease(pool: Pool, userId: string, column: RunLeaseColumn): Promise<void> {
  await pool.query(`UPDATE nook_ai_state SET ${column} = NULL, updated_at = now() WHERE user_id = $1`, [userId]);
}

