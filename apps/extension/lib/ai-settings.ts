/**
 * AI feature toggles and thresholds, stored in the IndexedDB `meta` store
 * under `ai.settings`.
 *
 * These are device preferences, in the same sense as the appearance mode: they
 * describe this browser's user, not the library. That is why they live in
 * `meta` rather than in a synced record - `wipeLocalLibrary()` clears bookmarks,
 * lists and every `cloud:`-namespaced key but keeps everything else, so signing
 * out (or switching accounts) can't silently switch classification back on, and
 * a second browser starts from the conservative defaults until its own user
 * turns the features on.
 *
 * Every feature is off by default and every threshold defaults high: these are
 * background passes over someone's real library, and the safe failure for
 * anything the model isn't sure about is leaving it alone. Summaries are in
 * here for the same reason rather than a milder one — a summary is text the
 * model wrote sitting next to what the user saved, so turning it on is the
 * user's decision, not a default.
 */

import * as NookDB from "./db";

export const AI_SETTINGS_META_KEY = "ai.settings";

/** Mirrors `TaxonomyLanguage` in apps/api/src/ai.ts, which is the one that
 *  reaches the proposer. Duplicated rather than shared: the api workspace has no
 *  dependency on the extension, and a six-value union is not worth coupling for. */
export type TaxonomyLanguage = "auto" | "en" | "tr" | "de" | "fr" | "es";

/** Same channel db.ts's notifyChange() broadcasts on, so existing listeners (cloud-runner, the dashboard) treat a settings write like any other write. */
const DB_CHANNEL = "nook-db";

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

/** Always a usable value: a failed read is a closed or missing DB, and the defaults are the safe failure. */
export async function loadAiSettings(): Promise<AiSettings> {
  try {
    return normalizeAiSettings(await NookDB.getMeta(AI_SETTINGS_META_KEY));
  } catch {
    return { ...DEFAULT_AI_SETTINGS };
  }
}

/**
 * NookDB.setMeta doesn't broadcast (db.ts's notifyChange only fires from the
 * bookmark/list write paths), so a settings write has to announce itself for
 * the other extension contexts to notice. Same channel and message shape as a
 * normal write, which also means a settings flip nudges a cloud sync run -
 * harmless, and cheaper than a second notification mechanism nobody else knows
 * to listen to.
 */
function announceChange(): void {
  if (typeof BroadcastChannel === "undefined") return;
  try {
    const channel = new BroadcastChannel(DB_CHANNEL);
    channel.postMessage({ type: "changed", stores: ["meta"], ids: [] });
    channel.close();
  } catch {
    // A failed notification must not fail the write that already succeeded.
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
 * Merges `patch` over the currently stored value and returns the result, so a
 * caller flipping one toggle never has to read first. The stored value goes
 * through the same normalization as a load, so out-of-range input can't be
 * persisted. A write that throws propagates: silently reporting success for a
 * preference that wasn't stored would be worse than an error the panel shows.
 */
export async function saveAiSettings(patch: Partial<AiSettings>): Promise<AiSettings> {
  const next = normalizeAiSettings({ ...(await loadAiSettings()), ...patch });
  await NookDB.setMeta(AI_SETTINGS_META_KEY, next);
  notifyLocal(next);
  announceChange();
  return next;
}

/**
 * Calls `listener` now and again whenever the settings may have changed -
 * in this context (a save) or another one (the "nook-db" channel). Listens to
 * the whole channel rather than filtering on the meta store: db.ts never
 * broadcasts "meta", so a filtered listener would only ever see writes made
 * through saveAiSettings, and a settings write made elsewhere would be
 * invisible. Each message costs one single-key meta read. Returns an
 * unsubscribe function; no browser globals are touched when BroadcastChannel
 * is unavailable (Node tests).
 */
export function subscribeToAiSettings(listener: (settings: AiSettings) => void): () => void {
  let disposed = false;
  const emit = () => {
    if (disposed) return;
    void loadAiSettings().then((settings) => {
      if (!disposed) listener(settings);
    });
  };

  const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(DB_CHANNEL);
  if (channel) channel.onmessage = emit;
  localListeners.add(listener);
  emit();

  return () => {
    disposed = true;
    localListeners.delete(listener);
    if (channel) channel.close();
  };
}
