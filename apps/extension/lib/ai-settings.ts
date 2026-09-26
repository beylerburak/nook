/**
 * AI feature toggles and thresholds — see docs/ai.md, "Settings surface".
 *
 * These are account preferences, stored server-side (`GET`/`PUT /api/ai/settings`,
 * apps/api/src/ai-settings.ts) rather than in this browser's own storage. That
 * used to be backwards: `ai.settings` lived in per-origin IndexedDB `meta`, so
 * a toggle flipped in the web app wrote a value the extension's service worker
 * — the only place a pass actually runs — never read, and vice versa. A
 * classification is an authenticated server call regardless of which host
 * asked for it, so the setting that gates it belongs to the account, the same
 * as the bookmarks and collections it acts on.
 *
 * `AI_SETTINGS_META_KEY` still names an IndexedDB `meta` key, but it is now a
 * read-through CACHE of the last value this browser fetched, not the source
 * of truth: `loadAiSettings()` always asks the server first and only falls
 * back to it when there is nothing to ask (signed out) or the ask failed
 * (offline, a 5xx). That is what keeps the panel showing something sane the
 * instant it mounts, and what keeps `saveAiSettings` honest when a write
 * fails: a write that throws propagates, exactly as before, rather than
 * silently reporting success for a preference the server never stored.
 *
 * Every feature is off by default and every threshold defaults high: these are
 * background passes over someone's real library, and the safe failure for
 * anything the model isn't sure about is leaving it alone. Summaries are in
 * here for the same reason rather than a milder one — a summary is text the
 * model wrote sitting next to what the user saved, so turning it on is the
 * user's decision, not a default.
 */

import { cloudApiUrl, cloudRequestAuth, type RequestAuth } from "./cloud-sync";
import * as NookDB from "./db";

export const AI_SETTINGS_META_KEY = "ai.settings";

/** Mirrors `TaxonomyLanguage` in apps/api/src/ai.ts, which is the one that
 *  reaches the proposer. Duplicated rather than shared: the api workspace has no
 *  dependency on the extension, and a six-value union is not worth coupling for. */
export type TaxonomyLanguage = "auto" | "en" | "tr" | "de" | "fr" | "es";

export interface AiSettings {
  /** Feature 1: file into existing collections and add existing tags. */
  autoClassify: boolean;
  /** Feature 2: propose brand-new collection names and a tag vocabulary. */
  autoTaxonomy: boolean;
  /**
   * Feature 3: write a one-or-two-sentence summary on bookmarks long enough to
   * need one. Off by default for the same reason as the other two, and more so:
   * this one puts text in the user's own voice next to what they saved, and a
   * summary is only worth having where `shortDescription`'s 180-character
   * truncation is actually hiding something.
   */
  autoSummarize: boolean;
  collectionMinConfidence: number; // default 0.75
  tagMinNoul: number; // default 0.80
  maxTags: number; // default 3
  /**
   * What language to name new collections and tags in. `auto` follows the
   * library, which is right when it is mixed; the rest are for a library that
   * is all one language, where guessing is a coin flip the user can simply
   * answer instead.
   *
   * NOT the summary language, which is a different question entirely: a summary
   * is written in the language of the content it summarises, whatever this says
   * (docs/retrieval.md, "Summaries"). One library can be named in English and
   * saved in Turkish, and a Turkish page summarised in English because the
   * taxonomy is called "Reading" is a bug the user reads.
   */
  taxonomyLanguage: TaxonomyLanguage;
}

/** Kept in step with the server's own list, which is the one that reaches the
 *  proposer. An unknown stored value falls back to `auto` rather than failing. */
export const TAXONOMY_LANGUAGES: Array<{ value: TaxonomyLanguage; label: string }> = [
  { value: "auto", label: "Match my library" },
  { value: "tr", label: "Türkçe" },
  { value: "en", label: "English" },
  { value: "de", label: "Deutsch" },
  { value: "fr", label: "Français" },
  { value: "es", label: "Español" },
];

/** Both thresholds are measured, not guessed — the sweep behind them is in
 *  docs/ai-calibration.md. Keep them in step with DEFAULT_COLLECTION_MIN_CONFIDENCE
 *  in apps/api/src/ai.ts, which is the one applied when a request omits them. */
export const DEFAULT_AI_SETTINGS: AiSettings = {
  autoClassify: false,
  autoTaxonomy: false,
  autoSummarize: false,
  collectionMinConfidence: 0.75,
  tagMinNoul: 0.8,
  maxTags: 3,
  taxonomyLanguage: "auto",
};

// A threshold is a probability, so anything outside 0..1 is nonsense and is
// clamped rather than trusted. maxTags is a count, so it's rounded, and capped
// at a number where a bookmark is still a bookmark: the model is asked one
// `Noul` per existing tag, and a dozen auto-added tags on one item is noise the
// user would have to clean up by hand.
const MAX_TAGS_LIMIT = 10;

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
}

function clampProbability(value: unknown, fallback: number): number {
  const parsed = toNumber(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(1, Math.max(0, parsed));
}

function clampTagCount(value: unknown, fallback: number): number {
  const parsed = toNumber(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_TAGS_LIMIT, Math.max(0, Math.round(parsed)));
}

/**
 * Coerces anything - a missing key, a half-written record from an older
 * version, a value a future version wrote, hand-edited nonsense - into a
 * complete, in-range AiSettings. Total by construction: every field has a
 * defined output for every input, so no caller ever has to check.
 */
function normalizeAiSettings(value: unknown): AiSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    autoClassify: typeof raw.autoClassify === "boolean" ? raw.autoClassify : DEFAULT_AI_SETTINGS.autoClassify,
    autoTaxonomy: typeof raw.autoTaxonomy === "boolean" ? raw.autoTaxonomy : DEFAULT_AI_SETTINGS.autoTaxonomy,
    // A record written before this toggle existed, or one that lost the field
    // in a partial write, resolves to the default rather than to `undefined` —
    // which is why the loader is total and no panel has to guard the toggle.
    autoSummarize: typeof raw.autoSummarize === "boolean" ? raw.autoSummarize : DEFAULT_AI_SETTINGS.autoSummarize,
    collectionMinConfidence: clampProbability(raw.collectionMinConfidence, DEFAULT_AI_SETTINGS.collectionMinConfidence),
    tagMinNoul: clampProbability(raw.tagMinNoul, DEFAULT_AI_SETTINGS.tagMinNoul),
    maxTags: clampTagCount(raw.maxTags, DEFAULT_AI_SETTINGS.maxTags),
    taxonomyLanguage: TAXONOMY_LANGUAGES.some((entry) => entry.value === raw.taxonomyLanguage)
      ? (raw.taxonomyLanguage as TaxonomyLanguage)
      : DEFAULT_AI_SETTINGS.taxonomyLanguage,
  };
}

// -- server I/O -----------------------------------------------------------

/** Minimal structural fetch, so a test can hand in a plain stub. Mirrors AiFetch
 *  in lib/ai-runner.ts and SearchFetch in lib/retrieval.ts. */
export type AiSettingsFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface AiSettingsDeps {
  /** Defaults to the global fetch. */
  fetch?: AiSettingsFetch;
  /** Defaults to cloudRequestAuth() — bearer in the extension, cookie on the web. */
  requestAuth?: () => Promise<RequestAuth | null>;
  /** Defaults to cloudApiUrl(). */
  apiUrl?: string;
  /** Epoch-ms clock; injected so the cache window below is testable without waiting. */
  now?: () => number;
}

function buildRequestInit(auth: RequestAuth, init: RequestInit): RequestInit {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) };
  const requestInit: RequestInit = { ...init, headers };
  if (auth.mode === "bearer") headers.Authorization = `Bearer ${auth.token}`;
  else requestInit.credentials = "include";
  return requestInit;
}

/** One round trip, no caching — always hits the server (or fails). The public
 *  `loadAiSettings`/`saveAiSettings` below are what callers actually use. */
async function requestServerSettings(deps: AiSettingsDeps, init: RequestInit): Promise<AiSettings | null> {
  const requestAuth = deps.requestAuth ?? cloudRequestAuth;
  const apiUrl = (deps.apiUrl ?? cloudApiUrl()).replace(/\/$/, "");
  const doFetch: AiSettingsFetch = deps.fetch ?? ((input, requestInit) => fetch(input, requestInit));

  let auth: RequestAuth | null;
  try {
    auth = await requestAuth();
  } catch {
    return null;
  }
  // No account bound to this browser at all: settings are server-side now, so
  // there is nothing to ask for. Not an error — a local-only browser (or a web
  // tab before its first sign-in) is a normal, expected state.
  if (!auth) return null;

  let response: Response;
  try {
    response = await doFetch(`${apiUrl}/api/ai/settings`, buildRequestInit(auth, init));
  } catch {
    return null; // offline / network error — the caller falls back to its cache.
  }
  if (!response.ok) return null;
  try {
    return normalizeAiSettings(await response.json());
  } catch {
    return null;
  }
}

/**
 * How long a fetched value is trusted before the next `loadAiSettings()`
 * asks the server again.
 *
 * A GET is cheap on its own, but `aiIsArmable()` (entrypoints/background/
 * index.ts) calls `loadAiSettings()` once per saved bookmark, and importing a
 * library one item at a time must not turn into one request per item. Long
 * enough to absorb a burst of saves; short enough that a toggle flipped in
 * another tab takes effect within the same browsing session. `saveAiSettings`
 * and a cross-context change (the BroadcastChannel handler below) both clear
 * it immediately, so neither has to wait out the window.
 */
const CACHE_TTL_MS = 60_000;

let cache: { value: AiSettings; expiresAt: number } | null = null;

/** Any dep override means a test (or a caller with its own transport, like
 *  lib/ai-runner.ts reusing the runner's own fetch/session) is driving this
 *  call directly, so the shared cache is bypassed rather than silently mixing
 *  a real fetch's result with a stubbed one across calls. */
function bypassesCache(deps: AiSettingsDeps): boolean {
  return deps.fetch !== undefined || deps.requestAuth !== undefined || deps.apiUrl !== undefined;
}

function invalidateCache(): void {
  cache = null;
}

/** Test-only, in the style of `NookDB._resetForTests()`: the cache is a module-
 *  level singleton, so a test exercising it (rather than bypassing it with an
 *  explicit dep) needs a way to start from cold between cases. */
export function _resetAiSettingsCacheForTests(): void {
  cache = null;
}

async function readLocalCache(): Promise<AiSettings> {
  try {
    return normalizeAiSettings(await NookDB.getMeta(AI_SETTINGS_META_KEY));
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

/** Always a usable value, and never throws: signed out, offline, and a 5xx are
 *  all ordinary states here, each answered by falling back to the last value
 *  this browser saw (or the conservative defaults if it has never seen one). */
export async function loadAiSettings(deps: AiSettingsDeps = {}): Promise<AiSettings> {
  const now = deps.now ?? (() => Date.now());
  const cacheable = !bypassesCache(deps);
  if (cacheable && cache && now() < cache.expiresAt) return cache.value;

  const fetched = await requestServerSettings(deps, { method: "GET" });
  if (fetched) {
    if (cacheable) cache = { value: fetched, expiresAt: now() + CACHE_TTL_MS };
    // Best-effort local mirror for the next offline/signed-out fallback and for
    // any reader that still expects the plain meta key (none in this codebase
    // today, but the key predates this rewrite and costs nothing to keep warm).
    // Deliberately no notifyLocal() here — this runs on every load (including a
    // subscriber's own initial read), and firing it here would echo every
    // listener's own load back at every other listener. saveAiSettings is the
    // one write worth telling this context's other listeners about; a change
    // from elsewhere reaches them through the BroadcastChannel handler below.
    await NookDB.setMeta(AI_SETTINGS_META_KEY, fetched).catch(() => {});
    return fetched;
  }
  if (cacheable) invalidateCache();
  return readLocalCache();
}

/**
 * Merges `patch` over the account's currently stored settings via
 * `PUT /api/ai/settings` and returns what the server actually stored — the
 * same shape `saveAiUserSettingsPatch` returns on the server (apps/api/src/
 * ai-settings.ts), normalized again here in case a future field this build
 * doesn't know about needs a safe local default too.
 *
 * A write that throws propagates, exactly as it did when this wrote straight
 * to IndexedDB: silently reporting success for a preference that was never
 * stored would be worse than the error the panel already knows how to show
 * (`useAiSettings` in AiPanel.tsx toasts it).
 */
export async function saveAiSettings(patch: Partial<AiSettings>, deps: AiSettingsDeps = {}): Promise<AiSettings> {
  const now = deps.now ?? (() => Date.now());
  const saved = await requestServerSettings(deps, { method: "PUT", body: JSON.stringify(patch) });
  if (!saved) throw new Error("Could not save AI settings.");
  if (!bypassesCache(deps)) cache = { value: saved, expiresAt: now() + CACHE_TTL_MS };
  await NookDB.setMeta(AI_SETTINGS_META_KEY, saved).catch(() => {});
  notifyLocal(saved);
  announceChange();
  return saved;
}

// -- cross-context notification --------------------------------------------

/** Same channel db.ts's notifyChange() broadcasts on, so existing listeners (cloud-runner, the dashboard) treat a settings write like any other write. */
const DB_CHANNEL = "nook-db";

/**
 * A failed notification must not fail the write that already succeeded, so
 * this is fire-and-forget the same way it always was — only now it also
 * carries no data of its own: every context that hears it re-fetches from the
 * server (bypassing its own cache, see the handler below) rather than trusting
 * a value baked into the message.
 */
function announceChange(): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(DB_CHANNEL);
    channel.postMessage({ type: "changed", stores: ["meta"], ids: [] });
    channel.close();
  } catch {
    // Ignored — see above.
  }
}

/** Listeners in this context. A BroadcastChannel never delivers back to the channel that posted, so without this a save would update every other surface and not the one that made it. */
const localListeners = new Set<(settings: AiSettings) => void>();

function notifyLocal(settings: AiSettings): void {
  for (const listener of [...localListeners]) {
    try {
      listener(settings);
    } catch {
      // One panel's bad render must not stop the others from being told.
    }
  }
}

/**
 * Calls `listener` now and again whenever the settings may have changed -
 * in this context (a save) or another one (the "nook-db" channel). Listens to
 * the whole channel rather than filtering on the meta store: db.ts never
 * broadcasts "meta", so a filtered listener would only ever see writes made
 * through saveAiSettings, and a settings write made elsewhere would be
 * invisible. A cross-context message invalidates this context's own cache
 * before re-fetching — otherwise a save landing in one tab could be masked by
 * another tab's still-warm cache for up to CACHE_TTL_MS. Returns an
 * unsubscribe function; no browser globals are touched when BroadcastChannel
 * is unavailable (Node tests).
 */
export function subscribeToAiSettings(listener: (settings: AiSettings) => void): () => void {
  let disposed = false;
  const emit = (fromBroadcast: boolean) => {
    if (disposed) return;
    if (fromBroadcast) invalidateCache();
    void loadAiSettings().then((settings) => {
      if (!disposed) listener(settings);
    });
  };

  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(DB_CHANNEL);
  if (channel) channel.onmessage = () => emit(true);
  localListeners.add(listener);
  emit(false);

  return () => {
    disposed = true;
    localListeners.delete(listener);
    if (channel) channel.close();
  };
}
