/**
 * The pure half of AI classification: pick the bookmarks worth asking about,
 * build the request, and turn a decision into the patch to write.
 *
 * Nothing here touches the network, IndexedDB or chrome.* - that is deliberate,
 * not an accident of layering. The parts that decide *whether* something is
 * filed and *what* ends up on a real user's record are the parts that have to be
 * provably safe, so they live somewhere a test can call them directly with no
 * harness. Batching, auth, backoff and the `fetch` live in lib/ai-runner.ts;
 * this file decides nothing about when to run.
 *
 * The wire shapes below are the seam with POST /api/ai/classify - see the
 * Contract section of docs/ai.md.
 */

import type { AiSettings } from "./ai-settings";
import type { AiAttribution, Bookmark } from "./types";

/** One option the model is allowed to pick from. On a tag, `id` is unused on the wire: `tag::<name>` questions are keyed by name. */
export interface AiTaxonomyOption {
  id: string;
  name: string;
  /**
   * Member titles, for a collection. Deliberately NOT sent for a tag: putting a
   * tag's neighbours in its question turned an absolute question into a
   * similarity comparison and halved tag recall (docs/ai-calibration.md).
   */
  samples: string[];
  /**
   * What a tag means — the line the user agreed to when accepting a proposed
   * tag. Sent only for tags, and the only evidence a member-less tag has.
   */
  definition?: string;
}

/** One entry of the accepted tag vocabulary in `ai.taxonomy`. Lives here rather
 *  than in ai-taxonomy.ts because the runner reads it too, and the runner is
 *  imported *by* ai-taxonomy.ts — this is the leaf both share. */
export interface TagVocabularyEntry {
  name: string;
  definition?: string;
}

export interface ClassifyRequest {
  bookmark: { id: string; title?: string; summary?: string; note?: string; site?: string; author?: string };
  collections: AiTaxonomyOption[];
  tags: Array<{ name: string; samples: string[]; definition?: string }>;
  settings: { collectionMinConfidence: number; tagMinNoul: number; maxTags: number };
}

export interface ClassifyResponse {
  model: string;
  collection: {
    assign: boolean;
    /** null when !assign */
    id: string | null;
    name: string | null;
    confidence: number;
    probabilities: Record<string, number>;
  };
  /** Already thresholded and capped by the server. */
  tags: Array<{ name: string; noul: number }>;
  skipped?: "none-fit" | "low-confidence";
  usage?: { inputTokens: number; outputTokens: number };
}

// -- limits ----------------------------------------------------------------

// Jev's state budget is 32k tokens shared by every question in the call, and
// the collections and tags are the part that must not get squeezed out of it. A
// page capture's `shortDescription` is a paragraph and a user's note is a
// sentence or two, so these are generous for the intended input and only bite
// on a pasted wall of text - where the tail of the text is worth exactly as
// much as the collection question it is crowding out.
const MAX_SUMMARY_CHARS = 300;
const MAX_NOTE_CHARS = 500;

/**
 * The `maxTags` DEFAULT_AI_SETTINGS documents, repeated rather than imported:
 * ai-settings.ts pulls in lib/db.ts, and this file's purity is the reason it can
 * be unit-tested with no harness at all. A run using any other budget passes it
 * in explicitly (see applyClassification).
 */
const FALLBACK_MAX_TAGS = 3;

// -- eligibility ------------------------------------------------------------

/**
 * The whole safety story of this feature, in one line:
 *
 *   b.ai == null && b.listId == null
 *
 * `listId == null` is why AI never overwrites you. A bookmark that is in a
 * collection is in it because a human put it there, and the model is never even
 * asked about it - so however badly calibrated a threshold turns out to be, it
 * can't demote your own filing, because the question is never put.
 *
 * `ai == null` is the once-only guard: a record the model has already ruled on
 * is never offered again. A pass that acted leaves `ai` behind. A pass that
 * deliberately did nothing ("nothing fit", or every answer under the threshold)
 * leaves nothing to write at all, so that case is covered by the runner's
 * processed-id cursor - there is no field on the record that could carry "we
 * already said no".
 */
export function bookmarkNeedsClassification(bookmark: Bookmark): boolean {
  return bookmark.ai == null && bookmark.listId == null;
}

// -- candidates -------------------------------------------------------------

/** savedAt is the user's "when I saved this"; createdAt/updatedAt only fill in for records that have no savedAt. */
function recencyKey(bookmark: Bookmark): string | undefined {
  for (const value of [bookmark.savedAt, bookmark.createdAt, bookmark.updatedAt]) {
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function compareNewestFirst(a: Bookmark, b: Bookmark): number {
  const aKey = recencyKey(a);
  const bKey = recencyKey(b);
  if (aKey !== bKey) {
    // A record with no timestamps at all sorts last instead of throwing or
    // being treated as infinitely old.
    if (aKey === undefined) return 1;
    if (bKey === undefined) return -1;
    return aKey < bKey ? 1 : -1;
  }
  // Deterministic batch composition: the same library always yields the same
  // `limit` candidates, so a re-run can't quietly re-order the queue.
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * The unfiled, never-classified bookmarks worth spending a request on, newest
 * first, capped at `limit`. Newest first because classification is a background
 * pass over what the user is doing *now*: a bookmark from last month is exactly
 * as classifiable tomorrow, and a backlog that only ever clears from the old end
 * starves the recent saves the user is actually looking at.
 *
 * Soft-deleted records are filtered here rather than at the DB read so a caller
 * that already has the list in hand (e.g. right after a sync batch) still can't
 * file something the user threw away.
 */
export function selectCandidates(bookmarks: Bookmark[], limit: number): Bookmark[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const candidates = bookmarks.filter(
    (bookmark) => bookmark != null && !bookmark.deletedAt && bookmarkNeedsClassification(bookmark)
  );
  return candidates.sort(compareNewestFirst).slice(0, Math.floor(limit));
}

// -- request ----------------------------------------------------------------

/** The host, never the URL: a query string can carry a session token, and all the model needs to know is which site this is. */
function hostFromUrl(url: unknown): string | undefined {
  if (typeof url !== "string" || url.trim() === "") return undefined;
  try {
    return new URL(url).hostname || undefined;
  } catch {
    return undefined;
  }
}

function trimmed(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}

function truncated(value: string | undefined, maxChars: number): string | undefined {
  if (value === undefined || value.length <= maxChars) return value;
  return `${value.slice(0, maxChars).trimEnd()}…`;
}

/**
 * The per-bookmark `state` for the model. Filtered rather than complete on
 * purpose: the full `description` is never sent (a page's whole body is mostly
 * boilerplate, and it is the field most likely to hold something the user would
 * not want pasted into a request), and neither is the full URL.
 *
 * `collections` and `tags` arrive already sorted, capped and built by the
 * caller - this function deliberately selects nothing, so what goes into a
 * request is always exactly what the runner decided to send.
 */
export function toClassifyRequest(
  bookmark: Bookmark,
  collections: AiTaxonomyOption[],
  tags: AiTaxonomyOption[],
  settings: AiSettings,
): ClassifyRequest {
  const creator = bookmark.creator;
  const payload: ClassifyRequest["bookmark"] = { id: bookmark.id };
  // Assigned conditionally rather than as `title: undefined`, so a field with
  // nothing in it is absent from the serialized body too.
  const title = trimmed(bookmark.title);
  if (title !== undefined) payload.title = title;
  const summary = truncated(trimmed(bookmark.shortDescription), MAX_SUMMARY_CHARS);
  if (summary !== undefined) payload.summary = summary;
  const note = truncated(trimmed(bookmark.note), MAX_NOTE_CHARS);
  if (note !== undefined) payload.note = note;
  const site = hostFromUrl(bookmark.url);
  if (site !== undefined) payload.site = site;
  const author = trimmed(creator?.handle) ?? trimmed(creator?.name);
  if (author !== undefined) payload.author = author;

  return {
    bookmark: payload,
    collections,
    // A tag's `samples` are omitted on the wire rather than sent as an empty
    // array: the server must not be able to mistake an absent digest for a
    // reason to build one.
    tags: tags.map((tag) => ({
      name: tag.name,
      samples: [],
      ...(tag.definition ? { definition: tag.definition } : {}),
    })),
    settings: {
      collectionMinConfidence: settings.collectionMinConfidence,
      tagMinNoul: settings.tagMinNoul,
      maxTags: settings.maxTags,
    },
  };
}

// -- response ---------------------------------------------------------------

/**
 * A tag as the model and the user agree to spell it: trimmed, one leading `#`
 * stripped, lowercased. This is the same function as the server's
 * `normalizeTagName` in apps/api/src/ai.ts and the two have to stay identical
 * — the `Noul` was computed over the *normalized* name, so storing the raw
 * response name would file a tag the next run's vocabulary doesn't contain, and
 * it would go on being re-suggested, every run, as a near-duplicate of a tag
 * already on the record.
 */
/**
 * Folds a name for comparison: strip a leading `#`, collapse, and lowercase.
 *
 * The lowercasing is Turkish-aware, and it has to be. `toLowerCase()` maps "İ"
 * to "i" *plus a combining dot above*, so a proposed tag "İş Akışları" was stored
 * as "i̇ş akışları" — a string with an invisible character in it that will never
 * match what the user types, and that silently defeats every dedupe and every
 * `stem` comparison downstream. The same run also produced "i̇lham" and "eğitim
 * i̇çeriği".
 *
 * `toLocaleLowerCase("tr")` fixes that but breaks English: it maps "AI" to
 * "aı". So the locale is chosen by looking for a Turkish-specific letter, which
 * makes it idempotent in both directions — "ÇAĞRI" and "çağrı" both land on
 * "çağrı", rather than on "çağri" and "çağrı" respectively, which never match
 * each other. Every other language is unaffected, because the default path is
 * plain `toLowerCase()`.
 *
 * MUST stay identical to `normalizeTagName` in apps/api/src/ai.ts: the server
 * normalises what it returns and the client normalises what it looks up, and a
 * disagreement writes tags the library cannot find again.
 */
export function normalizeTagName(raw: string): string {
  const text = trimmed(raw) ?? "";
  const withoutHash = text.startsWith("#") ? text.slice(1) : text;
  return foldCase(withoutHash.trim());
}

/** Any letter that marks a word as Turkish. Note the absence of "i" and "I":
 *  they are the whole problem — see the note above. */
const TURKISH_LETTER = /[ıİğĞşŞçÇöÖüÜ]/;

/**
 * Lowercases one word in the locale that word is written in.
 *
 * Per word, not per string, and that is the part that matters. A single string
 * in this library mixes both: "UI Tasarımları" is an English initialism next to
 * a Turkish noun. Under the Turkish locale "UI" becomes "uı"; under the default
 * locale "Tasarımları" becomes "tasarımlar" is fine but "İş" becomes "i̇ş" with
 * a combining dot. Folding word by word gets both right.
 */
function foldWord(word: string): string {
  return TURKISH_LETTER.test(word) ? word.toLocaleLowerCase("tr") : word.toLowerCase();
}

/** Exported so `apps/api/src/ai.ts` can be checked against it, and so the tag
 *  stem comparison in ai-taxonomy.ts folds the same way. */
export function foldCase(value: string): string {
  return value.split(" ").map(foldWord).join(" ");
}

function resolveCollectionName(
  id: string,
  response: ClassifyResponse,
  known: Map<string, string> | Record<string, string>
): string {
  const local = known instanceof Map ? known.get(id) : known?.[id];
  // A local collection is authoritative for its own name: the model echoes the
  // name we sent, which may have been renamed on this device since the options
  // were built. The id is the last resort - a listId with no name renders as an
  // empty chip, and losing the assignment is worse than an ugly name.
  return trimmed(local) ?? trimmed(response.collection?.name) ?? id;
}

function maxTagBudget(maxTags: number | undefined): number {
  if (typeof maxTags !== "number" || !Number.isFinite(maxTags)) return FALLBACK_MAX_TAGS;
  return Math.max(0, Math.floor(maxTags));
}

/** The response tags this call will actually add: normalized, not already on the record, capped by an already-validated budget. */
function newTags(
  existing: string[],
  response: ClassifyResponse,
  budget: number
): Array<{ name: string; noul: number }> {
  // Compared normalized, so a response tag differing only in case from one the
  // user already typed is a duplicate - and the user's spelling is what stays.
  const seen = new Set(existing.map((tag) => normalizeTagName(tag)));
  const added: Array<{ name: string; noul: number }> = [];
  for (const tag of Array.isArray(response.tags) ? response.tags : []) {
    const name = normalizeTagName(tag?.name);
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    added.push({ name, noul: tag.noul });
  }
  return added.slice(0, budget);
}

/**
 * The patch to write, or null when the decision is "leave it alone" - no
 * collection assigned and no new tag, which is the outcome for anything the
 * model wasn't confident enough about. null (rather than an empty patch) lets
 * the runner skip the write entirely: no `updatedAt` bump, no sync echo,
 * nothing for another device to reconcile.
 *
 * `listId` and `listName` are always written together or not at all: a bookmark
 * pointing at a list it can't name renders as an empty chip, and the pair is
 * what the UI and the merge layer each treat as one assignment.
 *
 * Tags are MERGED, never replaced - and the cap bounds what the model
 * contributes, not the merged total. Replacing would delete tags the user typed.
 * Capping the total would delete them too, for anyone who already had more than
 * `maxTags` of their own; and the sync layer already union-merges `tags` across
 * devices, so a client that removes tags here is fighting a merge that will only
 * put them back. The server has already applied the same cap to the same set,
 * so re-applying it here changes nothing except the case where the two disagree.
 *
 * `taxonomyAt` is left to the caller: it dates the accepted taxonomy
 * (meta["ai.taxonomy"]), not this decision, and the model never returns it.
 * Stamping the current time here would claim the taxonomy had just been
 * re-accepted on every single classification.
 *
 * `maxTags` is the budget for the automated half. It is a parameter rather than
 * a module constant because the response carries no settings of its own, and a
 * call that omits it gets the documented default rather than "unlimited".
 */
export function applyClassification(
  bookmark: Bookmark,
  response: ClassifyResponse,
  collectionNameById: Map<string, string> | Record<string, string>,
  maxTags?: number
): Partial<Bookmark> | null {
  // `assign === false` is the model declining to file, so a stray id in that
  // response is not an assignment: honouring it would be doing exactly what the
  // model said not to do. A flag with no id can't be written either.
  const assignedId = response.collection?.assign === true ? trimmed(response.collection?.id) : undefined;
  const existing = Array.isArray(bookmark.tags) ? bookmark.tags : [];
  const added = newTags(existing, response, maxTagBudget(maxTags));

  if (!assignedId && added.length === 0) return null;

  const patch: Partial<Bookmark> = {};
  if (assignedId) {
    patch.listId = assignedId;
    patch.listName = resolveCollectionName(assignedId, response, collectionNameById);
  }
  if (added.length > 0) patch.tags = [...existing, ...added.map((tag) => tag.name)];
  patch.ai = attribution(response, assignedId !== undefined, added);
  return patch;
}

/** Only the fields describing a decision that actually happened: a confidence for an assignment that was never made is the stale claim docs/ai.md's merge rules exist to prevent. */
function attribution(
  response: ClassifyResponse,
  assigns: boolean,
  added: Array<{ name: string; noul: number }>
): AiAttribution {
  const result: AiAttribution = { model: response.model, at: new Date().toISOString() };
  if (assigns) result.collectionConfidence = response.collection?.confidence;
  if (added.length > 0) {
    result.tagConfidence = {};
    for (const tag of added) result.tagConfidence[tag.name] = tag.noul;
  }
  return result;
}
