/**
 * Taxonomy growth: read a sample of the library, ask a model to invent
 * collection names for the themes it finds, and turn the names the user keeps
 * into real BookmarkList records plus the `ai.taxonomy` record the runner
 * reads. See docs/ai.md, "Taxonomy growth".
 *
 * -- why this file needs a generative model, and nothing else does --
 *
 * Jev is not an LLM. It evaluates a `state` against typed questions we hand
 * it and answers with calibrated probabilities, so the only names it can ever
 * return are the option *keys* we defined. That is a feature, not a limit,
 * for feature 1: the options are the user's own collections and tags, each
 * carrying its actual member titles as criteria, and "which of these" is
 * exactly the question the model is reliable on. It is disqualifying here.
 * Inventing a category name is not a choice among options we supplied — there
 * is no closed set to choose from, and a `Choice` with a fabricated option key
 * would be the model echoing our invention back at us. So this is the one
 * call in the product that goes to a text LLM (`NOOK_AI_PROPOSER`, wrapped
 * server-side behind `proposeTaxonomy()`), it handles a handful of calls a
 * year, and everything around it — the sample, the collisions, the review, the
 * writes — is code we own.
 *
 * The split follows lib/ai-classify.ts (pure) and lib/ai-runner.ts (not):
 * everything that decides *what ends up on a real user's library* is a pure
 * function a test can call with no harness, and only the HTTP call and the
 * IndexedDB writes live below the `-- impure --` banner. `fetch`, the session
 * and the clock are injected the way ai-runner.ts injects them, so this file
 * imports no `chrome.*` and loads in a plain Node test.
 *
 * The record this writes is read back by `readTaxonomy()` in lib/ai-runner.ts,
 * which only ever consumes it: `{ acceptedAt, collections: AiTaxonomyOption[] }`,
 * where each option's `samples` are the member titles that become the
 * `Choice` criteria. That consumer is why the record is a *device* preference
 * and not library data — meta keys do not sync, so a taxonomy accepted on the
 * web origin would be invisible to the extension's runner forever.
 */

import {
  bookmarkNeedsClassification,
  foldCase,
  normalizeTagName,
  type AiTaxonomyOption,
  type TagVocabularyEntry,
} from "./ai-classify";
import { AI_TAXONOMY_META_KEY, type AiFetch } from "./ai-runner";
import type { TaxonomyLanguage } from "./ai-settings";
import { cloudApiUrl, cloudSession } from "./cloud-sync";
import * as NookDB from "./db";
import type { Bookmark, BookmarkList } from "./types";

// -- limits ----------------------------------------------------------------

/**
 * Unfiled bookmarks sent to the proposer, and the doc's number. It is also the
 * server's hard cap: `parseProposeTaxonomyRequest` stops at MAX_SAMPLE_ITEMS
 * (200) and drops the rest, so asking for more would look like it worked.
 */
export const TAXONOMY_SAMPLE_SIZE = 200;

/** `ProposeTaxonomyRequest`'s own defaults, sent explicitly so the request
 *  says what it wanted instead of inheriting whatever the server decides. */
export const PROPOSAL_MAX_COLLECTIONS = 8;
export const PROPOSAL_MAX_TAGS = 20;

/**
 * `MIN_CLASSIFIABLE_CHARS` in apps/api/src/ai.ts, on purpose. That floor is a
 * cost guard the classification route applies to one bookmark; here it guards
 * the sample, and for the same reason: after the state filter a media-only
 * bookmark is a bare emoji or an author's handle, and 39 of a real 1,061-item
 * library fall under the floor (docs/ai-calibration.md). Spending the proposal
 * on those teaches the proposer nothing but noise, and it is the one thing in
 * this file that could quietly poison every name it returns.
 */
const MIN_SAMPLE_CHARS = 40;

/** `AI_COLLECTION_SAMPLES` in lib/ai-runner.ts. The runner trims each option's
 *  samples to five on every read, so carrying more only grows a meta record
 *  that is read on every classification tick. */
const MAX_OPTION_SAMPLES = 5;

/** `MAX_TITLE_CHARS` in apps/api/src/ai.ts: a sample title is a label, not a
 *  body of text. */
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

/** A proposed tag. `why` becomes the tag's definition once accepted, and is
 *  shown in the review list beside the name. */
export interface TagProposal {
  name: string;
  why?: string;
}

/**
 * The record written to `ai.taxonomy` and read back by `readTaxonomy()` in
 * lib/ai-runner.ts. Exact shape, because that is the seam between the two
 * files: an object (not a bare array) carrying `collections`, each entry a
 * `{ id, name, samples }` option, plus `tags` — a flat vocabulary of names that
 * have no members yet — plus the ISO date the runner stamps onto every
 * attribution as `ai.taxonomyAt`.
 */
export interface AcceptedTaxonomy {
  acceptedAt: string;
  collections: AiTaxonomyOption[];
  /**
   * Accepted tag names that no bookmark carries yet.
   *
   * They exist so a brand-new tag can be *offered* to the model as a `Noul` and
   * earn its first member the ordinary way. Without this, a proposed tag is
   * inert: the runner builds its tag questions from the tags bookmarks already
   * have, so a tag with no members can never be proposed by any code that
   * exists. Once one bookmark takes it, it is a real tag and this entry is
   * redundant.
   */
  tags: TagVocabularyEntry[];
}

/** What is in `ai.taxonomy` right now, as read tolerantly enough to survive a
 *  half-written or older record. `acceptedAt` is absent when the stored value
 *  carries no readable date. */
export interface StoredTaxonomy {
  acceptedAt?: string;
  collections: AiTaxonomyOption[];
  tags?: TagVocabularyEntry[];
}

export type ProposalOutcome =
  /** The server answered. `proposals` may be empty — declining is a valid answer. */
  | { kind: "proposals"; proposals: TaxonomyProposal[]; sample: Bookmark[]; tags: TagProposal[] }
  /** Nothing eligible to read, so no request was made. */
  | { kind: "nothing-to-read" }
  | { kind: "signed-out" }
  /** 503: the server has no AI key configured. A deploy, not a retry. */
  | { kind: "unavailable" }
  | { kind: "throttled" }
  | { kind: "failed"; message: string };

export interface AiTaxonomyDeps {
  /** Defaults to the global fetch. */
  fetch?: AiFetch;
  /** Defaults to cloudApiUrl(). */
  apiUrl?: string;
  /** Defaults to cloudSession(); null means signed out, so nothing is sent. */
  session?: () => Promise<{ token: string; ownerId: string } | null>;
  /** Overrides TAXONOMY_SAMPLE_SIZE. */
  sampleSize?: number;
  /** What language to name things in. Omitted when `auto`, so the server's own
   *  default decides. */
  language?: TaxonomyLanguage;
}

// -- small helpers ----------------------------------------------------------

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** Interior whitespace collapsed, matching `collapseName` in apps/api/src/ai.ts:
 *  a proposal rendered over two lines in the review list is still one name. */
function cleanName(value: unknown): string {
  return trimmed(value).replace(/\s+/g, " ");
}

function titleOf(bookmark: Bookmark): string {
  return trimmed(bookmark.title);
}

/** The host, never the URL: a query string can carry a session token, and all
 *  the proposer needs to know is which site an item came from. */
function siteOf(bookmark: Bookmark): string {
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
 * "açık kaynak". So the tag is *kept*, and this only drives the review list's
 * default, where a tag that duplicates a collection you are about to create is
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
 * A stride, not a slice: `getAllBookmarks()` hands records back in key order,
 * which for saved posts is save order, so the newest 200 of a 1,061-bookmark
 * library describe only the last few weeks of someone's reading. Stepping
 * across the pool instead means a proposal is drawn from the whole library —
 * including the oldest saves, which are usually the ones that reveal a theme
 * the user has since stopped collecting actively.
 *
 * Deterministic by construction, and that is not tidiness. The same input has
 * to yield the same sample every time, or a second "Suggest taxonomy" would
 * silently re-propose a different taxonomy from different evidence and the user
 * would have no way to tell it apart from the model having changed its mind.
 * Two things make it so: the pool is ordered by id (stable, and independent of
 * whatever order the store returned), and the index is pure arithmetic.
 *
 * Eligibility is the runner's (`bookmarkNeedsClassification`), so the sample is
 * drawn from exactly the set a pass still has to file. Items already filed are
 * in a collection *because a human put them there*, and items the model has
 * already ruled on are, by construction, ones it had an opinion about — neither
 * is evidence about what is still unorganised. Soft-deleted records are
 * filtered here as well as at the DB read, for the same reason
 * `selectCandidates` filters twice.
 */
export function selectSample(bookmarks: Bookmark[], size: number): Bookmark[] {
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
  const sample: Bookmark[] = [];
  for (let index = 0; index < wanted; index++) {
    const picked = pool[Math.floor(index * step)];
    if (picked) sample.push(picked);
  }
  return sample;
}

// -- the record -------------------------------------------------------------

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
 * It is a word-overlap heuristic, not a classification, and it is allowed to
 * find nothing: a collection whose name shares no vocabulary with the sample
 * gets an empty digest and is offered by name alone, which is the honest
 * outcome for a brand-new empty collection.
 */
function samplesFor(name: string, samples: Bookmark[]): string[] {
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
 * word — a partial fold (dotless `ı` still differs from `i`), which is enough
 * for ranking and honest about not being a real stemmer.
 */
function bookmarkText(bookmark: Bookmark): string {
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

/**
 * The record `readTaxonomy()` in lib/ai-runner.ts reads back: the accepted
 * options, each with the sample titles that describe it, stamped with when the
 * set was last changed.
 *
 * `previous` is what is already in the meta store. Its entries are kept, not
 * replaced: this runs a handful of times a year and each run accepts a
 * different handful of names, so a record that only ever described the newest
 * batch would strip the evidence from every collection accepted earlier. The
 * runner is the one that decides an entry is orphaned (an option matching no
 * live BookmarkList is ignored), so nothing is dropped here for being stale.
 */
export function toAcceptedTaxonomy(
  proposals: TaxonomyProposal[],
  samples: Bookmark[],
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
    // `id` is the name key readTaxonomy() falls back to when an entry carries
    // no list id. The live list's own uuid is assigned when the list is
    // created, and the runner matches options by name as well as by id, so
    // this is the same key space the runner already uses.
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

// -- creating the collections ----------------------------------------------

/**
 * The proposals that are not already a collection the user has. A collision is
 * dropped rather than duplicated, and the collection it collided with is never
 * touched: re-proposing "Reading" must not rewrite a collection the user has
 * been filing into by hand, and creating a second list of the same name would
 * leave the dashboard with two chips that mean the same thing and no way to
 * tell them apart. Soft-deleted lists do not collide — `getAllLists()` leaves
 * them out, so a name the user deliberately removed can be proposed again.
 */
export function dropTakenProposals(proposals: TaxonomyProposal[], existing: BookmarkList[]): TaxonomyProposal[] {
  const taken = new Set(existing.map((list) => collectionKey(trimmed(list?.name))).filter((key) => key !== ""));
  const kept: TaxonomyProposal[] = [];
  for (const proposal of proposals) {
    const key = collectionKey(proposal?.name);
    // Also collapses two proposals that differ only in case, which the server
    // already dedupes — repeated here so this function is total on its own.
    if (key === "" || taken.has(key)) continue;
    taken.add(key);
    kept.push(proposal);
  }
  return kept;
}

/**
 * The BookmarkList records for the accepted proposals: fresh ids, both
 * timestamps from `at`, and no icon or emoji so the dashboard falls back to its
 * own default rather than inventing a look the user never chose.
 */
export function planLists(proposals: TaxonomyProposal[], existing: BookmarkList[], at: string): BookmarkList[] {
  return dropTakenProposals(proposals, existing).map((proposal) => ({
    id: crypto.randomUUID(),
    name: cleanName(proposal.name),
    createdAt: at,
    updatedAt: at,
    deletedAt: null,
  }));
}

/**
 * Ceiling on the stored vocabulary.
 *
 * It matches the 20 tag questions a single classification asks about, on
 * purpose. An earlier version capped it at 12 to "leave room for the library's
 * own tags", which was wrong on two counts: `buildTagOptions` already puts the
 * library's real tags first and slices, so they are never crowded out, and 12
 * meant that ticking 13 of the 20 tags the proposer offered silently discarded
 * one — with nothing in the review list saying so. Nothing ticked should vanish
 * at acceptance.
 */
export const MAX_TAXONOMY_TAGS = 20;

/**
 * The tag vocabulary to store, from what the proposer suggested.
 *
 * Only genuine duplicates are dropped: a name that normalises to something a
 * bookmark already carries adds nothing, because from that point on the
 * library's own tags cover it. Everything else survives, including tags that
 * echo an accepted collection — see `isTagCoveredByCollection` for why those are
 * kept rather than dropped.
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
  for (const entry of Array.isArray(proposed) ? proposed : []) {
    const name = normalizeTagName(entry?.name);
    if (name === "" || taken.has(name)) continue;
    taken.add(name);
    const definition = cleanName(entry?.why);
    kept.push(definition ? { name, definition } : { name });
    if (kept.length >= Math.max(0, limit)) break;
  }
  return kept;
}

export interface AcceptInput {
  proposals: TaxonomyProposal[];
  /** The sample the proposal was made from — the titles that back each name. */
  samples: Bookmark[];
  /** Live collections, so a proposal that duplicates one is dropped. */
  existing: BookmarkList[];
  /** Tag proposals the user kept, already reduced to the ticked ones. */
  tags?: TagProposal[];
  /** Tags the library already carries, so the stored vocabulary adds only new ones. */
  existingTags?: string[];
}

export interface AcceptResult {
  created: BookmarkList[];
  /** Names dropped because a collection already had them. */
  dropped: string[];
  /** Tag names added to the vocabulary, i.e. that no bookmark carried before. */
  addedTags: string[];
  taxonomy: AcceptedTaxonomy;
}

/**
 * Turns the proposals the user kept into real collections and writes the record
 * the runner reads.
 *
 * The lists are written first and the record second, on purpose. A crash
 * between the two leaves real collections the model can still be offered (by
 * name, with no digest) rather than a taxonomy record describing collections
 * that do not exist — and the runner ignores an option with no live list behind
 * it, so the reverse order would leave a record that looks accepted and does
 * nothing. The write still reports failures: a `setMeta` that throws means the
 * collections are real and the record is not, and the caller has to say so
 * rather than count them as accepted.
 */
export async function acceptProposals(input: AcceptInput, at: string = new Date().toISOString()): Promise<AcceptResult> {
  const kept = dropTakenProposals(input.proposals, input.existing);
  const keptKeys = new Set(kept.map((proposal) => collectionKey(proposal.name)));
  const created = planLists(kept, input.existing, at);
  const stored = await readStoredTaxonomy();
  const addedTags = planTags(input.tags ?? [], input.existingTags ?? []);
  // The panel counts what it can act on, so it wants names. The definitions live
  // on `taxonomy.tags`, which is where the runner reads them from.
  const addedTagNames = addedTags.map((entry) => entry.name);
  const taxonomy = toAcceptedTaxonomy(kept, input.samples, at, stored.collections, addedTags, stored.tags);
  await Promise.all(created.map((list) => NookDB.putList(list)));
  await NookDB.setMeta(AI_TAXONOMY_META_KEY, taxonomy);
  return {
    created,
    dropped: input.proposals.filter((proposal) => !keptKeys.has(collectionKey(proposal?.name))).map((p) => cleanName(p.name)),
    addedTags: addedTagNames,
    taxonomy,
  };
}

// -- the call ---------------------------------------------------------------

/**
 * Reads `ai.taxonomy` with the same tolerance as `readTaxonomy()` in
 * lib/ai-runner.ts, because this is the writer and must not "fix" a record that
 * reader can still make sense of: a bare array (an early shape), a wrapped
 * object, a half-written value, or nothing at all. Anything unreadable is an
 * empty set — re-accepting then writes a clean record instead of refusing to
 * run. `acceptedAt` is left undefined rather than guessed, exactly as the
 * runner leaves it: it dates the acceptance, and a made-up date would claim a
 * taxonomy was accepted in 1970.
 */
export async function readStoredTaxonomy(): Promise<StoredTaxonomy> {
  const stored = await NookDB.getMeta<unknown>(AI_TAXONOMY_META_KEY);
  const wrapped = (stored && typeof stored === "object" ? stored : {}) as { collections?: unknown; tags?: unknown; acceptedAt?: unknown };
  const raw: unknown[] = Array.isArray(stored) ? stored : Array.isArray(wrapped.collections) ? wrapped.collections : [];
  const collections: AiTaxonomyOption[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { name?: unknown; samples?: unknown };
    const name = trimmed(record.name);
    if (name === "") continue;
    collections.push({
      id: name.toLowerCase(),
      name,
      samples: Array.isArray(record.samples)
        ? record.samples.filter((sample): sample is string => typeof sample === "string" && sample.trim() !== "")
        : [],
    });
  }
  // A record written before tags existed carries none, and that is a normal
  // state, not damage: the next acceptance adds to it.
  const tags: TagVocabularyEntry[] = [];
  const seenTags = new Set<string>();
  for (const raw of Array.isArray(wrapped.tags) ? wrapped.tags : []) {
    // A bare string is the pre-definition shape, and still readable: a tag that
    // was stored before definitions existed keeps working, asked about by name.
    const record = (raw && typeof raw === "object" ? raw : {}) as { name?: unknown; definition?: unknown };
    const rawName = typeof raw === "string" ? raw : record.name;
    const name = normalizeTagName(typeof rawName === "string" ? rawName : "");
    if (name === "" || seenTags.has(name)) continue;
    seenTags.add(name);
    const definition = cleanName(record.definition);
    tags.push(definition ? { name, definition } : { name });
  }
  const acceptedAt =
    typeof wrapped.acceptedAt === "string" && !Number.isNaN(Date.parse(wrapped.acceptedAt)) ? wrapped.acceptedAt : undefined;
  return acceptedAt ? { acceptedAt, collections, tags } : { collections, tags };
}

/**
 * The proposals for the review list.
 *
 * The server already parses, dedupes and caps the model's JSON
 * (`parseTaxonomyProposal`), and none of that is repeated here — but none of it
 * is *trusted* here either. A proposal without a `why` is dropped rather than
 * rendered as a bare name, because the review list has nowhere to show a
 * name with no reason, and a name with no reason is the one thing a user should
 * never be asked to accept.
 */
function readProposals(value: unknown): TaxonomyProposal[] {
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

/** The tag vocabulary the proposer also returned.
 *
 *  Deliberately carried but not accepted. The runner builds its tag `Noul`s
 *  from the tags bookmarks actually carry (`buildTagOptions`), and
 *  `readTaxonomy()` reads no tag field at all, so writing a proposed vocabulary
 *  to `ai.taxonomy` would store a list nothing consumes. Surfacing it would be
 *  worse than silence: the user would expect tags that nothing can apply. It is
 *  returned so a caller can see that the model produced some, and left there
 *  until a runner that can offer an unused tag exists.
 */
/**
 * The proposed tag vocabulary, each with the proposer's own one-liner.
 *
 * The `why` is kept rather than dropped for the same reason a collection's is:
 * it is shown in the review list, and on acceptance it becomes the tag's
 * definition. A tag with no members is otherwise just a bare name, and a bare
 * name is the thinnest possible input to ask a model "does this belong under
 * it?" about.
 */
function readProposedTags(value: unknown): TagProposal[] {
  const body = (value && typeof value === "object" ? value : {}) as { tags?: unknown };
  const tags: TagProposal[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(body.tags) ? body.tags : []) {
    const record = (entry && typeof entry === "object" ? entry : {}) as { name?: unknown; why?: unknown };
    const raw = typeof entry === "string" ? entry : record.name;
    const name = normalizeTagName(typeof raw === "string" ? raw : "");
    if (name === "" || seen.has(name)) continue;
    seen.add(name);
    // Optional: a proposer that omits it still yields a usable tag, just one
    // asked about by name alone. That was every tag's fate before this existed.
    const why = cleanName(record.why);
    tags.push(why ? { name, why } : { name });
  }
  return tags;
}

/**
 * Asks the server what to call the things in this library.
 *
 * -- which failures the caller can actually see --
 *
 * The route is `POST /api/ai/propose-taxonomy` (docs/ai.md, Contract). It is
 * session-guarded, so 401 is a real answer and the only thing that fixes it is
 * a re-sign-in. It answers *200 with empty arrays* when the proposer is not
 * configured or the upstream call failed, so "nothing to suggest" and "the
 * server has no proposer" are indistinguishable from the client — which is why
 * an empty list is reported as a legitimate decline and not an error, exactly
 * as `__none__` is a legitimate answer on the classify route.
 *
 * 503 and 429 are handled because they are the convention the sibling route
 * established (a missing TYPESAFE_API_KEY answers 503, a throttled upstream
 * 429) and both are states to *report* rather than to retry: neither is
 * something the user can fix, and the panel needs a specific sentence for each
 * instead of "something went wrong". Today neither can come back from this
 * route — `proposeTaxonomy()` swallows both into empty arrays — so they are
 * forward compatibility, and if the server ever adopts the convention the user
 * gets the right message rather than a blank list.
 */
export async function requestProposals(deps: AiTaxonomyDeps = {}): Promise<ProposalOutcome> {
  // The session first: a signed-out host is told that, rather than being sent
  // to find out it has no unfiled bookmarks to read.
  const session = await (deps.session ?? cloudSession)();
  if (!session) return { kind: "signed-out" };

  const [bookmarks, lists] = await Promise.all([NookDB.getAllBookmarks(), NookDB.getAllLists()]);
  const sample = selectSample(bookmarks, deps.sampleSize ?? TAXONOMY_SAMPLE_SIZE);
  // No request at all for an empty library: there is nothing to propose from,
  // and an empty answer would be indistinguishable from the proposer declining.
  if (sample.length === 0) return { kind: "nothing-to-read" };

  const doFetch: AiFetch = deps.fetch ?? ((input, init) => fetch(input, init));
  const apiUrl = (deps.apiUrl ?? cloudApiUrl()).replace(/\/$/, "");
  let response: Response;
  try {
    response = await doFetch(`${apiUrl}/api/ai/propose-taxonomy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
      body: JSON.stringify({
        sample: sample.map((bookmark) => ({ title: titleOf(bookmark), site: siteOf(bookmark) })),
        // Told what already exists so the model does not spend a name on it —
        // and so a duplicate is visible here rather than silently dropped.
        existingCollections: lists
          .map((list) => cleanName(list?.name))
          .filter((name) => name !== ""),
        maxCollections: PROPOSAL_MAX_COLLECTIONS,
        maxTags: PROPOSAL_MAX_TAGS,
        // Undefined is fine: the server defaults to "auto", and sending
        // `"auto"` explicitly would be the same request with a word in it.
        ...(deps.language && deps.language !== "auto" ? { language: deps.language } : {}),
      }),
    });
  } catch {
    // What cloud-sync calls a network error: the request never got an HTTP
    // reply, and it is the only state here that a retry can change.
    return { kind: "failed", message: "Could not reach the taxonomy proposal endpoint." };
  }

  if (response.status === 401) return { kind: "signed-out" };
  if (response.status === 503) return { kind: "unavailable" };
  if (response.status === 429 || response.status === 529) return { kind: "throttled" };
  if (!response.ok) return { kind: "failed", message: `The proposal request failed (${response.status}).` };

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // An unreadable body is an empty proposal, not a failure: the only safe
    // reading of an answer we cannot parse is that the model proposed nothing.
  }
  return { kind: "proposals", proposals: readProposals(body), sample, tags: readProposedTags(body) };
}
