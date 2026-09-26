/**
 * Taxonomy growth: sample the library, decide which of the proposer's names
 * survive review, and build the accepted-taxonomy record the classifier reads.
 * See docs/ai.md, "Taxonomy growth", and docs/ai-cloud-contract.md for the routes
 * around it.
 *
 * This was apps/extension/lib/ai-taxonomy.ts, split along the same line the
 * extension already drew: the pure half moved here, and the impure half — the
 * `fetch` to the proposer and the writes that create the collections — belongs to
 * the routes in ./server.ts. What is left is a set of functions a test can call
 * directly, with no harness, no `fetch` and no `pg` pool in the graph, which is why
 * nothing in this file is allowed to grow a dependency on where the data lives.
 *
 * -- why this feature needs a generative model, and nothing else does --
 *
 * Jev is not an LLM. It evaluates a `state` against typed questions we hand it
 * and answers with calibrated probabilities, so the only names it can ever
 * return are the option *keys* we defined. That is a feature, not a limit, for
 * classification: the options are the user's own collections and tags, each
 * carrying its actual member titles as criteria, and "which of these" is
 * exactly the question the model is reliable on. It is disqualifying here.
 * Inventing a category name is not a choice among options we supplied — there is
 * no closed set to choose from, and a `Choice` with a fabricated option key would
 * be the model echoing our invention back at us. So the naming is a text LLM
 * (`NOOK_AI_PROPOSER`, behind `proposeTaxonomy()` in ./ai.ts), it handles a
 * handful of calls a year, and everything around it — the sample, the
 * collisions, the overlap, the writes — is code we own.
 *
 * The record this builds is read back by the classification worker, which only
 * ever consumes it: each option's `samples` are the member titles that become the
 * `Choice` criteria. It used to be a per-origin IndexedDB meta key, which is why
 * a taxonomy accepted on the web could never reach the extension's runner; it is
 * a row of `nook_ai_taxonomy` now, which is also why the impure half no longer
 * has to read it back through a device store.
 */

import {
  bookmarkNeedsClassification,
  foldCase,
  normalizeTagName,
  type AiTaxonomyOption,
  type ClassifiableBookmark,
  type ClassifiableList,
  type TagVocabularyEntry,
} from "./ai-classify.js";

// -- limits ----------------------------------------------------------------

/**
 * Unfiled bookmarks sent to the proposer, and the doc's number. It is also the
 * route's hard cap: `parseProposeTaxonomyRequest` stops at MAX_SAMPLE_ITEMS (200)
 * and drops the rest, so asking for more would look like it worked.
 */
export const TAXONOMY_SAMPLE_SIZE = 200;

/** `ProposeTaxonomyRequest`'s own defaults, sent explicitly so the request
 *  says what it wanted instead of inheriting whatever a default becomes. */
export const PROPOSAL_MAX_COLLECTIONS = 8;
export const PROPOSAL_MAX_TAGS = 20;

/**
 * Ceiling on the stored vocabulary.
 *
 * It matches the 20 tag questions a single classification asks about, on
 * purpose. An earlier version capped it at 12 to "leave room for the library's
 * own tags", which was wrong on two counts: the tag options are already built
 * with the library's real tags first and then sliced, so they are never crowded
 * out, and 12 meant that ticking 13 of the 20 tags the proposer offered silently
 * discarded one — with nothing in the review list saying so. Nothing ticked
 * should vanish at acceptance.
 */
export const MAX_TAXONOMY_TAGS = 20;

/**
 * `MIN_CLASSIFIABLE_CHARS` in ./ai.ts, on purpose. That floor is a cost guard the
 * classification route applies to one bookmark; here it guards the sample, and
 * for the same reason: after the state filter a media-only bookmark is a bare
 * emoji or an author's handle, and 39 of a real 1,061-item library fall under the
 * floor (docs/ai-calibration.md). Spending the proposal on those teaches the
 * proposer nothing but noise, and it is the one thing in this file that could
 * quietly poison every name it returns. The constant is module-private over
 * there, so it is repeated rather than exported for one reader.
 */
const MIN_SAMPLE_CHARS = 40;

/**
 * Member titles carried per collection option. Exported because the worker trims
 * each option's samples to this many on every read, and two copies of a number
 * that has to agree is how a digest silently goes missing.
 */
export const MAX_OPTION_SAMPLES = 5;

/** `MAX_TITLE_CHARS` in ./ai.ts: a sample title is a label, not a body of text. */
const MAX_TITLE_CHARS = 300;

/** Terms shorter than this carry no signal — mostly the "ve"/"of"/"de" noise a
 *  collection name picks up from ordinary prose. Length, not a stopword list:
 *  a stopword list would have to be written in the library's language. */
const MIN_TERM_CHARS = 3;

// -- public types -----------------------------------------------------------

/** One collection the proposer invented, with the one-line reason it gave. */
export interface TaxonomyProposal {
  name: string;
  why: string;
}

/**
 * A proposed tag. `why` becomes the tag's definition once accepted, and is shown
 * in the review list beside the name. `coveredBy` is the set of collections in
 * the *same* response whose vocabulary already speaks for it.
 */
export interface TagProposal {
  name: string;
  why?: string;
  coveredBy?: string[];
}

/**
 * The record written to `nook_ai_taxonomy` and read back by the classification
 * worker. Exact shape, because that is the seam between the two: an object (not a
 * bare array) carrying `collections`, each entry a `{ id, name, samples }` option,
 * plus `tags` — a flat vocabulary of names that have no members yet — plus the
 * ISO date the worker stamps onto every attribution as `ai.taxonomyAt`.
 *
 * `acceptedAt` is `string | null` where the extension wrote `string` and read
 * `string | undefined`: the server normalises once, at the boundary, because
 * "never accepted" and "accepted at an unreadable date" are the same answer and
 * neither should be guessed at. docs/ai-cloud-contract.md makes `null` the wire
 * shape.
 */
export interface AcceptedTaxonomy {
  /** ISO of the last acceptance, or null when there has never been one. */
  acceptedAt: string | null;
  collections: AiTaxonomyOption[];
  /**
   * Accepted tag names that no bookmark carries yet.
   *
   * They exist so a brand-new tag can be *offered* to the model as a `Noul` and
   * earn its first member the ordinary way. Without this, a proposed tag is
   * inert: the tag questions are built from the tags bookmarks already have, so
   * a tag with no members can never be proposed by any code that exists. Once one
   * bookmark takes it, it is a real tag and this entry is redundant.
   *
   * Verified against the live service on a 200-bookmark sample of the real
   * library: a vocabulary with **zero** members put "yazılım geliştirme" on 20 of
   * 60 bookmarks, "kodlama" on 8, "kullanıcı deneyimi" on 2, in a single pass.
   */
  tags: TagVocabularyEntry[];
}

// -- small helpers ----------------------------------------------------------

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Interior whitespace collapsed, matching `collapseName` in ./ai.ts:
 *  a proposal rendered over two lines in the review list is still one name. */
function cleanName(value: unknown): string {
  return trimmed(value).replace(/\s+/g, " ");
}

function titleOf(bookmark: ClassifiableBookmark): string {
  return trimmed(bookmark.title);
}

/** The host, never the URL: a query string can carry a session token, and all
 *  the proposer needs to know is which site an item came from. */
function siteOf(bookmark: ClassifiableBookmark): string {
  const url = typeof bookmark.url === "string" ? bookmark.url : "";
  if (url === "") return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * The key two collection names have to share to count as the same collection:
 * trimmed, one leading `#` dropped, interior whitespace collapsed, lowercased.
 * The `#` and the case-folding are `normalizeTagName`'s cleanup — reused as a
 * *style* rather than as a call, because that function's contract is a tag's
 * stored spelling and silently mangling a collection name is not a thing it
 * should be asked to do. Whitespace collapsing is `collapseName`'s, from the
 * server.
 */
function collectionKey(name: string): string {
  const collapsed = cleanName(name);
  const withoutHash = collapsed.startsWith("#") ? collapsed.slice(1) : collapsed;
  // foldCase, not toLowerCase: a collection named "İş Akışları" has to key the
  // same as one a user later types as "iş akışları", and plain toLowerCase
  // leaves a combining dot in the first. See normalizeTagName in ai-classify.
  return foldCase(withoutHash.trim());
}

/** How far into a word to compare before deciding two words differ. Turkish
 *  glues its case and possessive endings onto the stem, so "tasarımı" and
 *  "tasarımları" share five characters and nothing else. */
const STEM_CHARS = 5;

/** Words reduced to a comparable stem: normalised, then truncated so an ending
 *  does not decide whether two words name the same idea. */
function stemWords(value: string): string[] {
  return normalizeTagName(value)
    .split(" ")
    .filter((word) => word !== "")
    .map((word) => (word.length > STEM_CHARS ? word.slice(0, STEM_CHARS) : word));
}

/**
 * Whether an accepted collection already speaks for a proposed tag.
 *
 * The proposer names a theme once and then proposes it twice — "Açık Kaynak
 * Projeleri" as a collection and "açık kaynak" as a tag — because from its side
 * they are the same observation. They are not redundant: collections are
 * exclusive and tags are not, so a bookmark filed elsewhere can still be
 * "açık kaynak". So the tag is *kept*, and this only decides its default in the
 * review list, where a tag that duplicates a collection you are about to create is
 * better off one click away from ticked than on.
 *
 * Matched on stems, not whole words, for the reason above: "ui tasarımı" is
 * covered by "Etkileşimli UI Tasarımları" only on a prefix comparison, and an
 * exact one would miss nearly every Turkish case this exists to catch. Being
 * generous is the safe direction here — a false positive only starts a tag
 * unticked, and the user ticks it; a false negative leaves it on, which is the
 * status quo and no worse.
 */
export function isTagCoveredByCollection(tag: string, collectionNames: string[]): boolean {
  const tagWords = stemWords(tag);
  if (tagWords.length === 0) return false;
  return collectionNames.some((name) => {
    const haystack = stemWords(name).join(" ");
    let cursor = 0;
    for (const word of tagWords) {
      const found = haystack.indexOf(word, cursor);
      if (found === -1) return false;
      // Past the match, so two tag words cannot both match one collection word.
      cursor = found + word.length;
    }
    return true;
  });
}

// -- sampling ---------------------------------------------------------------

/**
 * Unfiled bookmarks worth proposing from, spread across the whole library with
 * a deterministic stride.
 *
 * A stride, not a slice: a bulk read hands records back in id order, which for
 * saved posts is save order, so the newest 200 of a 1,061-bookmark library
 * describe only the last few weeks of someone's reading. Stepping across the pool
 * instead means a proposal is drawn from the whole library — including the oldest
 * saves, which are usually the ones that reveal a theme the user has since
 * stopped collecting actively.
 *
 * Deterministic by construction, and that is not tidiness. The same input has to
 * yield the same sample every time, or a second "Suggest taxonomy" would silently
 * re-propose a different taxonomy from different evidence and the user would have
 * no way to tell it apart from the model having changed its mind. Two things make
 * it so: the pool is ordered by id (stable, and independent of whatever order the
 * query returned), and the index is pure arithmetic.
 *
 * Eligibility is the classifier's (`bookmarkNeedsClassification`), so the sample is
 * drawn from exactly the set a pass still has to file. Items already filed are in
 * a collection *because a human put them there*, and items the model has already
 * ruled on are, by construction, ones it had an opinion about — neither is
 * evidence about what is still unorganised. Soft-deleted records are filtered
 * here as well as at the read, for the same reason `selectCandidates` filters
 * twice: a caller that already has a list in hand still can't propose from
 * something the user threw away.
 */
export function selectSample(bookmarks: ClassifiableBookmark[], size: number): ClassifiableBookmark[] {
  if (!Number.isFinite(size) || size <= 0) return [];
  const wanted = Math.max(0, Math.min(Math.floor(size), TAXONOMY_SAMPLE_SIZE));
  if (wanted === 0) return [];
  const pool = bookmarks
    .filter(
      (bookmark) =>
        bookmark != null &&
        !bookmark.deletedAt &&
        bookmarkNeedsClassification(bookmark) &&
        titleOf(bookmark).length + siteOf(bookmark).length >= MIN_SAMPLE_CHARS,
    )
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (pool.length <= wanted) return pool;
  const step = pool.length / wanted;
  const sample: ClassifiableBookmark[] = [];
  for (let index = 0; index < wanted; index++) {
    const picked = pool[Math.floor(index * step)];
    if (picked) sample.push(picked);
  }
  return sample;
}

/**
 * The sample titles that back one accepted collection.
 *
 * The proposer names a theme; it does not say which of the 200 sampled
 * bookmarks belong to it, and nothing in the response could. Attaching the same
 * digest to every option would be worse than none — the whole measured value of
 * the digest is that it tells the options *apart* (8.7 points of top-1,
 * docs/ai-calibration.md), and identical criteria across a `Choice` actively
 * destroys that. So the assignment is made here, lexically: the bookmarks whose
 * own text shares the most words with the collection's name.
 *
 * It is a word-overlap heuristic, not a classification, and it is allowed to find
 * nothing: a collection whose name shares no vocabulary with the sample gets an
 * empty digest and is offered by name alone, which is the honest outcome for a
 * brand-new empty collection.
 */
function samplesFor(name: string, samples: ClassifiableBookmark[]): string[] {
  const terms = termSet(name);
  if (terms.size === 0) return [];
  const ranked = samples
    .map((bookmark, index) => ({
      index,
      title: titleOf(bookmark).slice(0, MAX_TITLE_CHARS),
      score: countSharedTerms(terms, bookmarkText(bookmark)),
    }))
    .filter((entry) => entry.title !== "" && entry.score > 0)
    // Sort is stable, so equal scores keep the sample's own (deterministic)
    // order rather than an arbitrary one.
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_OPTION_SAMPLES);
  return ranked.map((entry) => entry.title);
}

/** The name's words, lowercased and stripped of punctuation. */
function termSet(name: string): Set<string> {
  return new Set(
    fold(cleanName(name))
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= MIN_TERM_CHARS),
  );
}

/**
 * The text a sample entry is matched against: what the proposer was shown plus
 * the description the user typed. Diacritics are folded first, because the
 * library this was measured on is Turkish and "türkçe"/"turkce" are the same
 * word — a partial fold (dotless `ı` still differs from `i`), which is enough for
 * ranking and honest about not being a real stemmer.
 */
function bookmarkText(bookmark: ClassifiableBookmark): string {
  return fold([titleOf(bookmark), trimmed(bookmark.shortDescription), trimmed(bookmark.note)].join(" "));
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Distinct words the two texts share. A word repeated three times in a title
 *  is one signal, not three, so the count is over a set on both sides. */
function countSharedTerms(terms: Set<string>, text: string): number {
  const words = new Set(text.split(/[^\p{L}\p{N}]+/u));
  let shared = 0;
  for (const term of terms) {
    if (words.has(term)) shared++;
  }
  return shared;
}

// -- the record -------------------------------------------------------------

/**
 * The accepted-taxonomy record: the accepted options, each with the sample titles
 * that describe it, stamped with when the set was last changed.
 *
 * `previous` is what is already stored. Its entries are kept, not replaced: this
 * runs a handful of times a year and each run accepts a different handful of
 * names, so a record that only ever described the newest batch would strip the
 * evidence from every collection accepted earlier. The classifier is the one that
 * decides an entry is orphaned (an option matching no live list row is ignored),
 * so nothing is dropped here for being stale.
 */
export function toAcceptedTaxonomy(
  proposals: TaxonomyProposal[],
  samples: ClassifiableBookmark[],
  at: string,
  previous: AiTaxonomyOption[] = [],
  tags: TagVocabularyEntry[] = [],
  previousTags: TagVocabularyEntry[] = [],
): AcceptedTaxonomy {
  const accepted = new Set(proposals.map((proposal) => collectionKey(proposal.name)));
  const collections: AiTaxonomyOption[] = [];
  const seen = new Set<string>();

  for (const option of previous) {
    const name = trimmed(option?.name);
    const key = collectionKey(name);
    // Superseded by a fresh proposal, or a duplicate of one already carried.
    if (name === "" || accepted.has(key) || seen.has(key)) continue;
    seen.add(key);
    // `id` is the name key, and the real list id is only known once the list row
    // is written. An accepted collection and its BookmarkList are created in one
    // transaction, so the row carries a real uuid, but the option is matched
    // against it by name as well as by id — which is why keying on the name is
    // not a stand-in for an id but the same key space the classifier already
    // uses.
    collections.push({ id: name.toLowerCase(), name, samples: [...(option.samples ?? [])] });
  }
  for (const proposal of proposals) {
    const name = cleanName(proposal.name);
    const key = collectionKey(name);
    if (name === "" || seen.has(key)) continue;
    seen.add(key);
    collections.push({ id: name.toLowerCase(), name, samples: samplesFor(name, samples) });
  }

  // Same merge discipline as the collections above: earlier batches survive, so
  // a vocabulary accepted last spring is not emptied by one accepted today.
  // Normalised, since a name the library already uses must not come back as a
  // "new" tag — the library's own tags cover it from here.
  const vocabulary: TagVocabularyEntry[] = [];
  const carried = new Set<string>();
  for (const entry of [...previousTags, ...tags]) {
    const name = normalizeTagName(entry?.name);
    if (name === "" || carried.has(name)) continue;
    carried.add(name);
    const definition = cleanName(entry?.definition);
    vocabulary.push(definition ? { name, definition } : { name });
    if (vocabulary.length >= MAX_TAXONOMY_TAGS) break;
  }

  return { acceptedAt: at, collections, tags: vocabulary };
}

/**
 * Reads a stored `nook_ai_taxonomy.data` value, tolerantly.
 *
 * The same tolerance the extension's reader and writer both had to keep, because
 * the writer must not "fix" a record the reader can still make sense of: a bare
 * array (an early shape), a wrapped object, a half-written value, or nothing at
 * all. Anything unreadable is an empty set, so the next acceptance writes a clean
 * record instead of refusing to run. `acceptedAt` is left `null` rather than
 * guessed, exactly as the extension left it undefined: it dates the acceptance,
 * and a made-up date would claim a taxonomy was accepted in 1970.
 */
export function normalizeAcceptedTaxonomy(value: unknown): AcceptedTaxonomy {
  const wrapped = (value && typeof value === "object" && !Array.isArray(value) ? value : {}) as {
    collections?: unknown;
    tags?: unknown;
    acceptedAt?: unknown;
  };
  const storedCollections: unknown[] = Array.isArray(value)
    ? value
    : Array.isArray(wrapped.collections)
      ? wrapped.collections
      : [];
  const collections: AiTaxonomyOption[] = [];
  const seen = new Set<string>();
  for (const entry of storedCollections) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; name?: unknown; samples?: unknown };
    const name = trimmed(record.name);
    if (name === "") continue;
    // Deduped on the same key `toAcceptedTaxonomy` writes with: two options for
    // one collection would make the model choose between two identical keys, and
    // one of them would win for no reason.
    const key = collectionKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    // A stored id is kept when it is a usable string, because that is the id the
    // option can be matched against a live list row by; the lowercased name is
    // only the fallback for an entry written before the id was carried.
    const id = trimmed(record.id) || name.toLowerCase();
    collections.push({
      id,
      name,
      samples: Array.isArray(record.samples)
        ? record.samples.filter((sample): sample is string => typeof sample === "string" && sample.trim() !== "")
        : [],
    });
  }
  // A record written before tags existed carries none, and that is a normal state,
  // not damage: the next acceptance adds to it.
  const tags: TagVocabularyEntry[] = [];
  const seenTags = new Set<string>();
  for (const entry of Array.isArray(wrapped.tags) ? wrapped.tags : []) {
    // A bare string is the pre-definition shape, and still readable: a tag that
    // was stored before definitions existed keeps working, asked about by name.
    const record = (entry && typeof entry === "object" ? entry : {}) as { name?: unknown; definition?: unknown };
    const rawName = typeof entry === "string" ? entry : record.name;
    const name = normalizeTagName(typeof rawName === "string" ? rawName : "");
    if (name === "" || seenTags.has(name)) continue;
    seenTags.add(name);
    const definition = cleanName(record.definition);
    tags.push(definition ? { name, definition } : { name });
  }
  const acceptedAt =
    typeof wrapped.acceptedAt === "string" && !Number.isNaN(Date.parse(wrapped.acceptedAt))
      ? wrapped.acceptedAt
      : null;
  return { acceptedAt, collections, tags };
}

// -- creating the collections ----------------------------------------------

/**
 * The proposals that are not already a collection the user has. A collision is
 * dropped rather than duplicated, and the collection it collided with is never
 * touched: re-proposing "Reading" must not rewrite a collection the user has been
 * filing into by hand, and creating a second list of the same name would leave
 * the dashboard with two chips that mean the same thing and no way to tell them
 * apart. Soft-deleted lists do not collide — the query leaves them out, so a name
 * the user deliberately removed can be proposed again.
 */
export function dropTakenProposals(
  proposals: TaxonomyProposal[],
  existing: ClassifiableList[],
): TaxonomyProposal[] {
  const taken = new Set(existing.map((list) => collectionKey(trimmed(list?.name))).filter((key) => key !== ""));
  const kept: TaxonomyProposal[] = [];
  for (const proposal of proposals) {
    const key = collectionKey(proposal?.name);
    // Also collapses two proposals that differ only in case, which
    // `parseTaxonomyProposal` already dedupes — repeated here so this function is
    // total on its own.
    if (key === "" || taken.has(key)) continue;
    taken.add(key);
    kept.push(proposal);
  }
  return kept;
}

/**
 * The list records for the accepted proposals: fresh ids, both timestamps from
 * `at`, and no icon or emoji so the dashboard falls back to its own default rather
 * than inventing a look the user never chose.
 *
 * `newId` is injected rather than called inline so a test can pin the ids: a
 * random uuid makes every assertion about two planned rows a coin flip, and two
 * proposals must never share one list. The default is the platform's own, which is
 * the right source of an id in production and keeps the caller free to pass
 * nothing.
 */
export function planLists(
  proposals: TaxonomyProposal[],
  existing: ClassifiableList[],
  at: string,
  newId: () => string = () => crypto.randomUUID(),
): ClassifiableList[] {
  return dropTakenProposals(proposals, existing).map((proposal) => ({
    id: newId(),
    name: cleanName(proposal.name),
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  }));
}

/**
 * The tag vocabulary to store, from what the proposer suggested.
 *
 * Only genuine duplicates are dropped: a name that normalises to something a
 * bookmark already carries adds nothing, because from that point on the
 * library's own tags cover it. Everything else survives, including tags that echo
 * an accepted collection — see `isTagCoveredByCollection` for why those are kept
 * rather than dropped.
 */
export function planTags(
  proposed: TagProposal[],
  existingTags: string[],
  limit: number = MAX_TAXONOMY_TAGS,
): TagVocabularyEntry[] {
  const taken = new Set(
    (Array.isArray(existingTags) ? existingTags : [])
      .map((tag) => normalizeTagName(tag))
      .filter((tag) => tag !== ""),
  );
  const kept: TagVocabularyEntry[] = [];
  const cap = Math.max(0, limit);
  for (const entry of Array.isArray(proposed) ? proposed : []) {
    // Checked before the push rather than after it: a cap of zero has to mean
    // nothing is stored, and the other order quietly returns one entry. Every
    // limit of one or more behaves identically either way.
    if (kept.length >= cap) break;
    const name = normalizeTagName(entry?.name);
    if (name === "" || taken.has(name)) continue;
    taken.add(name);
    const definition = cleanName(entry?.why);
    kept.push(definition ? { name, definition } : { name });
  }
  return kept;
}

// -- the response -----------------------------------------------------------

/**
 * The collection proposals in the proposer's body, for the review list.
 *
 * The server already parses, dedupes and caps the model's JSON
 * (`parseTaxonomyProposal` in ./ai.ts), and none of that is repeated here — but
 * none of it is *trusted* here either. A proposal without a `why` is dropped
 * rather than rendered as a bare name, because the review list has nowhere to
 * show a name with no reason, and a name with no reason is the one thing a user
 * should never be asked to accept.
 */
export function readProposals(value: unknown): TaxonomyProposal[] {
  const body = (value && typeof value === "object" ? value : {}) as { collections?: unknown };
  const proposals: TaxonomyProposal[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(body.collections) ? body.collections : []) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; why?: unknown };
    const name = cleanName(record.name);
    const why = cleanName(record.why);
    const key = collectionKey(name);
    if (name === "" || why === "" || seen.has(key)) continue;
    seen.add(key);
    proposals.push({ name, why });
  }
  return proposals;
}

/**
 * The proposed tag vocabulary, each with the proposer's own one-liner and the
 * collections in the same response that already cover it.
 *
 * The `why` is kept rather than dropped for the same reason a collection's is: it
 * is shown in the review list, and on acceptance it becomes the tag's definition.
 * A tag with no members is otherwise just a bare name, and a bare name is the
 * thinnest possible input to ask a model "does this belong under it?" about.
 * Measured over 80 real bookmarks, definitions put 12 of 12 vocabulary entries to
 * use against 10 of 12 for bare names, at 24% more input tokens — a modest win,
 * honestly, and deliberately *not* the member-title evidence that halved tag
 * recall (docs/ai-calibration.md).
 *
 * `coveredBy` is what the client used to compute for itself, and computing it here
 * is the point of the server move: the review list starts a covered tag unticked
 * and re-ticks it the moment the matching collection is unticked, so the two do not
 * arrive fighting each other, and the client never has to own the stem comparison.
 * Covered is not the same as redundant — see `isTagCoveredByCollection`.
 */
export function readProposedTags(value: unknown, collectionNames: string[]): TagProposal[] {
  const body = (value && typeof value === "object" ? value : {}) as { tags?: unknown };
  // Cleaned and deduped once, because this list is shown beside those same names
  // in the review list, where a duplicate would read as two collections covering
  // one tag.
  const names = [...new Set((Array.isArray(collectionNames) ? collectionNames : []).map(cleanName))].filter(
    (name) => name !== "",
  );
  const tags: TagProposal[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(body.tags) ? body.tags : []) {
    const record = (entry && typeof entry === "object" ? entry : {}) as { name?: unknown; why?: unknown };
    const raw = typeof entry === "string" ? entry : record.name;
    const name = normalizeTagName(typeof raw === "string" ? raw : "");
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    // Optional: a proposer that omits it still yields a usable tag, just one
    // asked about by name alone. That was every tag's fate before definitions
    // existed.
    const why = cleanName(record.why);
    const coveredBy = names.filter((collectionName) => isTagCoveredByCollection(name, [collectionName]));
    tags.push(why ? { name, why, coveredBy } : { name, coveredBy });
  }
  return tags;
}
