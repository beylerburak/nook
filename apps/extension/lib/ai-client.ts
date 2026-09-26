/**
 * The extension's whole remaining relationship with AI classification.
 *
 * A pass used to run in this browser: a service-worker alarm owned the queue,
 * the cooldowns and the batch loop. It runs on Nook's server now, and this
 * module is the entire seam — the four routes in docs/ai-cloud-contract.md, with
 * the summarisation half of two of them from docs/ai-summarize-contract.md
 * layered on top, and nothing else:
 *
 *   GET  /api/ai/status            loadAiStatus
 *   POST /api/ai/run               requestClassificationRun
 *   POST /api/ai/taxonomy/propose  requestTaxonomyProposals
 *   PUT  /api/ai/taxonomy          acceptTaxonomy
 *
 * The shape follows lib/ai-settings.ts deliberately, because this is its
 * sibling: a module-level `fetch` default, injectable `fetch`/`apiUrl`/
 * `session` so a test never has to touch a real network, and a `_reset…ForTests`
 * hook for the module-level state. The auth is `cloudRequestAuth()` rather than
 * `cloudSession()`, which is the one substantive difference and the reason the
 * web host can reach any of this at all: `cloudSession()` answers with a bearer
 * token, and the web app authenticates with a cookie it sends itself.
 *
 * -- the failure convention, in one place --
 *
 * **No call here rejects.** Every failure is a value, because every caller is
 * a settings panel rendering a row, and a rejection would either need a
 * try/catch per call or take the dialog down. The mapping is the one the other
 * AI routes already established: 401 is signed-out, 503 is unavailable, 429/529
 * is throttled, any other non-2xx is failed with the
 * status in the message, and a thrown `fetch` is failed. A call whose return
 * type cannot express the reason collapses all of them to its `null` case
 * (`loadAiStatus`, `requestClassificationRun` — there is nothing to show and
 * nothing was queued); the two whose return type is a discriminated union name
 * the reason, because the panel has a different sentence for each.
 *
 * Summarisation adds no failure mode to that list, and deliberately so: it rides
 * inside the same two routes rather than a third one, so `summarize` is either
 * in a status that answered or absent with it, and `summariesQueued` is either
 * in a run that answered or absent. The panel's vocabulary of states stays the
 * four it already had — a pass that cannot run is a missing deploy either way.
 *
 * Signed out is checked before the request is built, so a signed-out caller
 * never reaches the network.
 *
 * -- no cache, deliberately --
 *
 * lib/ai-settings.ts keeps a 60-second cache because the extension asked it on
 * every single saved bookmark. Nothing here is on a hot path: a status read is
 * what the panel watches while a queue drains, so caching it would defeat the
 * only reason to read it repeatedly.
 *
 * Every response is parsed defensively. A field a future or hand-edited server
 * build left out, or wrote as the wrong type, is filled with a safe value
 * rather than trusted — a malformed status must not be able to crash the
 * settings dialog, and the counters it feeds are the ones a user reads as fact.
 *
 * `summarize` is optional on the wire, so filling it is not only about a
 * hand-edited body: a server build that predates the summarisation pass omits
 * the whole object, and the reading of one that did is a status with no
 * summariser, nothing summarised and no pass ever run. That is not a guess
 * dressed as a reading — a build without the pass genuinely has no summariser —
 * so the panel renders it as the same missing deploy it renders a missing
 * classification key as, rather than crashing or claiming zero summaries.
 */

import { normalizeAiSettings, type AiSettings, type TaxonomyLanguage } from "./ai-settings";
import { cloudApiUrl, cloudRequestAuth, type RequestAuth } from "./cloud-sync";

// -- wire shapes ---------------------------------------------------------
//
// Exactly as docs/ai-cloud-contract.md specifies them. These are duplicates of
// apps/api's own types, kept in step by hand like every other duplicated wire
// type in this repo: the api workspace has no dependency on the extension and
// these seams are not worth a cross-package coupling.

/** One decision from the account's log — the raw material for a confidence
 *  histogram, which is what `AiRunSummary.log` exists to feed. */
export interface AiLogEntry {
  id: string;
  /** The `Choice` confidence for the collection decision; 0 when the body was unreadable. */
  confidence: number;
  assigned: boolean;
  at: string;
}

/** What the server's own pass history says, as one read. */
export interface AiRunSummary {
  processed: number;
  assigned: number;
  tagged: number;
  skipped: number;
  /** ISO of the last pass that got past the cooldowns, or null. */
  lastRunAt: string | null;
  lastError: string | null;
  /** True while the no-AI-key cooldown is still in effect. */
  isUnavailable: boolean;
  /** True while a rate-limit / network backoff is still in effect. */
  isBackingOff: boolean;
  /** Last 200 decisions, newest last. */
  log: AiLogEntry[];
}

/** The taxonomy in force. Was the extension's per-origin `ai.taxonomy` meta key,
 *  which is why a taxonomy accepted on the web could never reach the runner. */
export interface AcceptedTaxonomy {
  /** ISO of the last acceptance, or null when there has never been one. */
  acceptedAt: string | null;
  collections: Array<{ id: string; name: string; samples: string[] }>;
  /** Accepted tag names nothing carries yet, each with its definition. */
  tags: Array<{ name: string; definition?: string }>;
}

/** What the server's own summarisation pass has to say, as one read. Separate
 *  from `AiRunSummary` because these are two independent deployments, not one
 *  run in two halves: classification needs `TYPESAFE_API_KEY`, summarising needs
 *  the proposer `NOOK_AI_PROPOSER` names, and either can be configured without
 *  the other. */
export interface SummarizeStatus {
  /** Whether a summariser is configured: NOOK_AI_PROPOSER plus its key. */
  available: boolean;
  /** The model a call would use, defaults included. */
  model: string;
  /** Candidates waiting to be summarised. */
  pending: number;
  /** Live records carrying a non-empty summary. */
  summarised: number;
  written: number;
  skipped: number;
  lastRunAt: string | null;
  lastError: string | null;
  isUnavailable: boolean;
  isBackingOff: boolean;
}

/** `GET /api/ai/status` — the whole status surface in one read, so the panel
 *  never renders a half-updated state stitched from three endpoints. */
export interface AiStatus {
  /** Whether this server can classify at all: TYPESAFE_API_KEY is present. */
  available: boolean;
  settings: AiSettings;
  /** Jobs waiting to be classified. */
  pending: number;
  taxonomy: AcceptedTaxonomy;
  run: AiRunSummary;
  /**
   * Filled whether or not the server sent it (see `readSummarizeStatus`), so
   * this is not `summarize?: SummarizeStatus` on the type: a panel that had to
   * null-check the whole object in every row would be null-checking a field this
   * module guarantees.
   */
  summarize: SummarizeStatus;
}

/** One collection the proposer invented, with the one-line reason it gave. */
export interface TaxonomyProposal {
  name: string;
  why: string;
}

/** A proposed tag. `why` becomes the tag's definition once accepted.
 *
 *  `coveredBy` is the collections *in this response* whose vocabulary already
 *  speaks for the tag. The client uses it to untick the tag by default and to
 *  re-tick it when a covering collection is unticked, which keeps the review
 *  list live without the client owning the Turkish-aware stem comparison that
 *  deciding it requires. */
export interface TagProposal {
  name: string;
  why?: string;
  coveredBy: string[];
}

/** What a proposal request can answer. The failures are states to report, not
 *  to retry: a stale session needs a sign-in, a missing key needs a deploy, and
 *  a throttled server needs a minute. */
export type ProposeOutcome =
  /** The server answered. `proposals` may be empty — declining is a valid answer. */
  | { kind: "proposals"; sampleSize: number; proposals: TaxonomyProposal[]; tags: TagProposal[]; existingCollections: string[] }
  /** Nothing eligible to read, so there was no sample to draw one from. */
  | { kind: "nothing-to-read" }
  /** 401, or no session before a request was even made. */
  | { kind: "signed-out" }
  /** 503: the server has no AI key configured. A deploy, not a retry. */
  | { kind: "unavailable" }
  | { kind: "throttled" }
  | { kind: "failed"; message: string };

/** `PUT /api/ai/taxonomy` succeeded: names became real `BookmarkList` records
 *  plus the accepted taxonomy, in one transaction on the server. */
export interface AcceptedResult {
  kind: "accepted";
  createdCollections: number;
  /** Tag names added to the vocabulary, i.e. that no bookmark carried before. */
  addedTags: number;
  /** Names dropped because a collection already had them. */
  dropped: number;
  /** The taxonomy now in force. */
  taxonomy: AcceptedTaxonomy;
}

export type AcceptResult = AcceptedResult | { kind: "signed-out" } | { kind: "unavailable" } | { kind: "throttled" } | { kind: "failed"; message: string };

/**
 * One tag the user kept, sent back with the proposer's own line for what it means.
 *
 * The definition has to travel with the name because the server cannot reconstruct
 * it, and because it is the only evidence a member-less tag will ever have: a new
 * tag is offered to the model as `Does this saved item belong under the tag
 * "yazılım geliştirme"?`, and a bare name is the thinnest possible input to that
 * question. Measured over 80 real bookmarks, definitions put 12 of 12 vocabulary
 * entries to use against 10 of 12 for bare names, at 24% more input tokens
 * (`docs/ai.md`). Optional, so a proposer that returned no `why` still yields a
 * usable tag.
 */
export interface AcceptedTagInput {
  name: string;
  definition?: string;
}

/** Minimal structural fetch, so a test can hand in a plain stub. Mirrors
 *  `AiSettingsFetch` in lib/ai-settings.ts. */
export type AiFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface AiClientDeps {
  /** Defaults to the global fetch. */
  fetch?: AiFetch;
  /** Defaults to cloudApiUrl(). */
  apiUrl?: string;
  /**
   * Defaults to cloudRequestAuth() — bearer in the extension, cookie on the
   * web. `null` means signed out, so nothing is sent.
   */
  session?: () => Promise<RequestAuth | null>;
}

// -- reading a value, never trusting one ---------------------------------

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Interior whitespace collapsed, matching `collapseName` in apps/api/src/ai.ts:
 *  a proposal rendered over two lines in the review list is still one name. */
function cleanName(value: unknown): string {
  return trimmed(value).replace(/\s+/g, " ");
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** A count is never negative and never fractional, whatever a hand-edited body
 *  or an older build put there. */
function countOr(value: unknown): number {
  const parsed = finiteOr(value, 0);
  return parsed > 0 ? Math.floor(parsed) : 0;
}

function stringListOr(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

/** A status from a future build is missing nothing this panel must survive: a
 *  counter it cannot read is 0, a date it cannot read is "never", and a flag
 *  it cannot read is false. */
function readRunSummary(value: unknown): AiRunSummary {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const log: AiLogEntry[] = [];
  for (const entry of Array.isArray(body.log) ? body.log : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = trimmed(record.id);
    if (id === "") continue;
    log.push({
      id,
      confidence: finiteOr(record.confidence, 0),
      assigned: record.assigned === true,
      at: typeof record.at === "string" ? record.at : "",
    });
  }
  return {
    processed: countOr(body.processed),
    assigned: countOr(body.assigned),
    tagged: countOr(body.tagged),
    skipped: countOr(body.skipped),
    lastRunAt: typeof body.lastRunAt === "string" ? body.lastRunAt : null,
    lastError: typeof body.lastError === "string" ? body.lastError : null,
    isUnavailable: body.isUnavailable === true,
    isBackingOff: body.isBackingOff === true,
    log,
  };
}

/**
 * The same fill-don't-trust reading as `readRunSummary`, for the same reason,
 * and with one field that is optional in a way `run` is not: a server build
 * that predates the summarisation pass leaves this whole object out. Read that
 * way it is a status with no summariser configured, nothing summarised, nothing
 * queued and no pass ever run — which is what such a build is, so the panel can
 * report it as the missing deploy it is instead of crashing or claiming a
 * library of zeros.
 */
function readSummarizeStatus(value: unknown): SummarizeStatus {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    available: body.available === true,
    model: trimmed(body.model),
    pending: countOr(body.pending),
    summarised: countOr(body.summarised),
    written: countOr(body.written),
    skipped: countOr(body.skipped),
    lastRunAt: typeof body.lastRunAt === "string" ? body.lastRunAt : null,
    lastError: typeof body.lastError === "string" ? body.lastError : null,
    isUnavailable: body.isUnavailable === true,
    isBackingOff: body.isBackingOff === true,
  };
}

function readAcceptedTaxonomy(value: unknown): AcceptedTaxonomy {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const collections: AcceptedTaxonomy["collections"] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(body.collections) ? body.collections : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = cleanName(record.name);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    collections.push({ id: trimmed(record.id) || name, name, samples: stringListOr(record.samples) });
  }
  const tags: AcceptedTaxonomy["tags"] = [];
  const seenTags = new Set<string>();
  for (const entry of Array.isArray(body.tags) ? body.tags : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = cleanName(record.name);
    if (name === "" || seenTags.has(name)) continue;
    seenTags.add(name);
    const definition = cleanName(record.definition);
    tags.push(definition ? { name, definition } : { name });
  }
  return {
    acceptedAt: typeof body.acceptedAt === "string" ? body.acceptedAt : null,
    collections,
    tags,
  };
}

/**
 * A body that is not an object at all is still a status: the safe reading of
 * an answer whose shape we do not recognise is "nothing is queued and nothing
 * has run", which renders rather than throws. `settings` goes through the same
 * normalizer the settings route's own client uses, so a garbled row cannot put
 * an out-of-range threshold on screen, and `summarize` goes through the same
 * fill as `run` for the same reason.
 */
function readStatus(value: unknown): AiStatus {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    available: body.available === true,
    settings: normalizeAiSettings(body.settings),
    pending: countOr(body.pending),
    taxonomy: readAcceptedTaxonomy(body.taxonomy),
    run: readRunSummary(body.run),
    summarize: readSummarizeStatus(body.summarize),
  };
}

/**
 * A collection proposal without a `why` is dropped rather than rendered as a
 * bare name: the review list has nowhere to show a name with no reason, and a
 * name with no reason is the one thing a user should never be asked to accept.
 * The server parses and caps what the model returned; none of that is repeated
 * here, and none of it is trusted either.
 */
function readProposals(value: unknown): TaxonomyProposal[] {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const proposals: TaxonomyProposal[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(body.collections) ? body.collections : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = cleanName(record.name);
    const why = cleanName(record.why);
    if (name === "" || why === "" || seen.has(name)) continue;
    seen.add(name);
    proposals.push({ name, why });
  }
  return proposals;
}

/**
 * The proposed tag vocabulary, each with the proposer's own one-liner. `why` is
 * optional here rather than required: it is shown in the review list and
 * becomes the tag's definition, but a tag with no definition is still a usable
 * tag — asked about by bare name, which is what every tag was before
 * definitions existed.
 *
 * `coveredBy` defaults to empty, which is the important default: it is what
 * makes a tag start *ticked*. A build that predates the field therefore offers
 * every tag for acceptance instead of silently unticking all of them.
 */
function readTagProposals(value: unknown): TagProposal[] {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const tags: TagProposal[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(body.tags) ? body.tags : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const name = cleanName(record.name);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    const why = cleanName(record.why);
    tags.push({ name, ...(why ? { why } : {}), coveredBy: stringListOr(record.coveredBy) });
  }
  return tags;
}

// -- one round trip ------------------------------------------------------

/** The shared shape of every non-2xx answer, before each call decides what its
 *  own return type does with it. */
type RequestFailure = { kind: "signed-out" } | { kind: "unavailable" } | { kind: "throttled" } | { kind: "failed"; message: string };

interface RouteMessages {
  /** The request never got an HTTP reply — the only failure a retry can change. */
  unreachable: string;
  /** The server answered with a status this route does not define. */
  unexpected: (status: number) => string;
}

type RouteResult = { ok: true; body: unknown } | { ok: false; failure: RequestFailure };

/**
 * The session, the auth headers and the status mapping, once.
 *
 * `null` auth is the signed-out case and is answered before the request is
 * built, so a signed-out caller never reaches the network. The status mapping
 * is the shared one described in this file's header, and is deliberately not
 * re-invented per route: 401 signed out, 503 the server has no key, 429/529
 * throttled, anything else failed with the status in the message.
 */
async function callRoute(deps: AiClientDeps, path: string, init: RequestInit, messages: RouteMessages): Promise<RouteResult> {
  let auth: RequestAuth | null;
  try {
    auth = await (deps.session ?? cloudRequestAuth)();
  } catch {
    return { ok: false, failure: { kind: "failed", message: messages.unreachable } };
  }
  if (!auth) return { ok: false, failure: { kind: "signed-out" } };

  const apiUrl = (deps.apiUrl ?? cloudApiUrl()).replace(/\/$/, "");
  const doFetch: AiFetch = deps.fetch ?? ((input, requestInit) => fetch(input, requestInit));
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) };
  const requestInit: RequestInit = { ...init, headers };
  if (auth.mode === "bearer") headers.Authorization = `Bearer ${auth.token}`;
  else requestInit.credentials = "include";

  let response: Response;
  try {
    response = await doFetch(`${apiUrl}${path}`, requestInit);
  } catch {
    return { ok: false, failure: { kind: "failed", message: messages.unreachable } };
  }
  if (response.status === 401) return { ok: false, failure: { kind: "signed-out" } };
  if (response.status === 503) return { ok: false, failure: { kind: "unavailable" } };
  if (response.status === 429 || response.status === 529) return { ok: false, failure: { kind: "throttled" } };
  if (!response.ok) return { ok: false, failure: { kind: "failed", message: messages.unexpected(response.status) } };

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An unreadable body is the caller's problem to survive, not a failure:
    // `readStatus` and the proposal readers both fill a non-object with safe
    // values, and throwing here would turn "the server said something we could
    // not parse" into "the request failed" for no gain.
  }
  return { ok: true, body };
}

// -- GET /api/ai/status --------------------------------------------------

/**
 * One read for the whole status surface, or `null` when there is no status to
 * show: signed out, or the read did not complete. Never rejects — see the
 * convention in this file's header.
 */
export async function loadAiStatus(deps: AiClientDeps = {}): Promise<AiStatus | null> {
  const result = await callRoute(
    deps,
    "/api/ai/status",
    { method: "GET" },
    {
      unreachable: "Could not reach Nook's server to read AI status.",
      unexpected: (status) => `The AI status request failed (${status}).`,
    },
  );
  return result.ok ? readStatus(result.body) : null;
}

// -- POST /api/ai/run ----------------------------------------------------

/**
 * Asks the server to enqueue this account's eligible work, and reports how many
 * that call added to each queue.
 *
 * `POST /api/ai/run` covers both passes now, each gated on its own toggle, so
 * `summariesQueued` can be non-zero while `queued` is zero: a user with only
 * `autoSummarize` on gets summaries queued and nothing else. `summariesQueued`
 * is filled with 0 when a build predates the field rather than left undefined,
 * because the panel puts this number in a sentence and `undefined` in a toast is
 * a hole in the middle of one.
 *
 * The name is the classification pass's, from when this queued only that; what
 * the route starts is both.
 *
 * `null` means nothing was queued — signed out, or the request did not
 * complete. There is deliberately no pass result to return: the route wakes a
 * worker rather than running a batch inline (25 classify calls take tens of
 * seconds, which is not something to hold an HTTP request open for), so a
 * caller cannot learn what was filed or written from this call and must not
 * claim to. Re-read `loadAiStatus` to watch the queues drain.
 */
export async function requestClassificationRun(deps: AiClientDeps = {}): Promise<{ queued: number; summariesQueued: number } | null> {
  const result = await callRoute(
    deps,
    "/api/ai/run",
    { method: "POST", body: JSON.stringify({}) },
    {
      unreachable: "Could not reach Nook's server to start an AI pass.",
      unexpected: (status) => `The pass request failed (${status}).`,
    },
  );
  if (!result.ok) return null;
  const body = (result.body && typeof result.body === "object" ? result.body : {}) as Record<string, unknown>;
  return { queued: countOr(body.queued), summariesQueued: countOr(body.summariesQueued) };
}

// -- POST /api/ai/taxonomy/propose ---------------------------------------

export interface ProposeDeps extends AiClientDeps {
  /** What language to name things in. Omitted when `auto`, so the server's own
   *  default decides — sending `"auto"` would be the same request with a word
   *  in it. */
  language?: TaxonomyLanguage;
}

/**
 * Asks the server what to call the themes in this library.
 *
 * The server samples *its own* records, so this sends no sample at all: the
 * client has nothing to contribute and therefore nothing to get wrong about
 * which bookmarks were read. A 200 with empty arrays is a legitimate decline,
 * and is reported as one.
 *
 * "There was nothing to read" is the server's call, not this panel's — it owns
 * the library — and it says so by having drawn a sample of nothing. It is
 * reported apart from a decline, which is the same empty answer with a real
 * sample behind it, because "save a few bookmarks" and "nothing new worth
 * suggesting" are different things to tell someone. An answer that does name
 * something is never swallowed by this, whatever `sampleSize` says.
 */
export async function requestTaxonomyProposals(deps: ProposeDeps = {}): Promise<ProposeOutcome> {
  const result = await callRoute(
    deps,
    "/api/ai/taxonomy/propose",
    { method: "POST", body: JSON.stringify(deps.language && deps.language !== "auto" ? { language: deps.language } : {}) },
    {
      unreachable: "Could not reach the taxonomy proposal endpoint.",
      unexpected: (status) => `The proposal request failed (${status}).`,
    },
  );
  if (!result.ok) return result.failure;
  const body = (result.body && typeof result.body === "object" ? result.body : {}) as Record<string, unknown>;
  const sampleSize = countOr(body.sampleSize);
  const proposals = readProposals(body);
  const tags = readTagProposals(body);
  if (proposals.length === 0 && tags.length === 0 && sampleSize === 0) return { kind: "nothing-to-read" };
  return { kind: "proposals", sampleSize, proposals, tags, existingCollections: stringListOr(body.existingCollections) };
}

// -- PUT /api/ai/taxonomy ------------------------------------------------

/**
 * Turns the names the user kept into real collections plus the accepted
 * taxonomy, in one transaction on the server.
 *
 * The request carries names only. The sample, the account's existing lists and
 * the library's own tags are all read from `nook_records` at acceptance time,
 * which is strictly more correct than the client re-sending a snapshot it may
 * have read before a concurrent change — and it is what makes a half-finished
 * acceptance impossible, since both writes happen in the same transaction.
 */
export async function acceptTaxonomy(
  input: { collections: string[]; tags: AcceptedTagInput[] },
  deps: AiClientDeps = {},
): Promise<AcceptResult> {
  const result = await callRoute(
    deps,
    "/api/ai/taxonomy",
    { method: "PUT", body: JSON.stringify(input) },
    {
      unreachable: "Could not reach Nook's server to accept the taxonomy.",
      unexpected: (status) => `The taxonomy could not be saved (${status}).`,
    },
  );
  if (!result.ok) return result.failure;
  const body = (result.body && typeof result.body === "object" ? result.body : {}) as Record<string, unknown>;
  return {
    kind: "accepted",
    createdCollections: countOr(body.createdCollections),
    addedTags: countOr(body.addedTags),
    dropped: countOr(body.dropped),
    taxonomy: readAcceptedTaxonomy(body.taxonomy),
  };
}

// -- cross-context notification -------------------------------------------

/** Same channel db.ts's notifyChange() broadcasts on, which is also the one
 *  `subscribeToAiSettings` opens. A status change announced on it refreshes a
 *  panel in another tab, and a settings write on it refreshes a status nobody
 *  else knows has gone stale. */
const DB_CHANNEL = "nook-db";

/** Listeners in this context. A BroadcastChannel never delivers back to the
 *  channel that posted, so without this the panel that asked for a run would
 *  be the one panel that never hears about it. */
const localListeners = new Set<() => void>();

/**
 * A failed notification must not fail the call that already succeeded, so this
 * is fire-and-forget and carries no data: every context that hears it re-reads
 * the status from the server rather than trusting a value in the message.
 */
export function announceAiStatusChange(): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(DB_CHANNEL);
    channel.postMessage({ type: "changed", stores: ["meta"], ids: [] });
    channel.close();
  } catch {
    // Ignored — see above.
  }
  for (const listener of [...localListeners]) {
    try {
      listener();
    } catch {
      // One panel's bad render must not stop the others from being told.
    }
  }
}

/** Test-only, in the style of `NookDB._resetForTests()`: the listener set is a
 *  module-level singleton, so a test that leaves a subscription open would
 *  otherwise see the next test's calls. */
export function _resetAiClientForTests(): void {
  localListeners.clear();
}

/**
 * Calls `listener` with the current status now, and again with a freshly read
 * one whenever the status may have changed — in this context (a run requested,
 * a taxonomy accepted) or another one (the "nook-db" channel, which a settings
 * write announces on too). Every notification re-reads rather than carrying a
 * value, so a panel can never be handed a status another context has since
 * superseded. Returns an unsubscribe function; no browser globals are touched
 * when BroadcastChannel is unavailable (Node tests).
 */
export function subscribeToAiStatus(listener: (status: AiStatus | null) => void): () => void {
  let disposed = false;
  const refresh = () => {
    if (disposed) return;
    void loadAiStatus().then((status) => {
      if (!disposed) listener(status);
    });
  };

  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(DB_CHANNEL);
  if (channel) channel.onmessage = refresh;
  localListeners.add(refresh);
  refresh();

  return () => {
    disposed = true;
    localListeners.delete(refresh);
    if (channel) channel.close();
  };
}
