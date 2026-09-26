/**
 * Background queue for AI classification — see docs/ai.md.
 *
 * lib/ai-classify.ts is pure: it turns a bookmark plus a taxonomy into a
 * request, and a response into a patch. This module owns everything impure —
 * the settings gate, the session gate, the batch/concurrency shape of the
 * calls, the writes, and the progress Settings → AI renders.
 *
 * Runs are serialized through a single-flight guard (runClassification), not
 * a createTaskQueue slot: the only two entry points are the 5-minute alarm and
 * a manual "Classify now", both inside this service worker, and joining is the
 * better semantics than queueing — a click that lands mid-tick gets that
 * tick's result instead of billing the same bookmark twice. Queueing on the
 * shared cloudQueue instead would also make a 25-bookmark batch head-of-line
 * block the 1-minute cloud sync, which the two subsystems should never do to
 * each other.
 */
import {
  applyClassification,
  normalizeTagName,
  selectCandidates,
  toClassifyRequest,
  type AiTaxonomyOption,
  type ClassifyRequest,
  type ClassifyResponse,
  type TagVocabularyEntry,
} from "./ai-classify";
import { loadAiSettings, type AiSettings } from "./ai-settings";
import { cloudApiUrl, cloudSession } from "./cloud-sync";
import * as NookDB from "./db";
import type { Bookmark, BookmarkList } from "./types";

// -- configuration --------------------------------------------------------

/** Accepted taxonomy: name + sample titles per option. Written by lib/ai-taxonomy.ts. */
export const AI_TAXONOMY_META_KEY = "ai.taxonomy";
/** Cumulative counters, last run, and the cooldown windows below. */
export const AI_CURSOR_META_KEY = "ai.cursor";
/** Fixed-size decision log; Settings → AI renders the confidence histogram from it. */
export const AI_LOG_META_KEY = "ai.log";

/**
 * Bookmarks classified per tick, and classify requests in flight at once.
 *
 * The route is one bookmark -> one decision, so a tick is N requests, not one.
 * The two knobs are chosen independently:
 *
 * - 25 per tick bounds a tick's wall clock, its spend, and what the panel can
 *   attribute to a single run. 5,000 bookmarks is ~$0.17 in total, so throughput
 *   is not the constraint — being able to say "this run filed 18, skipped 7" is.
 * - concurrency 4 turns 25 serial round trips into ~7. An MV3 service worker
 *   is torn down after ~30s idle, and one classify call carries ~800 input
 *   tokens against a 32k state, so a cold or slow link makes 25 serial calls
 *   long enough for the worker to die mid-batch: the writes already applied
 *   survive, the rest wait for the next tick. More than 4 buys little —
 *   per-call latency dominates, and the server's 1,200 requests/minute cap is
 *   nowhere near 4 concurrent.
 */
export const AI_BATCH_SIZE = 25;
export const AI_CONCURRENCY = 4;

/** Ring-buffer size for `ai.log`. Fixed, not a growing log — see pushLogEntry. */
export const AI_LOG_MAX_ENTRIES = 200;

/**
 * How many decided-on bookmark ids `ai.cursor` remembers.
 *
 * This is what keeps a "nothing fit" verdict from being re-bought forever: such
 * a pass writes nothing, so there is no field on the record to say we already
 * answered, and the only record of the answer is the id list here. A pass that
 * *did* file leaves `ai` behind and needs none of this. Past the cap the oldest
 * ids are dropped, and because candidates are taken newest-first those come
 * back only once everything newer is resolved — so the re-billing that leaks
 * through is the smallest, oldest tail, not the freshest saves.
 */
export const AI_PROCESSED_ID_LIMIT = 2000;

/** Existing tags offered as Noul options, highest frequency first. */
const AI_TAG_OPTION_LIMIT = 20;
/** Member titles carried per collection option. */
const AI_COLLECTION_SAMPLES = 5;
/** Member titles carried per tag option — there are up to 20 of these. */
const AI_TAG_SAMPLES = 3;

/** The `model` the server reports when its neutral placeholder is not a decision
 *  at all. Mirrors `UNAVAILABLE_MODEL` in apps/api/src/ai.ts; duplicated rather
 *  than shared because the api workspace has no dependency on the extension and
 *  this one string is not worth a cross-package coupling. */
const NEUTRAL_MODEL = "unavailable";

// A 401 means the session is gone and only a re-sign-in fixes it; a 503 means
// the server has no AI key configured, which takes a deploy. Both are states
// the panel explains rather than failures to retry — and without a cooldown
// the 5-minute alarm would re-probe every 5 minutes for the rest of the
// session.
const SIGNED_OUT_COOLDOWN_MS = 30 * 60_000;
const UNAVAILABLE_COOLDOWN_MS = 60 * 60_000;
// The server's limit is per minute, so a minute is the natural floor for a
// rate-limit backoff. Capped well below the whole-library cost of a long pause.
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_CAP_MS = 30 * 60_000;

// -- public types ---------------------------------------------------------

export interface AiRunStats {
  processed: number;
  assigned: number;
  tagged: number;
  skipped: number;
}

export interface AiRunResult extends AiRunStats {
  /** Set when the run stopped early or a request failed; also persisted as `ai.cursor.lastError`. */
  error?: string;
}

export interface AiCursor extends AiRunStats {
  /** ISO of the last run that got past the cooldowns (not "last alarm tick"). */
  lastRunAt?: string;
  lastError?: string;
  /**
   * Ids we have already bought a decision for, oldest first. Only consulted for
   * records that carry no `ai` attribution, i.e. the ones a pass answered with
   * "nothing fit" and therefore wrote nothing for.
   */
  processedIds?: string[];
  /** ISO until which the runner stays quiet after a 401. */
  signedOutUntil?: string;
  /** ISO until which the runner stays quiet after a 503. */
  unavailableUntil?: string;
  /** ISO until which the runner stays quiet after a 429/529 or an unreachable server. */
  backoffUntil?: string;
  /** Current backoff step, so the next one doubles instead of restarting. */
  backoffMs?: number;
}

export interface AiLogEntry {
  id: string;
  /** The `Choice` confidence for the collection decision; 0 when the body was unreadable. */
  confidence: number;
  assigned: boolean;
  at: string;
}

/** Minimal structural fetch, so a test can hand in a plain `vi.fn()` stub. */
export type AiFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface AiRunnerDeps {
  /** Defaults to the global fetch. */
  fetch?: AiFetch;
  /** Defaults to loadAiSettings(). */
  loadSettings?: () => Promise<AiSettings>;
  /** Epoch-ms clock; injected so cooldown/backoff windows are testable without waiting. */
  now?: () => number;
  /** Defaults to cloudSession(). */
  session?: () => Promise<{ token: string; ownerId: string } | null>;
  /** Defaults to cloudApiUrl(). */
  apiUrl?: string;
}

// -- small helpers -------------------------------------------------------

function emptyResult(): AiRunResult {
  return { processed: 0, assigned: 0, tagged: 0, skipped: 0 };
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function countOr(value: unknown): number {
  const number = finiteOr(value, 0);
  return number > 0 ? Math.floor(number) : 0;
}

function idListOr(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry !== "");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/** The same navigator predicate cloud-sync builds its `offline` status flag on. */
function isOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function sampleTitlesOf(bookmark: Bookmark): string {
  return typeof bookmark.title === "string" ? bookmark.title.trim() : "";
}

// -- meta state ----------------------------------------------------------

async function readCursor(): Promise<AiCursor> {
  const stored = await NookDB.getMeta<Partial<AiCursor>>(AI_CURSOR_META_KEY);
  return {
    processed: countOr(stored?.processed),
    assigned: countOr(stored?.assigned),
    tagged: countOr(stored?.tagged),
    skipped: countOr(stored?.skipped),
    lastRunAt: typeof stored?.lastRunAt === "string" ? stored.lastRunAt : undefined,
    lastError: typeof stored?.lastError === "string" ? stored.lastError : undefined,
    processedIds: idListOr(stored?.processedIds).slice(-AI_PROCESSED_ID_LIMIT),
    signedOutUntil: typeof stored?.signedOutUntil === "string" ? stored.signedOutUntil : undefined,
    unavailableUntil: typeof stored?.unavailableUntil === "string" ? stored.unavailableUntil : undefined,
    backoffUntil: typeof stored?.backoffUntil === "string" ? stored.backoffUntil : undefined,
    backoffMs: countOr(stored?.backoffMs),
  };
}

/** The latest still-active cooldown, or undefined when the runner may work. */
function activeCooldown(cursor: AiCursor, nowMs: number): string | undefined {
  const windows = [cursor.signedOutUntil, cursor.unavailableUntil, cursor.backoffUntil]
    .filter((value): value is string => typeof value === "string")
    .filter((value) => {
      const until = Date.parse(value);
      return !Number.isNaN(until) && until > nowMs;
    });
  if (windows.length === 0) return undefined;
  return windows.sort()[windows.length - 1];
}

async function readLog(): Promise<AiLogEntry[]> {
  const stored = await NookDB.getMeta<unknown>(AI_LOG_META_KEY);
  if (!Array.isArray(stored)) return [];
  const entries: AiLogEntry[] = [];
  for (const raw of stored.slice(-AI_LOG_MAX_ENTRIES)) {
    if (!raw || typeof raw !== "object") continue;
    const record = raw as { id?: unknown; confidence?: unknown; assigned?: unknown; at?: unknown };
    if (typeof record.id !== "string") continue;
    entries.push({
      id: record.id,
      confidence: finiteOr(record.confidence, 0),
      assigned: record.assigned === true,
      at: typeof record.at === "string" ? record.at : "",
    });
  }
  return entries;
}

/**
 * Appends one decision and drops the oldest overflow. This is a ring buffer,
 * not a log: the panel only ever reads the tail for its confidence histogram,
 * and an append-only array in a meta record is read and rewritten on every
 * tick, so it would grow without bound for the life of the profile.
 */
function pushLogEntry(log: AiLogEntry[], entry: AiLogEntry): void {
  log.push(entry);
  if (log.length > AI_LOG_MAX_ENTRIES) log.splice(0, log.length - AI_LOG_MAX_ENTRIES);
}

// -- taxonomy / options ---------------------------------------------------

/**
 * Reads `ai.taxonomy` defensively — this module only ever consumes it. The
 * taxonomy feature owns the shape, and an absent, empty or half-written value
 * must degrade to "no extra sample titles" rather than fail the tick.
 */
async function readTaxonomy(): Promise<{ options: AiTaxonomyOption[]; tags: TagVocabularyEntry[]; acceptedAt?: string }> {
  const stored = await NookDB.getMeta<unknown>(AI_TAXONOMY_META_KEY);
  const wrapped = (stored && typeof stored === "object" ? stored : {}) as {
    collections?: unknown;
    tags?: unknown;
    acceptedAt?: unknown;
    taxonomyAt?: unknown;
  };
  const raw: unknown[] = Array.isArray(stored)
    ? stored
    : Array.isArray(wrapped.collections)
      ? wrapped.collections
      : [];
  const options: AiTaxonomyOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; name?: unknown; samples?: unknown };
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const samples = Array.isArray(record.samples)
      ? record.samples
          .filter((sample): sample is string => typeof sample === "string" && sample.trim() !== "")
          .slice(0, AI_COLLECTION_SAMPLES)
      : [];
    const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : name.toLowerCase();
    options.push({ id, name, samples });
  }
  // Accepted tag names that nothing carries yet. Without these a proposed tag is
  // inert: the options below are built from tags the library already has, so a
  // tag with no members could never be offered. See AcceptedTaxonomy.tags.
  //
  // A bare string is the pre-definition shape and still reads, so a vocabulary
  // accepted before definitions existed keeps working — asked about by name.
  const tags: TagVocabularyEntry[] = [];
  const seenTags = new Set<string>();
  for (const raw of Array.isArray(wrapped.tags) ? wrapped.tags : []) {
    const record = (raw && typeof raw === "object" ? raw : {}) as { name?: unknown; definition?: unknown };
    const rawName = typeof raw === "string" ? raw : record.name;
    const name = normalizeTagName(typeof rawName === "string" ? rawName : "");
    if (name === "" || seenTags.has(name)) continue;
    seenTags.add(name);
    const definition = typeof record.definition === "string" ? record.definition.trim() : "";
    tags.push(definition ? { name, definition } : { name });
  }
  // When the accepted taxonomy was last taken on, for the attribution stamp.
  // Read from the record rather than stamped with "now", which would claim the
  // taxonomy had just been re-accepted on every single classification.
  const stamp = wrapped.acceptedAt ?? wrapped.taxonomyAt;
  const acceptedAt = typeof stamp === "string" && !Number.isNaN(Date.parse(stamp)) ? stamp : undefined;
  return { options, tags, acceptedAt };
}

/**
 * Collection options are the user's real BookmarkLists, each carrying its
 * actual member titles as `Choice` criteria — the doc's reason a single call
 * can serve the whole library. `ai.taxonomy` only *enriches* them: an entry
 * whose name matches no live list is ignored, because offering it would hand
 * back a `listId` that no BookmarkList backs and render as a broken collection
 * in the dashboard. The safe failure is not to offer it.
 */
function buildCollectionOptions(
  lists: BookmarkList[],
  bookmarks: Bookmark[],
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
      collect(byName, option.name.toLowerCase(), sample);
    }
  }
  for (const bookmark of bookmarks) {
    if (typeof bookmark.listId === "string") collect(byId, bookmark.listId, sampleTitlesOf(bookmark));
  }

  const collections: AiTaxonomyOption[] = [];
  const nameById = new Map<string, string>();
  for (const list of lists) {
    const name = typeof list.name === "string" ? list.name.trim() : "";
    if (!name) continue;
    const samples = dedupe([
      ...(byId.get(list.id) ?? []),
      ...(byName.get(name.toLowerCase()) ?? []),
    ]).slice(0, AI_COLLECTION_SAMPLES);
    collections.push({ id: list.id, name, samples });
    nameById.set(list.id, name);
  }
  return { collections, nameById };
}

/**
 * Tag options, highest frequency first, each with a few member titles as
 * criteria. Ties break on the name so the option set — and therefore the
 * `Choice` the model answers — is identical on every tick for the same
 * library; a reshuffled option set would make a recorded confidence
 * meaningless to compare against a later run.
 */
function buildTagOptions(bookmarks: Bookmark[], proposedTags: TagVocabularyEntry[] = []): AiTaxonomyOption[] {
  const counts = new Map<string, number>();
  const samples = new Map<string, string[]>();
  for (const bookmark of bookmarks) {
    const tags = Array.isArray(bookmark.tags) ? bookmark.tags : [];
    const title = sampleTitlesOf(bookmark);
    for (const raw of tags) {
      if (typeof raw !== "string") continue;
      const name = normalizeTagName(raw);
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
      const existing = samples.get(name);
      if (existing) {
        if (title && existing.length < AI_TAG_SAMPLES) existing.push(title);
      } else {
        samples.set(name, title ? [title] : []);
      }
    }
  }
  // Keyed on the sample map (which is populated exactly when the count map is)
  // so the entries are `[name, samples]`; frequency only decides the order.
  const live = [...samples.entries()]
    .sort(
      (left, right) =>
        (counts.get(right[0]) ?? 0) - (counts.get(left[0]) ?? 0) || left[0].localeCompare(right[0]),
    )
    .map(([name, list]) => ({ id: `tag:${name}`, name, samples: dedupe(list) }));

  // Accepted-but-unused names go last, with no samples — they are a name the
  // user agreed to and nothing has carried yet. They are the tail of the list
  // rather than the head because a tag with members behind it has evidence and
  // one without has only its own name, and the option cap is spent on evidence
  // first. Their questions are plain sentences with no digest either way; the
  // server builds those, and docs/ai-calibration.md is explicit that adding
  // evidence to a Noul makes it worse.
  const proposed = proposedTags
    .map((entry) => ({ name: normalizeTagName(entry?.name), definition: entry?.definition }))
    .filter((entry) => entry.name !== "" && !samples.has(entry.name));

  return [
    ...live,
    ...proposed.map((entry) => ({ id: `tag:${entry.name}`, name: entry.name, samples: [], ...(entry.definition ? { definition: entry.definition } : {}) })),
  ].slice(0, AI_TAG_OPTION_LIMIT);
}

// -- one classify request ------------------------------------------------

type ClassifyOutcome =
  | { kind: "decision"; stop: false; response: ClassifyResponse | null }
  | { kind: "signed-out"; stop: true }
  | { kind: "unavailable"; stop: true }
  | { kind: "throttled"; stop: true }
  | { kind: "unreachable"; stop: true }
  | { kind: "unhealthy"; stop: true }
  | { kind: "failed"; stop: false; message: string };

function readProbabilities(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

/**
 * Normalizes a response body, or returns null when it carries no decision at
 * all. An unreadable body is not an error to surface: the only safe reading of
 * an answer we cannot parse is that nothing was chosen, and the caller files
 * nothing. Throwing here would let one bad reply discard the rest of the
 * batch, which is most of the batch.
 */
function parseClassifyResponse(value: unknown): ClassifyResponse | null {
  if (!value || typeof value !== "object") return null;
  const body = value as Record<string, unknown>;
  const collection = body.collection;
  if (!collection || typeof collection !== "object") return null;
  const decision = collection as Record<string, unknown>;
  if (typeof decision.confidence !== "number" || !Number.isFinite(decision.confidence)) return null;

  const tags: Array<{ name: string; noul: number }> = [];
  if (Array.isArray(body.tags)) {
    for (const entry of body.tags) {
      if (!entry || typeof entry !== "object") continue;
      const tag = entry as Record<string, unknown>;
      if (typeof tag.name !== "string") continue;
      if (typeof tag.noul !== "number" || !Number.isFinite(tag.noul)) continue;
      tags.push({ name: tag.name, noul: tag.noul });
    }
  }

  const skipped = body.skipped === "none-fit" || body.skipped === "low-confidence" ? body.skipped : undefined;
  return {
    model: typeof body.model === "string" ? body.model : "",
    collection: {
      assign: decision.assign === true,
      id: typeof decision.id === "string" ? decision.id : null,
      name: typeof decision.name === "string" ? decision.name : null,
      confidence: decision.confidence,
      probabilities: readProbabilities(decision.probabilities),
    },
    tags,
    ...(skipped ? { skipped } : {}),
  };
}

async function classifyOne(
  request: ClassifyRequest,
  context: { apiUrl: string; token: string; doFetch: AiFetch },
): Promise<ClassifyOutcome> {
  let response: Response;
  try {
    response = await context.doFetch(`${context.apiUrl}/api/ai/classify`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${context.token}` },
      body: JSON.stringify(request),
    });
  } catch {
    // What cloud-sync calls a network error: the request never got an HTTP
    // reply. Stopping beats firing the rest of the batch at a connection that
    // is already down.
    return { kind: "unreachable", stop: true };
  }
  if (response.status === 401) return { kind: "signed-out", stop: true };
  if (response.status === 503) return { kind: "unavailable", stop: true };
  if (response.status === 429 || response.status === 529) return { kind: "throttled", stop: true };
  if (!response.ok) return { kind: "failed", stop: false, message: `Classify request failed (${response.status})` };
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Malformed JSON falls through to parseClassifyResponse(null), which files
    // nothing instead of throwing away the rest of the batch.
  }
  const parsed = parseClassifyResponse(body);
  // The server's neutral placeholder: a 200 that means "I could not reach the
  // model", not "the model had nothing to say". It is shaped exactly like a real
  // decision — confidence 0, no tags, nothing skipped — so without this it was
  // accepted, written to the log as a confidence-0 decision, and pushed into the
  // cursor, permanently retiring bookmarks the model never actually saw. A
  // 429 is propagated as a real 429 by the route, so this covers the remaining
  // causes: 5xx, timeout, an unparseable body from upstream.
  if (parsed?.model === NEUTRAL_MODEL) return { kind: "unhealthy", stop: true };
  return { kind: "decision", stop: false, response: parsed };
}

/**
 * Runs the batch as a pool of AI_CONCURRENCY workers rather than a serial
 * loop (see AI_BATCH_SIZE). A worker returning a terminal status stops the
 * pool, so one 401/503/429 ends the tick instead of spending the rest of the
 * batch on an answer the run already knows it cannot use. Requests already in
 * flight still resolve and are still applied — they were billed, and their
 * decisions are valid.
 */
async function runPool(
  candidates: Bookmark[],
  context: {
    apiUrl: string;
    token: string;
    doFetch: AiFetch;
    collections: AiTaxonomyOption[];
    tags: AiTaxonomyOption[];
    settings: AiSettings;
  },
): Promise<Array<ClassifyOutcome | undefined>> {
  const outcomes: Array<ClassifyOutcome | undefined> = new Array(candidates.length);
  let next = 0;
  let stopped = false;

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const position = next++;
      if (position >= candidates.length) return;
      const bookmark = candidates[position];
      const outcome = await classifyOne(
        toClassifyRequest(bookmark, context.collections, context.tags, context.settings),
        context,
      );
      outcomes[position] = outcome;
      if (outcome.stop) stopped = true;
    }
  };

  await Promise.all(Array.from({ length: Math.min(AI_CONCURRENCY, candidates.length) }, () => worker()));
  return outcomes;
}

// -- applying a decision -------------------------------------------------

/**
 * True when a patch would change nothing that is already on the record. Every
 * write stamps `updatedAt` and fires notifyChange(), so re-stating the current
 * listId or tags would push a no-op record through cloud sync and resurface
 * the bookmark as freshly updated in the dashboard.
 */
function patchChangesSomething(bookmark: Bookmark, patch: Partial<Bookmark>): boolean {
  return Object.keys(patch).some((key) => {
    const next = patch[key];
    const current = bookmark[key];
    if (Array.isArray(next) && Array.isArray(current)) {
      return next.length !== current.length || next.some((value, index) => !Object.is(value, current[index]));
    }
    return !Object.is(next, current);
  });
}

/** A tag was added (as opposed to the patch merely restating the same set). */
function addsTags(bookmark: Bookmark, patch: Partial<Bookmark>): boolean {
  if (!Array.isArray(patch.tags) || patch.tags.length === 0) return false;
  const current = Array.isArray(bookmark.tags) ? bookmark.tags : [];
  return patch.tags.length !== current.length || patch.tags.some((value, index) => !Object.is(value, current[index]));
}

/**
 * Adds the accepted-taxonomy date to the attribution. applyClassification
 * leaves it out on purpose (it dates the taxonomy in force, not the decision,
 * and the model never returns it), so this is the runner's half of that
 * handoff. Omitted entirely when no accepted taxonomy is on record, rather
 * than guessed at.
 */
function withTaxonomyAt(patch: Partial<Bookmark>, acceptedAt: string | undefined): Partial<Bookmark> {
  const attribution = patch.ai;
  if (!acceptedAt || !attribution) return patch;
  return { ...patch, ai: { ...attribution, taxonomyAt: acceptedAt } };
}

// -- the run -------------------------------------------------------------

async function execute(deps: AiRunnerDeps): Promise<AiRunResult> {
  const now = deps.now ?? (() => Date.now());
  const readSession = deps.session ?? cloudSession;
  const apiUrl = (deps.apiUrl ?? cloudApiUrl()).replace(/\/$/, "");
  const doFetch: AiFetch = deps.fetch ?? ((input, init) => fetch(input, init));

  // 1. Both routes are session-guarded and the extension speaks to them with
  //    the cloud bearer token, so a library with no session can never classify
  //    anything — and settings are the signed-in account's now (docs/ai.md,
  //    "Settings surface"), not this browser's, so there is nothing to even
  //    ask for. cloudSession() is the same helper syncCloud() gates on.
  const session = await readSession();
  if (!session) return emptyResult();

  // 2. Offline is a normal state — the same kind of thing the 401/503 paths
  //    are — so it leaves `lastError` alone and shows up through the cloud
  //    status the panel already renders. Checked before the settings fetch
  //    below so a known-offline tick fails fast instead of waiting out one.
  if (isOffline()) return emptyResult();

  // 3. The toggle is (almost) the whole gate. `loadAiSettings` reuses this
  //    tick's own token/fetch rather than the module-level default (which
  //    caches briefly for callers like `aiIsArmable()` that ask on every saved
  //    bookmark) — a run that gets this far should always act on the freshest
  //    settings, not a minute-old cached answer.
  const loadSettings = deps.loadSettings ??
    (() => loadAiSettings({ apiUrl, fetch: doFetch, requestAuth: async () => ({ mode: "bearer", token: session.token }) }));
  const settings = await loadSettings();
  if (!settings.autoClassify) return emptyResult();

  const nowMs = now();
  const cursor = await readCursor();
  if (activeCooldown(cursor, nowMs)) return emptyResult();

  const [bookmarks, lists, taxonomy] = await Promise.all([
    NookDB.getAllBookmarks(),
    NookDB.getAllLists(),
    readTaxonomy(),
  ]);
  // Already-decided records are filtered out *before* the batch is chosen, not
  // after: a record we already ruled on must not push a never-seen one out of
  // the 25. `ai`-attributed records drop out inside selectCandidates; this is
  // the other half — the ones a pass answered "nothing fit" for and wrote
  // nothing for, which nothing on the record itself can keep us from re-billing.
  const alreadyProcessed = new Set(cursor.processedIds ?? []);
  const fresh = alreadyProcessed.size > 0
    ? bookmarks.filter((item) => !alreadyProcessed.has(item.id))
    : bookmarks;
  const candidates = selectCandidates(fresh, AI_BATCH_SIZE);
  const { collections, nameById } = buildCollectionOptions(lists, bookmarks, taxonomy.options);
  const tagOptions = buildTagOptions(bookmarks, taxonomy.tags);

  const outcomes: Array<ClassifyOutcome | undefined> =
    candidates.length > 0
      ? await runPool(candidates, { apiUrl, token: session.token, doFetch, collections, tags: tagOptions, settings })
      : [];

  // -- apply the decisions, in candidate order for a deterministic run ----

  // Only read the log when there is a decision to append to it: a tick with
  // nothing to file is the common case and shouldn't rewrite a meta record.
  const log = outcomes.some((outcome) => outcome?.kind === "decision") ? await readLog() : [];
  const stats = { processed: 0, assigned: 0, tagged: 0, skipped: 0 };
  const decidedIds: string[] = [];

  for (let position = 0; position < candidates.length; position++) {
    const bookmark = candidates[position];
    const outcome = outcomes[position];
    // A missing outcome means the pool stopped before dispatching this one.
    // Either way it counts as skipped, so the panel's filed-vs-skipped always
    // adds up to the batch it was told about.
    if (!outcome || outcome.kind !== "decision") {
      stats.skipped++;
      continue;
    }
    stats.processed++;
    // A decision was bought, so the id joins the cursor even if it files
    // nothing — including a malformed body, which is still an answer we spent a
    // request on and must not buy twice. A request that never got a decision
    // (401/503/429/unreachable/500) is deliberately *not* recorded: the
    // bookmark still deserves its one classification.
    decidedIds.push(bookmark.id);

    // An unreadable body files nothing. applyClassification is the only path
    // to a patch, and guessing at a mis-parsed decision would file a
    // collection nobody chose — so this is a skip, not an error.
    //
    // maxTags is passed explicitly because the response carries no settings: the
    // server already applied the tag threshold, but the *cap* is ours, and
    // leaving it off would silently trim a user who set maxTags: 8 down to 3.
    const response = outcome.response;
    const applied = response
      ? applyClassification(bookmark, response, nameById, settings.maxTags)
      : null;
    const patch = applied ? withTaxonomyAt(applied, taxonomy.acceptedAt) : null;
    let assigned = false;
    let tagged = false;
    if (patch && patchChangesSomething(bookmark, patch)) {
      const written = await NookDB.updateBookmark(bookmark.id, patch);
      if (written) {
        assigned = patch.listId != null && !Object.is(patch.listId, bookmark.listId);
        tagged = addsTags(bookmark, patch);
      }
    }
    if (assigned) stats.assigned++;
    if (tagged) stats.tagged++;
    if (!assigned && !tagged) stats.skipped++;

    pushLogEntry(log, {
      id: bookmark.id,
      confidence: response ? response.collection.confidence : 0,
      assigned,
      at: new Date(nowMs).toISOString(),
    });
  }

  if (log.length > 0) await NookDB.setMeta(AI_LOG_META_KEY, log);

  // -- record the outcome ------------------------------------------------

  let lastError: string | undefined;
  let signedOut = false;
  let unavailable = false;
  let throttled = false;
  for (const outcome of outcomes) {
    if (!outcome) continue;
    // The pool stops on the first terminal status, so at most a handful of
    // in-flight outcomes coexist with it; whichever lands first owns the
    // reason, with the non-terminal failures behind it.
    if (outcome.kind === "signed-out") {
      signedOut = true;
      lastError = "Signed out — sign in again to resume classifying.";
      break;
    }
    if (outcome.kind === "unavailable") {
      // Deliberately no `lastError` here. A missing TYPESAFE_API_KEY on the
      // server is a deployment state, not something the user did or can fix,
      // and `unavailableUntil` already carries it. Setting both made the
      // settings panel pick "error" (a red dot, "needs attention") over its own
      // "unavailable" state, because that status checks `lastError` first — so
      // a quiet misconfiguration looked like a fault on this device.
      unavailable = true;
      break;
    }
    if (outcome.kind === "throttled") {
      throttled = true;
      lastError = "Rate limited by the server — backing off.";
      break;
    }
    if (outcome.kind === "unreachable") {
      throttled = true;
      lastError = "Could not reach the classification endpoint.";
      break;
    }
    // The server answered, but the model behind it did not. Same operational
    // response as unreachable — stop, back off, leave the bookmarks eligible —
    // but a different sentence, because "check your connection" is the wrong
    // advice here.
    if (outcome.kind === "unhealthy") {
      throttled = true;
      lastError = "Nook's server could not reach the classification model — backing off.";
      break;
    }
    if (outcome.kind === "failed" && !lastError) lastError = outcome.message;
  }

  const next: AiCursor = {
    processed: cursor.processed + stats.processed,
    assigned: cursor.assigned + stats.assigned,
    tagged: cursor.tagged + stats.tagged,
    skipped: cursor.skipped + stats.skipped,
    lastRunAt: new Date(nowMs).toISOString(),
    processedIds: [...(cursor.processedIds ?? []), ...decidedIds].slice(-AI_PROCESSED_ID_LIMIT),
  };
  if (lastError) next.lastError = lastError;
  if (signedOut) next.signedOutUntil = new Date(nowMs + SIGNED_OUT_COOLDOWN_MS).toISOString();
  if (unavailable) next.unavailableUntil = new Date(nowMs + UNAVAILABLE_COOLDOWN_MS).toISOString();
  if (throttled) {
    const previous = countOr(cursor.backoffMs);
    const step = previous === 0 ? BACKOFF_BASE_MS : Math.min(previous * 2, BACKOFF_CAP_MS);
    next.backoffMs = step;
    next.backoffUntil = new Date(nowMs + step).toISOString();
  } else {
    // A run that reached the server clears a stale cooldown, so a window left
    // behind by an earlier 401/503 can't park the feature after the cause is
    // gone.
    next.backoffMs = 0;
  }
  await NookDB.setMeta(AI_CURSOR_META_KEY, next);

  return { ...stats, ...(lastError ? { error: lastError } : {}) };
}

// -- single-flight entry point -------------------------------------------

let inFlight: Promise<AiRunResult> | null = null;

/**
 * Runs one classification pass. A call that arrives while a run is in flight
 * joins that run instead of starting a second one, so the alarm and a manual
 * "Classify now" can never classify — and bill — the same bookmark twice.
 * Never rejects: a caller on a timer or in a message handler should not have
 * to guard it.
 */
export function runClassification(deps: AiRunnerDeps = {}): Promise<AiRunResult> {
  if (inFlight) return inFlight;
  const run = execute(deps)
    .catch((error) => ({ ...emptyResult(), error: error instanceof Error ? error.message : String(error) }))
    .finally(() => {
      inFlight = null;
    });
  inFlight = run;
  return run;
}

export function isAiRunInFlight(): boolean {
  return inFlight !== null;
}
