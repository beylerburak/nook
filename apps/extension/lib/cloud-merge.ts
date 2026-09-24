import type { Bookmark, BookmarkList, Media, Quote } from "./types";

// -- canonical JSON -----------------------------------------------------

/**
 * JSON.stringify with object keys sorted recursively at every depth, so two
 * records with identical content but different key order (e.g. round-tripped
 * through Postgres jsonb, which does not preserve insertion order) compare
 * equal. Array order is preserved. Mirrors JSON.stringify's own handling of
 * `undefined`: dropped from object values, turned into `null` inside arrays.
 */
export function canonicalJson(value: unknown): string {
  return encode(value) ?? "null";
}

function encode(value: unknown): string | undefined {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") return undefined;
  if (value === null) return "null";
  const type = typeof value;
  if (type === "string") return JSON.stringify(value);
  if (type === "boolean") return String(value);
  if (type === "number") return Number.isFinite(value as number) ? String(value) : "null";
  if (type === "bigint") throw new TypeError("Do not know how to serialize a BigInt");
  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item) ?? "null").join(",")}]`;
  }
  if (type === "object") {
    const obj = value as Record<string, unknown> & { toJSON?: () => unknown };
    if (typeof obj.toJSON === "function") return encode(obj.toJSON());
    const parts: string[] = [];
    for (const key of Object.keys(obj).sort()) {
      const encoded = encode(obj[key]);
      if (encoded === undefined) continue;
      parts.push(`${JSON.stringify(key)}:${encoded}`);
    }
    return `{${parts.join(",")}}`;
  }
  return undefined;
}

/** canonicalJson equality. */
export function sameRecord(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/** Equality ignoring the top-level `updatedAt` and `urlKey` fields. */
export function sameRecordIgnoringTimestamps(a: unknown, b: unknown): boolean {
  return canonicalJson(withoutTimestamps(a)) === canonicalJson(withoutTimestamps(b));
}

function withoutTimestamps(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { updatedAt, urlKey, ...rest } = value as Record<string, unknown>;
  return rest;
}

// -- recency --------------------------------------------------------------

/**
 * The side with the greater `updatedAt` (ISO strings compare lexically;
 * missing = ""). Ties break on canonicalJson (the greater string wins), so
 * the choice - and every merge built on it - is commutative:
 * mergeBookmarks(a, b) deep-equals mergeBookmarks(b, a).
 */
function pickNewer<T extends { updatedAt?: string }>(a: T, b: T): { newer: T; older: T } {
  const aTime = a.updatedAt ?? "";
  const bTime = b.updatedAt ?? "";
  if (aTime !== bTime) return aTime > bTime ? { newer: a, older: b } : { newer: b, older: a };
  const aJson = canonicalJson(a);
  const bJson = canonicalJson(b);
  return aJson >= bJson ? { newer: a, older: b } : { newer: b, older: a };
}

function isEmptyValue(value: unknown): boolean {
  return value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0);
}

/** Newer's value, unless it's empty (undefined / null / "" / []) - then older's. */
function pickField<T>(newerVal: T, olderVal: T): T {
  return isEmptyValue(newerVal) ? olderVal : newerVal;
}

function earliestNonEmpty(a: unknown, b: unknown): unknown {
  const aOk = typeof a === "string" && a !== "";
  const bOk = typeof b === "string" && b !== "";
  if (aOk && bOk) return (a as string) <= (b as string) ? a : b;
  if (aOk) return a;
  if (bOk) return b;
  return a !== undefined ? a : b;
}

function maxUpdatedAt(a?: string, b?: string): string | undefined {
  return (a ?? "") >= (b ?? "") ? a : b;
}

// -- media ------------------------------------------------------------------

/**
 * Fills `videoUrl` on media items that lack it from the item with the same
 * `url` (poster) on the other side. Mirrors db.ts's mergeTweetContent /
 * preserveVideoUrls: a DOM-parsed save only ever carries a video's poster,
 * never `videoUrl` (only the X API provides the playable MP4) - so merging
 * in a DOM-parsed copy must not wipe a `videoUrl` already attached.
 */
function fillVideoUrls(chosen: unknown, other: unknown): unknown {
  if (!Array.isArray(chosen)) return chosen;
  const otherArr = Array.isArray(other) ? (other as Media[]) : [];
  return chosen.map((item: Media) => {
    if (!item || item.videoUrl || !item.url) return item;
    const match = otherArr.find((candidate) => candidate && candidate.url === item.url && candidate.videoUrl);
    return match ? { ...item, videoUrl: match.videoUrl } : item;
  });
}

function pickMediaField(newerVal: unknown, olderVal: unknown): unknown {
  const chosen = Array.isArray(newerVal) && newerVal.length > 0 ? newerVal : olderVal;
  const other = chosen === newerVal ? olderVal : newerVal;
  return fillVideoUrls(chosen, other);
}

function mergeQuoteField(newerQuote: unknown, olderQuote: unknown): unknown {
  const chosen = pickField(newerQuote, olderQuote);
  if (!chosen || typeof chosen !== "object") return chosen;
  const other = chosen === newerQuote ? olderQuote : newerQuote;
  const quote = chosen as Quote;
  const otherMedia = other && typeof other === "object" ? (other as Quote).media : undefined;
  const filledMedia = fillVideoUrls(quote.media, otherMedia);
  if (filledMedia === quote.media) return quote;
  return { ...quote, media: filledMedia as Media[] };
}

// -- bookmarks ----------------------------------------------------------

const BOOKMARK_SPECIAL_KEYS = new Set([
  "id",
  "note",
  "tags",
  "listId",
  "listName",
  "savedAt",
  "createdAt",
  "updatedAt",
  "deletedAt",
  "media",
  "attachments",
  "quote",
]);

/**
 * Automatic merge for a bookmark present on both sides whose local copy was
 * never synced with this server (e.g. first sign-in on a second browser that
 * independently saved the same X tweets). Field-by-field, favoring the newer
 * side (see pickNewer) but never letting it silently erase data the older
 * side has and the newer side lacks.
 */
export function mergeBookmarks(local: Bookmark, remote: Bookmark): Bookmark {
  const { newer, older } = pickNewer(local, remote);
  const result: Record<string, unknown> = {};

  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    if (BOOKMARK_SPECIAL_KEYS.has(key)) continue;
    result[key] = pickField(newer[key], older[key]);
  }

  result.id = remote.id;

  const newerNote = typeof newer.note === "string" ? newer.note.trim() : "";
  result.note = newerNote !== "" ? newer.note : older.note;

  if (newer.tags !== undefined || older.tags !== undefined) {
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const source of [newer.tags, older.tags]) {
      if (!Array.isArray(source)) continue;
      for (const tag of source) {
        if (typeof tag === "string" && !seen.has(tag)) {
          seen.add(tag);
          tags.push(tag);
        }
      }
    }
    result.tags = tags;
  }

  const listSource = newer.listId !== null && newer.listId !== undefined ? newer : older;
  result.listId = listSource.listId;
  result.listName = listSource.listName;

  result.savedAt = earliestNonEmpty(local.savedAt, remote.savedAt);
  result.createdAt = earliestNonEmpty(local.createdAt, remote.createdAt);
  result.updatedAt = maxUpdatedAt(local.updatedAt, remote.updatedAt);
  result.deletedAt = newer.deletedAt;

  result.media = pickMediaField(newer.media, older.media);
  result.attachments = pickMediaField(newer.attachments, older.attachments);
  result.quote = mergeQuoteField(newer.quote, older.quote);

  return result as unknown as Bookmark;
}

// -- lists ------------------------------------------------------------------

const LIST_SPECIAL_KEYS = new Set(["id", "createdAt", "updatedAt", "deletedAt"]);

export function mergeLists(local: BookmarkList, remote: BookmarkList): BookmarkList {
  const { newer, older } = pickNewer(local, remote);
  const result: Record<string, unknown> = {};

  const keys = new Set([...Object.keys(local), ...Object.keys(remote)]);
  for (const key of keys) {
    if (LIST_SPECIAL_KEYS.has(key)) continue;
    result[key] = pickField(newer[key], older[key]);
  }

  result.id = remote.id;
  result.createdAt = earliestNonEmpty(local.createdAt, remote.createdAt);
  result.updatedAt = maxUpdatedAt(local.updatedAt, remote.updatedAt);
  result.deletedAt = newer.deletedAt;

  return result as unknown as BookmarkList;
}

// -- URL duplicates -----------------------------------------------------

function survivorOrderKey(bookmark: Bookmark): string | undefined {
  for (const value of [bookmark.savedAt, bookmark.createdAt, bookmark.updatedAt]) {
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

// Earliest savedAt (falling back to createdAt, then updatedAt) wins, missing
// sorts last; ties break on id. Deterministic regardless of input order.
function compareForSurvivor(a: Bookmark, b: Bookmark): number {
  const aKey = survivorOrderKey(a);
  const bKey = survivorOrderKey(b);
  if (aKey !== bKey) {
    if (aKey === undefined) return 1;
    if (bKey === undefined) return -1;
    return aKey < bKey ? -1 : 1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Deterministic merge of >= 2 live bookmarks that share a urlKey (the same
 * URL saved on two devices must not stay two bookmarks after sync). Picks
 * one survivor - by earliest save, not by device - and folds only
 * user-entered data from the rest into it, the same way regardless of which
 * device runs it or the order the duplicates are discovered in.
 */
export function planUrlDuplicateMerge(group: Bookmark[]): { survivor: Bookmark; changed: boolean; duplicateIds: string[] } {
  if (group.length < 2) {
    return { survivor: group[0], changed: false, duplicateIds: [] };
  }

  const sorted = [...group].sort(compareForSurvivor);
  const original = sorted[0];
  const rest = sorted.slice(1);
  const candidates = [original, ...rest];

  let note = typeof original.note === "string" && original.note.trim() !== "" ? original.note : undefined;
  if (note === undefined) {
    for (const candidate of rest) {
      if (typeof candidate.note === "string" && candidate.note.trim() !== "") {
        note = candidate.note;
        break;
      }
    }
  }
  if (note === undefined) note = original.note;

  const hasTags = candidates.some((b) => b.tags !== undefined);
  let tags: string[] | undefined = original.tags;
  if (hasTags) {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const candidate of candidates) {
      if (!Array.isArray(candidate.tags)) continue;
      for (const tag of candidate.tags) {
        if (typeof tag === "string" && !seen.has(tag)) {
          seen.add(tag);
          merged.push(tag);
        }
      }
    }
    tags = merged;
  }

  let listSource = original.listId !== null && original.listId !== undefined ? original : undefined;
  if (!listSource) {
    for (const candidate of rest) {
      if (candidate.listId !== null && candidate.listId !== undefined) {
        listSource = candidate;
        break;
      }
    }
  }
  const listId = listSource ? listSource.listId : original.listId;
  const listName = listSource ? listSource.listName : original.listName;

  const survivor: Bookmark = { ...original, note, tags, listId, listName };
  const changed = !sameRecord(survivor, original);
  const duplicateIds = rest.map((b) => b.id).sort();

  return { survivor, changed, duplicateIds };
}
