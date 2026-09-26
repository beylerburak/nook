/**
 * Server side of AI settings — see docs/ai.md, "Settings surface", and
 * apps/api/src/server.ts for the two routes that call into this file.
 *
 * These used to be a per-origin IndexedDB `meta` key inside the extension
 * (apps/extension/lib/ai-settings.ts), which is why a toggle flipped in the
 * web app had nothing reading it: the extension's service worker never saw a
 * write made to the web origin's own IndexedDB. Moving the record here makes
 * it what it always should have been — an account preference, not a browser
 * one — so the extension and the web app read and write the exact same row.
 *
 * The wire shape is duplicated from apps/extension/lib/ai-settings.ts on
 * purpose, in the style already used for `ClassifySettings` above: the api
 * workspace does not depend on the extension, so the two copies are kept in
 * sync by hand and must not drift.
 */

import type { Pool } from "pg";
import {
  DEFAULT_COLLECTION_MIN_CONFIDENCE,
  DEFAULT_MAX_TAGS,
  DEFAULT_TAG_MIN_NOUL,
  type TaxonomyLanguage,
} from "./ai.js";

export interface AiUserSettings {
  /** Feature 1: file into existing collections and add existing tags. */
  autoClassify: boolean;
  /** Feature 2: propose brand-new collection names and a tag vocabulary. */
  autoTaxonomy: boolean;
  /** Feature 3: write a short summary on bookmarks long enough to need one. */
  autoSummarize: boolean;
  collectionMinConfidence: number;
  tagMinNoul: number;
  maxTags: number;
  taxonomyLanguage: TaxonomyLanguage;
}

/** Every feature off, every threshold at its measured default — mirrors
 *  DEFAULT_AI_SETTINGS in apps/extension/lib/ai-settings.ts. A background pass
 *  over someone's real library should never turn itself on for them, and a
 *  brand-new account (or a row this server has never written) is the case
 *  this covers: `getAiUserSettings` returns exactly this when no row exists. */
export const DEFAULT_AI_USER_SETTINGS: AiUserSettings = {
  autoClassify: false,
  autoTaxonomy: false,
  autoSummarize: false,
  collectionMinConfidence: DEFAULT_COLLECTION_MIN_CONFIDENCE,
  tagMinNoul: DEFAULT_TAG_MIN_NOUL,
  maxTags: DEFAULT_MAX_TAGS,
  taxonomyLanguage: "auto",
};

const TAXONOMY_LANGUAGES: TaxonomyLanguage[] = ["auto", "en", "tr", "de", "fr", "es"];

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

// Mirrors MAX_TAGS_LIMIT in apps/extension/lib/ai-settings.ts: a threshold is
// a probability so it clamps, but a tag count is a count, and a dozen
// auto-added tags on one bookmark is noise a user would have to clean up by
// hand, so it is capped rather than merely clamped to "not negative".
const MAX_TAGS_LIMIT = 10;

function clampTagCount(value: unknown, fallback: number): number {
  const parsed = toNumber(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(MAX_TAGS_LIMIT, Math.max(0, Math.round(parsed)));
}

/**
 * Coerces anything — a missing key, a row written by an older server version,
 * a hand-edited value — into a complete, in-range AiUserSettings. Total by
 * construction, in the style of `normalizeAiSettings` on the client: every
 * field has a defined output for every input, so `getAiUserSettings` never
 * has to special-case a missing or partial row.
 */
export function normalizeAiUserSettings(value: unknown): AiUserSettings {
  const raw = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  return {
    autoClassify: typeof raw.autoClassify === "boolean" ? raw.autoClassify : DEFAULT_AI_USER_SETTINGS.autoClassify,
    autoTaxonomy: typeof raw.autoTaxonomy === "boolean" ? raw.autoTaxonomy : DEFAULT_AI_USER_SETTINGS.autoTaxonomy,
    autoSummarize: typeof raw.autoSummarize === "boolean" ? raw.autoSummarize : DEFAULT_AI_USER_SETTINGS.autoSummarize,
    collectionMinConfidence: clampProbability(raw.collectionMinConfidence, DEFAULT_AI_USER_SETTINGS.collectionMinConfidence),
    tagMinNoul: clampProbability(raw.tagMinNoul, DEFAULT_AI_USER_SETTINGS.tagMinNoul),
    maxTags: clampTagCount(raw.maxTags, DEFAULT_AI_USER_SETTINGS.maxTags),
    taxonomyLanguage: (TAXONOMY_LANGUAGES as string[]).includes(raw.taxonomyLanguage as string)
      ? (raw.taxonomyLanguage as TaxonomyLanguage)
      : DEFAULT_AI_USER_SETTINGS.taxonomyLanguage,
  };
}

/**
 * Structural validation for a PUT body, in the style of `parseClassifyRequest`:
 * a thrown Error becomes a 400. Unlike `normalizeAiUserSettings`, this is
 * strict and partial — every key is optional (a PATCH, not a replacement), but
 * a key that *is* present must be the right type, so a client bug (e.g.
 * sending `maxTags: "three"`) is a 400 rather than a silently-defaulted value
 * the client thinks it set.
 */
export function parseAiUserSettingsPatch(value: unknown): Partial<AiUserSettings> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid settings");
  const record = value as Record<string, unknown>;
  const patch: Partial<AiUserSettings> = {};

  for (const key of ["autoClassify", "autoTaxonomy", "autoSummarize"] as const) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== "boolean") throw new Error(`Invalid ${key}`);
    patch[key] = record[key] as boolean;
  }
  for (const key of ["collectionMinConfidence", "tagMinNoul"] as const) {
    if (record[key] === undefined) continue;
    if (typeof record[key] !== "number" || !Number.isFinite(record[key])) throw new Error(`Invalid ${key}`);
    patch[key] = Math.min(1, Math.max(0, record[key] as number));
  }
  if (record.maxTags !== undefined) {
    if (typeof record.maxTags !== "number" || !Number.isFinite(record.maxTags)) throw new Error("Invalid maxTags");
    patch.maxTags = Math.min(MAX_TAGS_LIMIT, Math.max(0, Math.round(record.maxTags)));
  }
  if (record.taxonomyLanguage !== undefined) {
    if (!(TAXONOMY_LANGUAGES as string[]).includes(record.taxonomyLanguage as string)) {
      throw new Error("Invalid taxonomyLanguage");
    }
    patch.taxonomyLanguage = record.taxonomyLanguage as TaxonomyLanguage;
  }
  return patch;
}

interface SettingsRow {
  data: Record<string, unknown>;
}

/** Defaults when no row exists yet — a brand-new account has never turned
 *  anything on, and that is the safe reading rather than an error. */
export async function getAiUserSettings(pool: Pool, userId: string): Promise<AiUserSettings> {
  const result = await pool.query<SettingsRow>("SELECT data FROM nook_ai_settings WHERE user_id = $1", [userId]);
  return normalizeAiUserSettings(result.rows[0]?.data);
}

/**
 * Applies `patch` and returns the settings row afterward.
 *
 * The upsert merges `patch` onto the stored jsonb with `||` in one statement
 * rather than reading the row, merging in JS and writing it back — the read
 * would open a window between two saves (two Settings tabs, or a save racing
 * `aiIsArmable()`'s own read) in which the second write could clobber the
 * first's field with a stale copy of everything else. `||` is a shallow
 * merge, which is exactly right here: every field is a scalar, so "newer
 * patch wins per key it touches, untouched keys survive" is the whole
 * semantics a settings PATCH needs.
 *
 * `patch` — not a full record — is also what goes in on the INSERT branch, so
 * a first-ever write for an account can leave fields unset; `normalizeAiUserSettings`
 * on the way out is what fills them with the documented defaults, the same as
 * a read of a row that was never written at all.
 */
export async function saveAiUserSettingsPatch(
  pool: Pool,
  userId: string,
  patch: Partial<AiUserSettings>,
): Promise<AiUserSettings> {
  const result = await pool.query<SettingsRow>(
    `INSERT INTO nook_ai_settings (user_id, data)
     VALUES ($1, $2::jsonb)
     ON CONFLICT (user_id) DO UPDATE SET
       data = nook_ai_settings.data || EXCLUDED.data,
       updated_at = now()
     RETURNING data`,
    [userId, JSON.stringify(patch)],
  );
  return normalizeAiUserSettings(result.rows[0].data);
}
