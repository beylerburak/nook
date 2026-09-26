/**
 * Client half of semantic search — docs/retrieval.md ("Search" and "Client
 * behaviour").
 *
 * Two passes, and the order between them is the whole feature. The local pass is
 * one substring match per bookmark over text the client already holds; the server
 * pass is a lexical + cosine fusion over an index the client cannot see. The
 * local pass runs on every keystroke and is what the library renders; the server
 * pass is debounced, authorised with `cloudRequestAuth()` — a bearer token in
 * the extension, the browser's own cookie on the web, exactly like every other
 * authenticated Nook route (lib/ai-client.ts, lib/ai-settings.ts) — and
 * *replaces* the visible set when — and only when — it comes back with ids.
 *
 * Nothing on the server path is allowed to empty the view. A signed-out browser,
 * an offline one, a server with no index, a 5xx and a malformed body all report
 * "no ids" instead of throwing, because search is a live-updating input and the
 * one failure that must never happen is an empty library in place of the list
 * the user was reading a second ago.
 *
 * Pure and dependency-injected the way every other server-backed module here
 * is: `fetch` and a clock are arguments, so every branch runs in a plain Node
 * test with no network.
 */

import { cloudApiUrl, cloudRequestAuth, type RequestAuth } from "./cloud-sync";
import type { Bookmark } from "./types";

// -- configuration ----------------------------------------------------------

/**
 * How many ids one request asks for.
 *
 * The client is what turns ids back into rows, so whatever comes back *is* the
 * visible set for that query: asking for the server's default 20 would silently
 * cut the library view off at 20 and leave the rest unreachable until the user
 * retyped. 100 is the server's own cap (MAX_LIMIT in apps/api/src/retrieval.ts),
 * so this asks for everything the contract allows in one round trip, and `total`
 * is what makes the shortfall honest in the UI.
 */
export const SEARCH_RESULT_LIMIT = 100;

/**
 * How long a server that reported "I have no index" is taken at its word.
 *
 * Without it every pause in typing re-probes a server that has nothing to search,
 * forever. It is a window rather than a permanent latch because the cause is
 * usually fixed without a client release — an operator sets `OPENAI_API_KEY`, or
 * the embedder finishes a library — and the user should not have to reload the
 * page to find out. Long enough to cover a session of searching, short enough
 * that a fixed index is picked up without a restart.
 */
export const SEARCH_UNCONFIGURED_WINDOW_MS = 15 * 60_000;

// -- types ------------------------------------------------------------------

export interface SearchHit {
  id: string;
  score: number;
  /** 1-based, or null when the lexical ranker did not place this id at all. */
  lexicalRank: number | null;
  /** 1-based, or null when the semantic ranker did not place this id at all. */
  semanticRank: number | null;
}

/** The reasons apps/api/src/retrieval.ts documents. */
export type KnownSearchReason = "unconfigured" | "empty-index" | "no-vector" | "no-matches";

/**
 * Open on purpose: `reason` is documented as additive, so a reason this build has
 * never heard of is a fact to carry through to the caller, not a parse failure.
 * An unknown reason is treated exactly like `no-matches` — both mean "the server
 * answered and had nothing to show" — and never shown to the user verbatim.
 */
export type SearchReason = KnownSearchReason | (string & {});

/** Facets the server can apply itself, mirroring the view the user is looking at. */
export interface SearchFilters {
  collections?: string[];
  tags?: string[];
  sources?: string[];
}

/**
 * Why the local pass is what the user sees, when the server pass did not produce
 * the visible set. Null means the server answered with ids.
 *
 * The distinction the UI acts on is "is there something to say": `signed-out`
 * and `offline` are states the user can leave and the sync indicator already
 * reports, `unsearchable` explains an empty result set, and the last three are
 * deliberately silent — an operator's missing key, a client bug and a 401 that
 * syncCloud will handle are not the user's problem, and a red dot for a feature
 * they never turned on is worse than no dot.
 */
export type SearchFallback =
  /** `#tag` / `@author`, or no query at all: answered locally, in full, by design. */
  | "local-query"
  /** No session in this browser, so the route is unreachable. No request was sent. */
  | "signed-out"
  /** 401: the session is gone and only a re-sign-in restores it. Not retried. */
  | "unauthorized"
  /** No connection, so the request was never worth sending. */
  | "offline"
  /** The server has no index for this account, so there is nothing to search. */
  | "unconfigured"
  /** The index answered and it had nothing for this query. */
  | "unsearchable"
  /** A 400 (a client bug), a 5xx, or a body we could not read. Logged, not retried. */
  | "failed";

export interface SearchOutcome {
  /** Ids in the server's relevance order. Empty whenever the local pass stands. */
  ids: string[];
  /** The server's match count after filtering, before the limit slice. 0 when it did not answer. */
  total: number;
  /** The server's own reason, when it sent one. */
  reason?: SearchReason;
  /** Null exactly when `ids` is a usable answer. */
  fallback: SearchFallback | null;
}

export interface ParsedSearchResponse {
  results: SearchHit[];
  total: number;
  reason?: SearchReason;
}

/** Minimal structural fetch, so a test can hand in a plain stub. Mirrors AiFetch. */
export type SearchFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface SearchDeps {
  /** Defaults to the global fetch. */
  fetch?: SearchFetch;
  /**
   * Defaults to cloudRequestAuth() — bearer in the extension, cookie on the
   * web, `null` when signed out. Mirrors the seam lib/ai-client.ts and
   * lib/ai-settings.ts use for every other authenticated Nook route, so this
   * one works on both hosts the same way theirs do.
   */
  session?: () => Promise<RequestAuth | null>;
  /** Defaults to cloudApiUrl(). */
  apiUrl?: string;
  /** Defaults to the same navigator predicate cloud-sync builds `offline` on. */
  isOffline?: () => boolean;
  /** Defaults to the module-level latch `isSearchConfigured()` reads. */
  availability?: SearchAvailability;
  /** Defaults to SEARCH_RESULT_LIMIT. */
  limit?: number;
  /** Facets for the request. Omitted entirely when empty. */
  filters?: SearchFilters;
}

// -- the local pass ---------------------------------------------------------

/**
 * The local pass: one case-insensitive substring match over every text field the
 * library stores.
 *
 * Kept exactly as it was before the index existed, and kept first: it is exact for
 * a literal term, it needs no network, and it is the answer while signed out. It
 * is also demonstrably not enough on its own — nothing here folds accents or
 * Turkish agglutination, so `gelistirme` misses `geliştirme` and six real queries
 * against the measured library returned zero substring matches (docs/retrieval.md).
 * That gap is what the server pass closes; this one is the floor, not the ceiling.
 *
 * `@` and `#` are decided here rather than by the server, on purpose: they are
 * exact, instant, offline filters that already work, and a round trip would only
 * make the most common query in the box slower.
 */
export function matchesSearch(item: Bookmark, query: string): boolean {
  if (!query) return true;
  const normalized = query.toLowerCase();
  const prefix = normalized[0];
  const term = prefix === "@" || prefix === "#" ? normalized.slice(1) : normalized;
  if (prefix === "@") {
    return [item.creator?.name, item.creator?.handle, item.quote?.creator?.name, item.quote?.creator?.handle]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(term));
  }
  if (prefix === "#") {
    return (item.tags || []).some((tag) => tag.toLowerCase().replace(/^#/, "").includes(term));
  }
  const searchable = [
    item.title,
    item.shortDescription,
    item.description,
    item.note,
    item.url,
    item.urls?.join(" "),
    item.creator?.name,
    item.creator?.handle,
    item.quote?.text,
    item.quote?.creator?.name,
    item.quote?.creator?.handle,
    ...(item.tags || []),
  ].filter(Boolean).join(" ").toLowerCase();
  return searchable.includes(term);
}

/**
 * The visible set for the local pass: the same filter `matchesSearch` applies,
 * over a whole array. An empty query is the whole array rather than an empty one,
 * which is what makes clearing the box return the normal view instantly.
 */
export function localResults(bookmarks: Bookmark[], query: string): Bookmark[] {
  const trimmed = query.trim();
  if (!trimmed) return [...bookmarks];
  return bookmarks.filter((item) => matchesSearch(item, trimmed));
}

// -- ids --------------------------------------------------------------------

/**
 * The local ids a server-side id could belong to.
 *
 * For most bookmarks the server's id is the local id verbatim. A Chrome bookmark
 * is the exception: `remoteIdFor` in lib/cloud-sync.ts uploads it as
 * `chrome:<deviceId>:<numeric>` while the record keeps `chrome:<numeric>`, and
 * that mapping lives in a sync-state field this module cannot read. The device id
 * identifies one browser profile and never changes for it, so the tail is a
 * stable alias — without it, every saved web page would silently drop out of a
 * semantic search the moment that profile had synced from anywhere.
 */
function serverIdAliases(id: string): string[] {
  const segments = id.split(":");
  if (segments.length > 2 && segments[0] === "chrome") {
    return [id, `chrome:${segments.slice(2).join(":")}`];
  }
  return [id];
}

/**
 * Maps the ids the server returned back onto local bookmarks, in the server's
 * order.
 *
 * Ids the client cannot resolve are dropped rather than rendered as gaps: a
 * bookmark deleted on another device, or one the index has not caught up with,
 * must not become an empty row. Ids that resolve to a record the current view
 * filtered out are dropped for the same reason — `bookmarks` is what the view
 * admitted, so this also keeps the sidebar's collection/tag/source filter
 * authoritative even if a filter fails to reach the server.
 */
export function resolveServerIds(bookmarks: Bookmark[], ids: string[]): Bookmark[] {
  if (ids.length === 0) return [];
  const byId = new Map<string, Bookmark>();
  for (const item of bookmarks) byId.set(item.id, item);

  const resolved: Bookmark[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    let item: Bookmark | undefined;
    for (const alias of serverIdAliases(id)) {
      const candidate = byId.get(alias);
      if (candidate) {
        item = candidate;
        break;
      }
    }
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    resolved.push(item);
  }
  return resolved;
}

// -- what may be asked ------------------------------------------------------

/**
 * Whether a query is worth a server request at all.
 *
 * `@author` and `#tag` never are: they are exact, instant, offline, and already
 * correct locally, so a request would buy nothing and cost the common case its
 * speed. Everything else — a bare word or phrase — is the case the index exists
 * for, and a substring pass over a Turkish library returns nothing for many of
 * them.
 */
export function shouldUseServerSearch(query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return false;
  const prefix = trimmed[0].toLowerCase();
  return prefix !== "@" && prefix !== "#";
}

// -- reading the answer -----------------------------------------------------

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function rankOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Normalizes a `/api/search` body, in the defensive style of
 * `parseClassifyResponse`.
 *
 * Never throws, because a bad body here must not take the library view with it:
 * every unreadable shape degrades to "no results", which the caller answers by
 * keeping the local pass it is already rendering. A null entry is a hole in the
 * array and is skipped, since one malformed row must not discard the rows around
 * it. Ranks and scores are optional in practice and default to 0/null, which
 * costs a bad sort on one result and never a crash mid-keystroke.
 */
export function parseSearchResponse(body: unknown): ParsedSearchResponse {
  if (!body || typeof body !== "object") return { results: [], total: 0 };
  const record = body as Record<string, unknown>;

  const results: SearchHit[] = [];
  for (const entry of Array.isArray(record.results) ? record.results : []) {
    if (!entry || typeof entry !== "object") continue;
    const hit = entry as Record<string, unknown>;
    if (typeof hit.id !== "string" || hit.id === "") continue;
    results.push({
      id: hit.id,
      score: finiteOr(hit.score, 0),
      lexicalRank: rankOrNull(hit.lexicalRank),
      semanticRank: rankOrNull(hit.semanticRank),
    });
  }

  // `total` is the count before the limit slice, so it can legitimately exceed
  // `results.length` — but never fall below it, or a server that sent three
  // results and a stale `total: 0` would render as "0 of 3".
  const total = Math.max(finiteOr(record.total, 0), results.length);
  const reason = typeof record.reason === "string" && record.reason !== "" ? record.reason : undefined;
  return { results, total, ...(reason ? { reason } : {}) };
}

/**
 * Turns the server's own `reason` into the one distinction the UI makes.
 *
 * `unconfigured` and `empty-index` are one state here — no index to search — even
 * though they are different facts in a server log. An unembedded library is the
 * case the 15-minute window is sized for: the embedder catches up on its own, and
 * the local pass is a perfectly good answer meanwhile.
 *
 * Everything else, including a reason this build has never heard of, is
 * `unsearchable`: the index answered and it had nothing. Treating an unknown
 * reason as "no index" instead would hide results from a server that grew a new
 * degradation mode, and the contract is explicit that `reason` is additive.
 */
function fallbackForReason(reason: string | undefined): SearchFallback {
  if (reason === "unconfigured" || reason === "empty-index") return "unconfigured";
  return "unsearchable";
}

function localOutcome(fallback: SearchFallback, reason?: SearchReason): SearchOutcome {
  return { ids: [], total: 0, ...(reason ? { reason } : {}), fallback };
}

// -- the unconfigured latch -------------------------------------------------

export interface SearchAvailability {
  /** False once the server has been reported as having no index. */
  isConfigured(): boolean;
  /**
   * Called by `searchLibrary` with every answer it gets, so the fact is learned
   * once. Takes no timestamp argument: this latch is the only thing in the module
   * that cares about time, so it owns the clock and `isConfigured` cannot be asked
   * about a different "now" than the one it recorded its window against.
   */
  record(outcome: SearchOutcome): void;
}

export interface SearchAvailabilityOptions {
  /** How long a report of "no index" is trusted. Default SEARCH_UNCONFIGURED_WINDOW_MS. */
  windowMs?: number;
  /** Epoch-ms clock; injected so the window is testable without waiting. */
  now?: () => number;
}

/**
 * In-memory latch for "this server has no index to search".
 *
 * Deliberately not persisted: it is a cache of one server's answer, it expires on
 * its own, and writing it to IndexedDB would make a feature the user never turned
 * on leave a mark in their library. Also deliberately not keyed by account, which
 * is the one thing it gets wrong: a second account signing in inside the window of
 * a first one that had no index waits out that window before its own semantic
 * search begins. Paying that is cheaper than threading an owner id through the
 * reader, and the cost is invisible either way — the local pass is the whole answer
 * meanwhile, and the UI says nothing about it.
 */
export function createSearchAvailability(options: SearchAvailabilityOptions = {}): SearchAvailability {
  const windowMs = options.windowMs ?? SEARCH_UNCONFIGURED_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  let unconfiguredUntil = 0;
  let learned = false;

  return {
    isConfigured() {
      return !learned || now() >= unconfiguredUntil;
    },
    record(outcome) {
      if (outcome.fallback !== "unconfigured") {
        // Any answer that is not "no index" proves there is one, and a 200 does
        // arrive while the latch is closed whenever a second query was already in
        // flight when the first one reported the fact.
        unconfiguredUntil = 0;
        learned = false;
        return;
      }
      // Measured from the newest report rather than the first: a library still
      // being embedded answers `empty-index` for as long as that takes, and
      // re-asking on every pause in typing is what this latch exists to prevent.
      learned = true;
      unconfiguredUntil = now() + windowMs;
    },
  };
}

/** The latch `searchLibrary` records into and `isSearchConfigured` reads. */
export const searchAvailability: SearchAvailability = createSearchAvailability();

/**
 * Whether a server search is still worth attempting, so a caller can skip the
 * request entirely against a server it has already learned has no index. True
 * until something has actually answered "no index" — the only way to learn that
 * is to ask.
 */
export function isSearchConfigured(): boolean {
  return searchAvailability.isConfigured();
}

// -- the request ------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function navigatorIsOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function requestBody(query: string, limit: number, filters: SearchFilters | undefined): string {
  const body: Record<string, unknown> = { q: query, limit };
  // Omitted rather than sent empty: a filter the user has not set is not a filter
  // of nothing, and the request stays readable in a log.
  if (filters?.collections?.length) body.collections = filters.collections;
  if (filters?.tags?.length) body.tags = filters.tags;
  if (filters?.sources?.length) body.sources = filters.sources;
  return JSON.stringify(body);
}

/**
 * Runs the server pass for one query.
 *
 * The order of the gates is the order of how cheap they are to be wrong about:
 * eligibility, then the session, then what the last answer taught us, then the
 * network. Nothing past a gate runs, and a gate that stops the search says why
 * in `fallback` so the caller can decide whether that is worth telling the user.
 *
 * A 401 is terminal for the session and a 400 is a client bug; both are logged
 * once and never retried, because retrying either would either hammer a server
 * that will keep refusing or paper over a bug that only a fix can close. Search
 * does not clear the stored token/cookie-bound account on a 401 the way
 * `syncCloud` does — teardown of a session belongs to the one subsystem that
 * owns it, and search runs on every pause in typing.
 */
export async function searchLibrary(query: string, deps: SearchDeps = {}): Promise<SearchOutcome> {
  const readSession = deps.session ?? cloudRequestAuth;
  const apiUrl = (deps.apiUrl ?? cloudApiUrl()).replace(/\/$/, "");
  const doFetch: SearchFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const isOffline = deps.isOffline ?? navigatorIsOffline;
  const availability = deps.availability ?? searchAvailability;
  const limit = deps.limit ?? SEARCH_RESULT_LIMIT;

  const trimmed = query.trim();
  if (!shouldUseServerSearch(trimmed)) return localOutcome("local-query");

  // No auth means the route is unreachable, so no request is made at all —
  // not one that would come back 401 for a signed-out user typing in a search box.
  // Reading the auth can itself fail (IndexedDB), and a thrown promise from a
  // live-updating input is not a state any caller can render, so it degrades to
  // the same quiet "no server results" as every other failure here.
  let auth: RequestAuth | null = null;
  try {
    auth = await readSession();
  } catch (error) {
    console.warn(`[Nook] Could not read the cloud session: ${errorMessage(error)}`);
    return localOutcome("failed");
  }
  if (!auth) return localOutcome("signed-out");

  // Learned from a previous answer, not from a guess: a server with no index
  // would answer the same thing for every pause in typing for as long as it has
  // none. Deliberately not recorded again here — re-recording would push the
  // window out on every query and the latch would never expire.
  if (!availability.isConfigured()) return localOutcome("unconfigured");

  // Offline is a normal state, and cloudStatus() already reports it — the top nav
  // says so — so this is a silent, non-error stop rather than a failed search.
  if (isOffline()) return localOutcome("offline");

  let response: Response;
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const init: RequestInit = { method: "POST", headers, body: requestBody(trimmed, limit, deps.filters) };
    // Bearer in the extension, cookie on the web — the same branch
    // lib/ai-client.ts's callRoute and lib/ai-settings.ts's buildRequestInit
    // take for every other authenticated Nook route.
    if (auth.mode === "bearer") headers.Authorization = `Bearer ${auth.token}`;
    else init.credentials = "include";
    response = await doFetch(`${apiUrl}/api/search`, init);
  } catch (error) {
    // What cloud-sync calls a network error: no HTTP reply at all. The local pass
    // is the answer, and connectivity is the sync indicator's story to tell.
    console.warn(`[Nook] Search request failed before a response: ${errorMessage(error)}`);
    return localOutcome("failed");
  }

  if (response.status === 401) {
    console.warn("[Nook] Search request rejected as unauthorized; the session needs a new sign-in.");
    return localOutcome("unauthorized");
  }
  if (response.status === 400) {
    console.error(`[Nook] Search request was invalid (400) for “${trimmed}”. This is a client bug.`);
    return localOutcome("failed");
  }
  if (!response.ok) {
    console.warn(`[Nook] Search request failed (${response.status}).`);
    return localOutcome("failed");
  }

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Unreadable JSON is not a crash: the local pass stands.
    console.warn("[Nook] Search response could not be read as JSON.");
    return localOutcome("failed");
  }
  if (!body || typeof body !== "object") {
    console.warn("[Nook] Search response was not an object.");
    return localOutcome("failed");
  }

  const parsed = parseSearchResponse(body);
  // Only a 200 gets here, so a server that had an index for this account clears
  // the latch whether or not this particular query found anything.
  const outcome: SearchOutcome = parsed.results.length > 0
    ? {
        ids: parsed.results.map((hit) => hit.id),
        total: parsed.total,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
        fallback: null,
      }
    : localOutcome(fallbackForReason(parsed.reason), parsed.reason);
  availability.record(outcome);
  return outcome;
}
