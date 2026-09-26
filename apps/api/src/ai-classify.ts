/**
 * The pure half of AI classification: pick the bookmarks worth asking about,
 * build the request, and turn a decision into the patch to write.
 *
 * This logic was apps/extension/lib/ai-classify.ts, running in the extension's
 * service worker, and moved here as part of the cloud-runner migration
 * (docs/ai-cloud-contract.md). Not one decision changed on the way, because none
 * of them depended on where it ran: the fields `toClassifyRequest` reads are
 * exactly the ones `POST /api/sync` has always carried, so the server builds the
 * same request out of `nook_records` with nothing re-sent at save time. What did
 * change is the boundary it reads from — a row's `data` jsonb rather than a
 * typed `Bookmark` — which is what `toClassifiable` is for.
 *
 * Nothing here touches the network, the database, or the clock it does not
 * inject — and that is deliberate, not an accident of layering. The parts that
 * decide *whether* something is filed and *what* ends up on a real user's record
 * are the parts that have to be provably safe, so they live somewhere a test
 * can call them directly with no harness, no `pg` pool and no `fetch`. Batching,
 * the queue, the backoff and the writes are the worker's; this file decides
 * nothing about when to run.
 *
 * The wire shapes below are the seam with POST /api/ai/classify — see the
 * Contract section of docs/ai.md.
 */

// -- types ----------------------------------------------------------------

/**
 * A synced bookmark, in the shape the decision logic needs it.
 *
 * Structural rather than imported, and structural on purpose: `Bookmark` lives
 * in apps/extension/lib/types.ts and this module has to load in a plain Node
 * test with nothing else in the graph. The row it describes is `nook_records`,
 * so every field is optional except `id`, and every field is exactly what some
 * function below reads — no more.
 *
 * There is deliberately no `description`. The request filter never sends it (a
 * page's whole body is mostly boilerplate, and it is the field most likely to
 * hold something the user would not want pasted into a request), and leaving it
 * off the type means no caller can reach for it by accident.
 */
export interface ClassifiableBookmark {
  id: string;
  title?: string;
  shortDescription?: string;
  note?: string;
  url?: string;
  tags?: string[];
  listId?: string | null;
  listName?: string | null;
  /**
   * The attribution, when the model has already ruled on this record. `unknown`
   * because only `bookmarkNeedsClassification` reads it and it reads one thing
   * about it — that it is absent.
   */
  ai?: unknown;
  deletedAt?: string | null;
  savedAt?: string;
  createdAt?: string;
  updatedAt?: string;
  creator?: { handle?: string; name?: string };
}

/** A synced collection: the collision check reads its `name`, and a planned row
 *  carries the acceptance stamps. */
export interface ClassifiableList {
  id: string;
  name?: string;
  deletedAt?: string | null;
  /**
   * The acceptance stamps. `planLists` writes them from the one instant the
   * acceptance is dated with, so a list and the taxonomy entry that describes
   * it can never disagree about when they were created.
   */
  createdAt?: string;
  updatedAt?: string;
}

/** One option the model is allowed to pick from. On a tag, `id` is unused on the
 *  wire: `tag::<name>` questions are keyed by name. */
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

/** One entry of the accepted tag vocabulary in `nook_ai_taxonomy`. Lives here
 *  rather than in ai-taxonomy.ts because both modules need it and this one is the
 *  leaf — ai-taxonomy.ts imports it. */
export interface TagVocabularyEntry {
  name: string;
  definition?: string;
}

/**
 * The classify request, restated from `./ai.ts`, where the route's own copy
 * lives. Duplicated for the same reason every other wire type in this repo is:
 * `./ai.ts` is the transport half and this file is the decision half, and
 * docs/ai.md's Contract — not a shared import — is what makes the two agree.
 * Must not drift from `ClassifyRequest` in ./ai.ts.
 */
export interface ClassifyRequest {
  bookmark: { id: string; title?: string; summary?: string; note?: string; site?: string; author?: string };
  collections: AiTaxonomyOption[];
  tags: Array<{ name: string; samples: string[]; definition?: string }>;
  settings: { collectionMinConfidence: number; tagMinNoul: number; maxTags: number };
}

/** The decision, restated from `./ai.ts` for the same reason. Must not drift. */
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

/**
 * Jev's state budget is 32k tokens shared by every question in the call, and
 * the collections and tags are the part that must not get squeezed out of it. A
 * page capture's `shortDescription` is a paragraph and a user's note is a
 * sentence or two, so these are generous for the intended input and only bite
 * on a pasted wall of text — where the tail of the text is worth exactly as much
 * as the collection question it is crowding out.
 *
 * Exported so a caller that has to reason about the request budget reads these
 * numbers rather than restating them, and so a test pins the truncated length
 * against the constant instead of a literal.
 */
export const MAX_SUMMARY_CHARS = 300;
export const MAX_NOTE_CHARS = 500;

/**
 * The `maxTags` default, repeated rather than imported: `DEFAULT_MAX_TAGS`
 * lives in ./ai.ts, and that module owns the `fetch` plumbing and reads
 * `process.env` at the top level. This file's entire claim is that it has no
 * such dependency, so one integer is not worth the import graph. It mirrors
 * `DEFAULT_MAX_TAGS` in ./ai.ts and `DEFAULT_AI_USER_SETTINGS` in
 * ai-settings.ts, and a pass using any other budget passes it in explicitly
 * (see applyClassification).
 */
const FALLBACK_MAX_TAGS = 3;

// -- reading a row ---------------------------------------------------------

/**
 * A `nook_records.data` jsonb read as a bookmark.
 *
 * Tolerant, because this value is whatever a client last sent: it was authored
 * by a browser extension through a sync request, validated for shape but not for
 * meaning, and the record may be years old. So each field is taken only if it is
 * the type it is supposed to be — `tags` only if it is an array, `listId` only
 * if it is a string or explicitly null, `creator` only if it is an object, every
 * string only if it is a string — and anything else is dropped rather than
 * coerced. Coercing would be the dangerous direction: a `tags` string would
 * become a tag whose name is `"a,b,c"`, and a `creator` that arrived as the
 * string "nobody" would become an author called "nobody".
 *
 * The row's own `id` column is authoritative for identity; `data.id` is the
 * client's copy of it. A record where the two disagree is a sync bug this reader
 * cannot repair, so it passes the client's copy through rather than inventing
 * one, and leaves the caller's own id checks to notice.
 */
export function toClassifiable(data: Record<string, unknown>): ClassifiableBookmark {
  const source = data ?? {};
  const bookmark: ClassifiableBookmark = { id: typeof source.id === "string" ? source.id : "" };
  for (const field of ["title", "shortDescription", "note", "url", "savedAt", "createdAt", "updatedAt"] as const) {
    const value = source[field];
    if (typeof value === "string") bookmark[field] = value;
  }
  for (const field of ["listId", "listName", "deletedAt"] as const) {
    const value = source[field];
    // Explicit null is meaningful and kept: `listId: null` is a cleared
    // assignment, which is not the same as an absent field to anything reading
    // the record, and `deletedAt: null` is what a live row carries.
    if (typeof value === "string" || value === null) bookmark[field] = value;
  }
  if (Array.isArray(source.tags)) bookmark.tags = source.tags as string[];
  if (source.creator && typeof source.creator === "object" && !Array.isArray(source.creator)) {
    const creator = source.creator as Record<string, unknown>;
    const read: { handle?: string; name?: string } = {};
    if (typeof creator.handle === "string") read.handle = creator.handle;
    if (typeof creator.name === "string") read.name = creator.name;
    bookmark.creator = read;
  }
  // `ai` is passed through untouched and unexamined: the only thing read about it
  // is whether it is there, and re-validating a receipt would risk dropping one
  // and making a decided record eligible for a second charge.
  if (source.ai !== undefined) bookmark.ai = source.ai;
  return bookmark;
}

// -- eligibility ------------------------------------------------------------

/**
 * The whole safety story of this feature, in one line:
 *
 *   b.ai == null && b.listId == null
 *
 * `listId == null` is why AI never overwrites you. A bookmark that is in a
 * collection is in it because a human put it there, and the model is never even
 * asked about it — so however badly calibrated a threshold turns out to be, it
 * can't demote your own filing, because the question is never put. The write path
 * re-checks this on the fresh row for the same reason: a human who filed the
 * bookmark while the request was in flight wins.
 *
 * `ai == null` is the once-only guard: a record the model has already ruled on
 * is never offered again. A pass that acted leaves `ai` behind. A pass that
 * deliberately did nothing ("nothing fit", or every answer under the threshold)
 * leaves nothing to write at all, so that case is covered by the pass's
 * processed-id cursor — there is no field on the record that could carry "we
 * already said no".
 *
 * The comparisons are loose on purpose. `ai` arrives out of jsonb as
 * present-but-null for most of the library, and `listId: null` is a real value
 * (a cleared assignment); `== null` catches both, while `=== undefined` would
 * read every null as "already classified" and classify nothing at all.
 */
export function bookmarkNeedsClassification(bookmark: ClassifiableBookmark): boolean {
  return bookmark.ai == null && bookmark.listId == null;
}

// -- candidates -------------------------------------------------------------

/** savedAt is the user's "when I saved this"; createdAt/updatedAt only fill in for records that have no savedAt. */
function recencyKey(bookmark: ClassifiableBookmark): string | undefined {
  for (const value of [bookmark.savedAt, bookmark.createdAt, bookmark.updatedAt]) {
    if (typeof value === "string" && value !== "") return value;
  }
  return undefined;
}

function compareNewestFirst(a: ClassifiableBookmark, b: ClassifiableBookmark): number {
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
 * Soft-deleted records are filtered here rather than at the query, so a caller
 * that already has the list in hand (a top-up that just claimed rows it had not
 * loaded yet) still can't file something the user threw away. `nook_records`
 * carries the tombstone in two places — the `deleted_at` column, which sync and
 * the reconciler write, and `data.deletedAt`, which the client sends — so a caller
 * selecting rows by hand has to hand this function whichever one it read;
 * `IndexableRecord` in ./embeddings.ts exists for the same two-place problem.
 */
export function selectCandidates(bookmarks: ClassifiableBookmark[], limit: number): ClassifiableBookmark[] {
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
 * purpose: the full `description` is never sent, and neither is the full URL.
 *
 * `collections` and `tags` arrive already sorted, capped and built by the
 * caller — this function deliberately selects nothing, so what goes into a
 * request is always exactly what the worker decided to send.
 */
export function toClassifyRequest(
  bookmark: ClassifiableBookmark,
  collections: AiTaxonomyOption[],
  tags: AiTaxonomyOption[],
  settings: { collectionMinConfidence: number; tagMinNoul: number; maxTags: number },
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
 * `normalizeTagName` in ./ai.ts and the two have to stay identical — the `Noul`
 * was computed over the *normalized* name, so storing the raw response name would
 * file a tag the next run's vocabulary doesn't contain, and it would go on being
 * re-suggested, every run, as a near-duplicate of a tag already on the record.
 *
 * It is also what the client's own tag view folds with
 * (apps/extension/src/app/dashboard/bookmark-utils.ts, getTags), which is the
 * other half of why the spelling has to be the agreed one.
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
 * MUST stay identical to `normalizeTagName` in ./ai.ts: that copy normalises the
 * names the classify route returns and this one normalises the names written onto
 * the record, so a disagreement between them writes tags the library can never
 * find again.
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

/** Exported so `./ai.ts`'s copy can be checked against it, and so the tag stem
 *  comparison in ai-taxonomy.ts folds the same way. */
export function foldCase(value: string): string {
  return value.split(" ").map(foldWord).join(" ");
}

function resolveCollectionName(
  id: string,
  response: ClassifyResponse,
  known: Map<string, string> | Record<string, string>,
): string {
  const local = known instanceof Map ? known.get(id) : known?.[id];
  // The local collection is authoritative for its own name: the model echoes the
  // name we sent, which may have been renamed since the options were built. The
  // id is the last resort — a listId with no name renders as an empty chip, and
  // losing the assignment is worse than an ugly name.
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
  budget: number,
): Array<{ name: string; noul: number }> {
  // Compared normalized, so a response tag differing only in case from one the
  // user already typed is a duplicate — and the user's spelling is what stays.
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
 * The patch to write, or null when the decision is "leave it alone" — no
 * collection assigned and no new tag, which is the outcome for anything the
 * model wasn't confident enough about. null (rather than an empty patch) lets the
 * worker skip the write entirely: no `updatedAt` bump, no `nextval` on the sync
 * sequence, no version for every other device to pull.
 *
 * `listId` and `listName` are always written together or not at all: a bookmark
 * pointing at a list it can't name renders as an empty chip, and the pair is
 * what the UI and the merge layer each treat as one assignment.
 *
 * Tags are MERGED, never replaced — and the cap bounds what the model
 * contributes, not the merged total. Replacing would delete tags the user typed.
 * Capping the total would delete them too, for anyone who already had more than
 * `maxTags` of their own; and the sync layer already union-merges `tags` across
 * devices, so a client that removes tags here is fighting a merge that will only
 * put them back. The classify route has already applied the same cap to the same
 * set, so re-applying it here changes nothing except the case where the two
 * disagree.
 *
 * `taxonomyAt` is left to the caller: it dates the accepted taxonomy
 * (`nook_ai_taxonomy`), not this decision, and the model never returns it.
 * Stamping the current time here would claim the taxonomy had just been
 * re-accepted on every single classification.
 *
 * `maxTags` is the budget for the automated half. It is a parameter rather than
 * a module constant because the response carries no settings of its own, and a
 * call that omits it gets the documented default rather than "unlimited".
 *
 * `at` is the ISO stamp for `ai.at`, defaulting to now and injected so that one
 * pass can date every decision it makes in the same instant, and so a test never
 * has to read a clock.
 */
export function applyClassification(
  bookmark: ClassifiableBookmark,
  response: ClassifyResponse,
  collectionNameById: Map<string, string> | Record<string, string>,
  maxTags?: number,
  at: string = new Date().toISOString(),
): Partial<ClassifiableBookmark> | null {
  // `assign === false` is the model declining to file, so a stray id in that
  // response is not an assignment: honouring it would be doing exactly what the
  // model said not to do. A flag with no id can't be written either.
  const assignedId = response.collection?.assign === true ? trimmed(response.collection?.id) : undefined;
  const existing = Array.isArray(bookmark.tags) ? bookmark.tags : [];
  const added = newTags(existing, response, maxTagBudget(maxTags));

  if (!assignedId && added.length === 0) return null;

  const patch: Partial<ClassifiableBookmark> = {};
  if (assignedId) {
    patch.listId = assignedId;
    patch.listName = resolveCollectionName(assignedId, response, collectionNameById);
  }
  if (added.length > 0) patch.tags = [...existing, ...added.map((tag) => tag.name)];
  patch.ai = attribution(response, assignedId !== undefined, added, at);
  return patch;
}

/**
 * The receipt written onto `ai`: which model decided, when, and with what
 * confidence — but only for the parts of the decision that actually happened.
 *
 * `Record<string, unknown>` rather than a named type, and the omission of the
 * absent fields is the point. `mergeBookmarks` takes attribution from the same
 * side it took the assignment from, or drops it (docs/ai.md, "Merge semantics"),
 * and a stale `collectionConfidence` for an assignment that no longer exists is
 * exactly the claim those rules exist to prevent. So a decision that filed
 * nothing records nothing, and a confidence stored for later re-thresholding is
 * not stored at all: every `probabilities` value comes back rounded to two
 * decimals, which cannot support one.
 */
export function attribution(
  response: ClassifyResponse,
  assigns: boolean,
  added: Array<{ name: string; noul: number }>,
  at: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { model: response.model, at };
  if (assigns) result.collectionConfidence = response.collection?.confidence;
  if (added.length > 0) {
    const tagConfidence: Record<string, number> = {};
    for (const tag of added) tagConfidence[tag.name] = tag.noul;
    result.tagConfidence = tagConfidence;
  }
  return result;
}

/**
 * Adds the accepted-taxonomy date to the attribution. `applyClassification`
 * leaves it out on purpose (it dates the taxonomy in force, not the decision, and
 * the model never returns it), so this is the worker's half of that handoff.
 * Omitted entirely when no accepted taxonomy is on record, rather than guessed
 * at — a made-up date would claim a taxonomy was accepted in 1970. A stored
 * `AcceptedTaxonomy.acceptedAt` is `string | null`, so an account that has never
 * accepted one arrives here as no argument at all.
 */
export function withTaxonomyAt(
  patch: Partial<ClassifiableBookmark>,
  acceptedAt: string | undefined,
): Partial<ClassifiableBookmark> {
  const receipt = patch.ai;
  if (!acceptedAt || !receipt) return patch;
  return { ...patch, ai: { ...(receipt as Record<string, unknown>), taxonomyAt: acceptedAt } };
}

/**
 * True when a patch would change nothing that is already on the record. Every
 * write stamps `updatedAt` and takes a version, so re-stating the current listId
 * or tags would push a no-op record through sync and resurface the bookmark as
 * freshly updated in the dashboard.
 *
 * Arrays are compared element-wise rather than by identity, because a patch that
 * merges tags always builds a new array: the merged list is equal to what is
 * already stored, and only that comparison can see it.
 *
 * Both sides are read through a `Record` view because which fields are compared
 * is not known until the patch is: the decision may write `listId`, `listName`,
 * `tags` and `ai`, and only the keys it actually wrote are worth a write.
 */
export function patchChangesSomething(
  bookmark: ClassifiableBookmark,
  patch: Partial<ClassifiableBookmark>,
): boolean {
  const current = bookmark as unknown as Record<string, unknown>;
  return Object.keys(patch).some((key) => {
    const next = (patch as Record<string, unknown>)[key];
    const before = current[key];
    if (Array.isArray(next) && Array.isArray(before)) {
      return next.length !== before.length || next.some((value, index) => !Object.is(value, before[index]));
    }
    return !Object.is(next, before);
  });
}
