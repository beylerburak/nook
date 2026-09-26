/**
 * Server side of search. See docs/retrieval.md for the architecture; the wire
 * types below are the "Search" section of that document and must stay identical
 * to it.
 *
 * Two signals, fused, because neither is sufficient (docs/retrieval.md,
 * "Search"): measured semantic-only search misses exact terms, and a substring
 * pass over the library returns nothing at all for six real Turkish and English
 * queries. The split that makes this file mostly pure is deliberate — the three
 * ranking steps are plain functions over plain arrays, so the arithmetic can be
 * tested without a database, and only the last function in the file touches `pg`.
 *
 * Like `ai.ts`, this file owns no secrets and holds no state. The one thing it
 * deliberately does NOT reimplement is the Turkish fold — see the note on the
 * import below, which is the highest-risk seam in this feature.
 */

import type { Pool, QueryResultRow } from "pg";
import { embeddingAvailability, foldForSearch } from "./embeddings.js";

/**
 * Every term and every filter value in this file goes through `foldForSearch`
 * from `embeddings.ts`, which is the function that wrote `search_text`. That
 * import is the whole defence against the highest-risk seam in this feature: a
 * fold that differs in one letter means the lexical half silently matches
 * nothing, with no error and no empty index to explain it.
 *
 * The cases that would break, from the bugs recorded in the extension's own
 * comments and asserted in `retrieval.unit.test.ts`:
 *
 * - `toLowerCase()` maps "İ" to "i" plus a combining dot above, so a query for
 *   "İş" would never match a column written from "İş".
 * - `toLocaleLowerCase("tr")` fixes that and breaks English ("AI" becomes "aı"),
 *   which is why the embedder folds per word.
 * - The column is accent-folded, so a query has to be too: "geliştirme" and
 *   "gelistirme" are the same term on the way in and only one of them is the
 *   spelling in the column.
 *
 * Re-exported, not copied, so there is one name for "how a term is folded" in
 * this workspace. A second copy would break search for exactly the users whose
 * library is Turkish, and nothing else would fail.
 */
export { foldForSearch };

// -- wire contract (docs/retrieval.md, "Search") --

export interface SearchRequest {
  q: string;
  limit: number;
  collections: string[];
  tags: string[];
  sources: string[];
}

export interface SearchResult {
  id: string;
  score: number;
  /** 1-based, or null when the lexical ranker did not place this id at all. */
  lexicalRank: number | null;
  /** 1-based, or null when the semantic ranker did not place this id at all. */
  semanticRank: number | null;
}

/**
 * Why the result set is smaller than the library, for the client to act on.
 *
 * `unconfigured` and `empty-index` mean the same thing to the UI — there is
 * nothing to search, so keep showing the local substring pass — but they are
 * different facts and a self-hosted operator reading a log needs to tell them
 * apart. `no-vector` is the one reason that can arrive *with* results: the index
 * is there and the exact matches were returned, but nothing was ranked by
 * meaning, so the list is lexical-only.
 */
export type SearchReason = "unconfigured" | "empty-index" | "no-vector" | "no-matches";

/**
 * `results` and `total` are the documented contract. `reason` is additive: the
 * degraded paths have to say *why* they are degraded, and there is nowhere else
 * in the contract to say it. A client that ignores it still works.
 *
 * `total` is the number of matches found, *before* `limit` sliced them, so the
 * UI can honestly say "showing 20 of 137" instead of implying a query hit 20
 * things.
 */
export interface SearchResponse {
  results: SearchResult[];
  total: number;
  reason?: SearchReason;
  /**
   * The candidate cap bound, so some rows were not scored at all.
   *
   * Reported rather than left implicit because the cap is a real correctness
   * limit, not just a performance one: it was silently dropping the newest
   * bookmarks before this field existed. A client cannot fix it, but an operator
   * reading a log — or a test — can now see it, and it is the documented trigger
   * for pgvector.
   */
  truncated?: boolean;
}

// -- constants --

/** The conventional RRF constant. Large enough that a rank-1 placement in one
 *  list is worth about as much as a rank-8 placement in the other, which is what
 *  stops a single signal from deciding the order. */
export const RRF_K = 60;

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/** Past this a query is not a search box entry, it is a paste of an article, and
 *  every term below becomes another scan over the index. */
const MAX_QUERY_CHARS = 500;
/** One `ILIKE` conjunct per term, so the count is the real cost driver. */
const MAX_QUERY_TERMS = 12;

/** A token with no letter and no digit in it is punctuation, not a word. */
const WORD = /[\p{L}\p{N}]/u;

/** A library can carry hundreds of tags and a long list of collections; a filter
 *  larger than this is a client bug, and rejecting it beats running it. */
const MAX_FILTER_VALUES = 50;
const MAX_FILTER_VALUE_CHARS = 200;

/**
 * Rows pulled back before the filters are applied.
 *
 * Filters are a *post*-filter (see `applyFilters`), so the facets are needed for
 * every surviving candidate and not just the top `limit` — that is the price of
 * not promoting the next-best hit when the best one is filtered out.
 *
 * **This number was 1,000, and that silently dropped the 47 newest bookmarks of
 * a 1,061-row library.** The reads order by `bookmark_id` for a stable tiebreak,
 * ids are snowflakes, and `LIMIT` then keeps the oldest rows and discards the
 * most recent — silently, because nothing reported it. Those are exactly the
 * bookmarks most likely to be searched for, and the ones most likely to be
 * longest, so the cap was also a length bias.
 *
 * 25,000 is high enough that it cannot bind on any library this product will see
 * and low enough to bound a runaway request. When it *does* bind the response
 * carries `truncated: true`, because a cap that is allowed to lie is worse than
 * no cap at all. This is also the honest trigger for pgvector: a full read is
 * ~190 MB of vectors at 25,000 rows, which is where brute force stops being free.
 */
const MAX_CANDIDATES = 25_000;

/**
 * Cosine below which a semantic hit is not a hit.
 *
 * Measured: a nonsense query ("847291") returned 1,047 results with a top hit
 * that was a post reading "ai legal", at 0.41. Cosine over a shared text encoder
 * does not go to zero for unrelated strings — a bare number still resembles every
 * other number, so "no match" is not the absence of similarity but its presence
 * at a low, meaningless level. Without a floor, typing nonsense looks like the
 * feature working. 0.40 cleared 3 of 3 nonsense queries in the same run that
 * cost exactly one real query, so it is a floor, not a threshold to tune.
 */
export const SEMANTIC_MIN_SCORE = 0.4;

/** The single reason a caller has to compare against. Everything else about
 *  availability is a log line, not an API. */
export const UNCONFIGURED_REASON = "unconfigured";

// -- small helpers --

function cleanText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Escapes the LIKE metacharacters in a term before it goes into an `ILIKE`
 * pattern.
 *
 * Not injection — the term is a bind parameter, so a quote in it is harmless —
 * but correctness. A bare `%` makes the whole index match and `_` matches any
 * character, so a query for `veri_tabanı` (or any URL) would return the library,
 * which is the same failure as the empty-term footgun in `rankLexical`, reached by
 * accident instead of by an empty list.
 */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Six decimals: RRF scores are ~0.016-0.033, so this is well below any
 *  meaningful precision and keeps the wire and the tests readable. Applied after
 *  the sort, so it can never create a tie that reorders two ids. */
function roundScore(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

// -- request validation --

/**
 * Structural validation only, in the style of `parseSyncRequest`: a thrown Error
 * becomes a 400 and its message is safe to hand back to the client.
 *
 * `limit` is clamped rather than rejected, because a client asking for 500 is
 * asking for "as many as you have", and answering with the first 100 is more
 * useful than an error. The array lengths are rejected rather than clamped: a
 * filter of 5,000 values is a client bug, and silently dropping 4,950 of them
 * would return confidently wrong results.
 */
export function parseSearchRequest(value: unknown): SearchRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid request");
  const body = value as Record<string, unknown>;

  const q = cleanText(body.q);
  if (!q) throw new Error("Invalid query");
  if (q.length > MAX_QUERY_CHARS) throw new Error("Query too long");
  if (q.split(/\s+/).filter(Boolean).length > MAX_QUERY_TERMS) throw new Error("Query has too many terms");

  return {
    q,
    limit: parseLimit(body.limit),
    collections: parseFilterValues(body.collections, "collections"),
    tags: parseFilterValues(body.tags, "tags"),
    sources: parseFilterValues(body.sources, "sources"),
  };
}

function parseLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid limit");
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(value)));
}

/** Entries that are not usable strings are dropped, not rejected: one bad value
 *  in a filter should cost that value, not the search. The *count* is still
 *  rejected, because a huge filter is a bug rather than a typo. */
function parseFilterValues(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`Invalid ${field} array`);
  if (value.length > MAX_FILTER_VALUES) throw new Error(`Too many ${field}`);
  const out: string[] = [];
  for (const entry of value) {
    const text = cleanText(entry);
    if (text) out.push(text.slice(0, MAX_FILTER_VALUE_CHARS));
  }
  return out;
}

// -- query terms --

export interface QueryTerms {
  /** Folded free-text terms, every one of which must match for a lexical hit. */
  terms: string[];
  /** `#tag` prefixes. */
  tags: string[];
  /** `@author` prefixes. */
  authors: string[];
}

/**
 * Splits a query into the terms the lexical half matches on, and routes the
 * `#tag` / `@author` prefixes away.
 *
 * The prefixes are routed out because they are exact and the client already
 * handles them locally against IndexedDB (docs/retrieval.md: "`@author` and
 * `#tag` prefixes stay local"). Two reasons not to treat them as terms: a `#`
 * prefix is not in `search_text` — the column holds the bare tag name — so an
 * `ILIKE '%#veri%'` matches nothing at all, which looks like a broken search
 * rather than a prefixed query; and a term the user meant as an exact tag filter
 * would be ANDed with the free text, quietly requiring both.
 *
 * Terms are folded, because `search_text` is folded. Deduped, because "veri
 * tabanı veri" must not become two identical `ILIKE` conjuncts.
 *
 * Capped at `MAX_QUERY_TERMS` and the prefixes are counted against it, because
 * every term is one more `ILIKE` over the column. `parseSearchRequest` rejects
 * the over-long query before it gets here with a message the client can show;
 * this cap is the backstop for a direct caller, not the user-facing limit.
 */
export function queryTerms(q: string): QueryTerms {
  const terms: string[] = [];
  const tags: string[] = [];
  const authors: string[] = [];
  const seen = new Set<string>();
  const total = () => terms.length + tags.length + authors.length;

  for (const raw of q.split(/\s+/)) {
    if (total() >= MAX_QUERY_TERMS) break;
    if (!raw) continue;
    if (raw.length > 1 && (raw[0] === "#" || raw[0] === "@")) {
      // Folded, and with the prefix stripped: the tag is stored and compared
      // without its `#` (see `normalizeTagName` in apps/extension/lib/ai-classify.ts).
      const value = foldForSearch(raw.slice(1).trim());
      if (!value || !WORD.test(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
      (raw[0] === "#" ? tags : authors).push(value);
      continue;
    }
    const term = foldForSearch(raw);
    // A token with no letter or digit is not a word. `search_text` is built from
    // words, so such a token can only ever produce a scan that matches nothing —
    // and "???" must not count toward the term cap that a real query needs.
    if (!term || !WORD.test(term) || seen.has(term)) continue;
    seen.add(term);
    terms.push(term);
  }

  return { terms, tags, authors };
}

// -- ranking --

export interface RankedId {
  id: string;
  /** 1-based position in the list that produced it. */
  rank: number;
}

export interface LexicalRow {
  id: string;
  /** Already folded by the embedder. */
  searchText: string;
}

/**
 * Pure lexical ranking: every term must appear in the row's `search_text`.
 *
 * AND, not OR, because that is the only reading of a phrase that is useful: a user
 * typing "veritabanı performans sorunu" wants documents about all three, and an
 * OR would return everything mentioning performance in any sense — which is
 * exactly the failure docs/retrieval.md measured in semantic-only search.
 *
 * An empty term list returns NOTHING, and that is the load-bearing line in this
 * function. `vacuously true` is the natural reading of "every term matches" and it
 * is a trap: a query that folded away to nothing ("#tag" only, or a query of pure
 * punctuation) would otherwise turn an unsearchable index into "return the whole
 * library, ranked by nothing". Failing closed costs an empty list; failing open
 * costs a user staring at 1,061 results.
 *
 * Rows are expected to be folded already, because that is what the column is. The
 * row text is lowercased defensively — a no-op for folded text, and the thing that
 * keeps a hand-written fixture from silently failing to match — but the
 * precondition is real and this function does not re-fold 1,061 rows per query to
 * work around it. `queryTerms` folds the query with the same function, so both
 * sides of every comparison are spelled the same way.
 *
 * Order within the list is the caller's row order, not a judgement made here. The
 * SQL reads the candidates ordered by `length(search_text)`, so the first match is
 * the shortest text containing every term — a free, deterministic relevance
 * signal, and one that never invents a score the doc does not claim.
 */
export function rankLexical(terms: string[], rows: LexicalRow[]): RankedId[] {
  if (terms.length === 0) return [];
  const needles = terms.map(foldForSearch).filter(Boolean);
  if (needles.length === 0) return [];

  const ranked: RankedId[] = [];
  for (const row of rows) {
    if (typeof row?.searchText !== "string") continue;
    const haystack = row.searchText.toLowerCase();
    let matchesAll = true;
    for (const needle of needles) {
      if (!haystack.includes(needle)) {
        matchesAll = false;
        break;
      }
    }
    if (matchesAll) ranked.push({ id: row.id, rank: ranked.length + 1 });
  }
  return ranked;
}

export interface SemanticRow {
  id: string;
  vector: number[];
}

/**
 * Pure cosine ranking.
 *
 * Defensively skipping rows, because the failure it prevents is silent and total:
 * one row whose vector is a different length than the query's, or contains a NaN
 * from a truncated insert, produces a NaN score, and `NaN` compares false against
 * everything — so it does not merely rank last, it corrupts the comparison for
 * whichever pair it is sorted against and the ordering of the whole list becomes
 * dependent on the sort implementation. `dim` is stored beside every vector and one
 * model per index is enforced by every query, so in practice this cannot happen;
 * "in practice" is not a guarantee about a hand-edited row.
 *
 * A zero vector has no direction, so its cosine is 0/0 and it is skipped for the
 * same reason. Scores at or below `minScore` are dropped.
 *
 * **This floor used to be 0, and that was wrong.** The justification was that
 * "a cosine of 0.44 is a correct top hit on this library" — which came from the
 * query "veritabanı performans sorunu" in docs/retrieval.md. A later measurement
 * established that nothing in this library is about database performance at all,
 * so that 0.44 was a coincidence being read as a result. The real behaviour
 * without a floor: a nonsense query ("847291") returned 1,047 results topped by
 * a post reading "ai legal". Cosine over a shared encoder never reaches zero for
 * unrelated text, so "no match" is not the absence of similarity but its
 * presence at a meaningless level, and the floor is what turns that back into
 * "no results". See SEMANTIC_MIN_SCORE.
 */
export function rankSemantic(
  queryVector: number[],
  rows: SemanticRow[],
  minScore = SEMANTIC_MIN_SCORE,
): RankedId[] {
  if (!Array.isArray(queryVector) || queryVector.length === 0) return [];
  let queryNorm = 0;
  for (const value of queryVector) {
    if (typeof value !== "number" || !Number.isFinite(value)) return [];
    queryNorm += value * value;
  }
  if (queryNorm === 0) return [];
  queryNorm = Math.sqrt(queryNorm);

  const scored: Array<{ id: string; score: number }> = [];
  for (const row of rows) {
    const vector = row?.vector;
    if (!Array.isArray(vector) || vector.length !== queryVector.length) continue;
    let dot = 0;
    let norm = 0;
    let usable = true;
    for (let i = 0; i < vector.length; i += 1) {
      const value = vector[i];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        usable = false;
        break;
      }
      dot += value * queryVector[i];
      norm += value * value;
    }
    if (!usable || norm === 0) continue;
    const score = dot / (queryNorm * Math.sqrt(norm));
    if (!Number.isFinite(score) || score <= minScore) continue;
    scored.push({ id: row.id, score });
  }

  // `Array.prototype.sort` is stable, so equal cosines keep the caller's row
  // order — which the semantic read pins with `ORDER BY bookmark_id`. A
  // non-deterministic tiebreak here would make two identical requests disagree.
  scored.sort((left, right) => right.score - left.score);
  return scored.map((entry, index) => ({ id: entry.id, rank: index + 1 }));
}

export interface FusedScore {
  id: string;
  /** Sum of `1 / (k + rank)` across the lists that placed this id. */
  score: number;
  /** `ranks[i]` is the 1-based rank in list `i`, or null if that list did not
   *  place it. Position in this array is the only thing that says which ranker
   *  is which, so the caller must keep its list order stable. */
  ranks: Array<number | null>;
}

/**
 * Reciprocal Rank Fusion: `1 / (k + rank)` per list, summed.
 *
 * Rank-based on purpose. One signal is a cosine in [-1, 1] and the other is a
 * boolean, so any weighted sum of the two raw scores would be a number calibrated
 * against a corpus nobody has re-measured since the last re-embed — and a
 * library where the query vector's scale changed would silently change the order.
 * Ranks do not have that problem: it only assumes that a list's own order is
 * meaningful, which is all either ranker promises.
 *
 * `k` is floored to a positive number because `1 / (k + rank)` with `k <= -1` is a
 * division by zero or a negative contribution, and this function has no business
 * throwing from a default argument.
 *
 * Ties are broken by the best single-list rank and then by id, so the same inputs
 * always produce the same order. Exact float ties are rare but not exotic — two
 * documents that embed identically, or a synthetic list — and a sort that returns
 * them in row order would make the response differ between two identical requests.
 */
export function fuseWithRRF(rankedLists: RankedId[][], k: number = RRF_K): FusedScore[] {
  const constant = Number.isFinite(k) && k > 0 ? k : RRF_K;
  const scores = new Map<string, { score: number; ranks: Array<number | null> }>();

  rankedLists.forEach((list, index) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!entry || typeof entry.id !== "string") continue;
      const rank = entry.rank;
      if (typeof rank !== "number" || !Number.isFinite(rank) || rank < 1) continue;
      const existing = scores.get(entry.id);
      const contribution = 1 / (constant + rank);
      if (existing) {
        existing.score += contribution;
        existing.ranks[index] = rank;
      } else {
        scores.set(entry.id, { score: contribution, ranks: withSlot(rankedLists.length, index, rank) });
      }
    }
  });

  return [...scores.entries()]
    .map(([id, entry]) => ({
      id,
      score: roundScore(entry.score),
      ranks: entry.ranks,
      bestRank: Math.min(...entry.ranks.map((rank) => rank ?? Number.MAX_SAFE_INTEGER)),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.bestRank - right.bestRank ||
        left.id.localeCompare(right.id),
    )
    .map(({ id, score, ranks }) => ({ id, score, ranks }));
}

/** One list longer than the others still needs a `ranks` array the same length,
 *  or `ranks[0]` and `ranks[1]` stop meaning what the caller thinks. */
function withSlot(length: number, index: number, rank: number): Array<number | null> {
  const ranks: Array<number | null> = new Array(length).fill(null);
  ranks[index] = rank;
  return ranks;
}

// -- filters --

/** What a bookmark is filtered on. Read out of `nook_records.data`, since
 *  `nook_embeddings` holds only the folded text and the vector. */
export interface Facets {
  collectionId: string | null;
  tags: string[];
  source: string | null;
  authorNames: string[];
}

export interface SearchFilters {
  collections: string[];
  tags: string[];
  sources: string[];
  /**
   * Not in the wire contract. Only an `@author` prefix inside `q` ever fills
   * this, and the client keeps that prefix local (docs/retrieval.md), so in
   * practice it is empty — it exists so an `@author` that does reach the server
   * is filtered rather than silently dropped.
   */
  authors?: string[];
}

export interface Filterable {
  facets: Facets;
}

function foldedSet(values: string[]): Set<string> {
  return new Set(values.map((value) => foldForSearch(value.trim())).filter(Boolean));
}

/**
 * Post-filters ranked results by collection, tag and source.
 *
 * THE HONEST CAVEAT: filtering happens *after* ranking, so a filtered-out top hit
 * does not promote the next one. Search for "veritabanı" inside a collection and
 * you get the best matches in the whole library with the wrong ones removed — not
 * the best matches in that collection. This is a deliberate trade, not an
 * oversight: filtering first would mean joining `nook_records` into the ranking
 * query, which is a different feature (a genuinely filtered search) and would
 * make the lexical pushdown in `searchBookmarks` pointless. The client already
 * filters by collection and tag locally and instantly, so the server's job here
 * is the ranking, and this function only narrows what is left of it.
 *
 * OR within a facet, AND across facets: that is what a filter UI means, and it is
 * what the client's own filtering does.
 *
 * Tags and authors compare folded on both sides, so "Türkçe", "türkçe" and
 * "TURKCE" are the same value; collections compare by id, which is already a
 * machine key; sources compare lowercased because they are a small enumerated set
 * ("x", "chrome"). A bookmark with no collection cannot match a non-empty
 * collection filter, which is also what the client's "Unorganised" view in reverse.
 */
export function applyFilters<T extends Filterable>(results: T[], filters: SearchFilters): T[] {
  const collections = new Set(filters.collections);
  const tags = foldedSet(filters.tags);
  const sources = new Set(filters.sources.map((value) => value.toLowerCase()));
  const authors = foldedSet(filters.authors ?? []);

  if (collections.size === 0 && tags.size === 0 && sources.size === 0 && authors.size === 0) {
    return results;
  }

  const kept: T[] = [];
  for (const result of results) {
    const facets = result.facets;
    if (!facets) continue;
    if (collections.size > 0 && !(facets.collectionId && collections.has(facets.collectionId))) continue;
    if (sources.size > 0 && !(facets.source && sources.has(facets.source.toLowerCase()))) continue;
    if (tags.size > 0 && !facets.tags.some((tag) => tags.has(foldForSearch(tag.trim())))) continue;
    if (authors.size > 0 && !facets.authorNames.some((name) => authors.has(foldForSearch(name.trim())))) continue;
    kept.push(result);
  }
  return kept;
}

// -- availability --

/**
 * Re-exported rather than reimplemented, for the same reason the fold is: the
 * search route and the search half must agree about which model a row would be
 * written under, or the query filters on a model nobody writes, and every search
 * comes back empty for a reason nothing in the response can explain.
 *
 * `EmbeddingAvailability` is the embedder's own type. It has no `reason` field,
 * and does not need one: see `searchBookmarks` on why there is exactly one
 * unavailable answer on the wire.
 */
export { embeddingAvailability };
export type { EmbeddingAvailability } from "./embeddings.js";

// -- the impure entry point --

export interface RetrievalDeps {
  /** Overridable so the unit tests never depend on the environment. */
  availability?: typeof embeddingAvailability;
  /**
   * Embeds the query string. Absent, or returning null/empty, means the query
   * cannot be ranked by meaning and the search runs lexical-only with
   * `reason: "no-vector"`.
   *
   * That degradation is the point rather than a fallback: exact term matching is
   * free and needs no provider, so a server that is mid-reindex — or one whose
   * embedding call is failing — still answers the searches it can answer instead
   * of returning nothing. It must not throw either: a provider blip during a
   * search is swallowed here and surfaced as `no-vector`, because a 500 on a
   * keystroke-driven search replaces results the user already had.
   */
  embedQuery?: (text: string) => Promise<number[] | null>;
}

export interface ScoredResult extends SearchResult {
  facets: Facets;
}

interface IndexRow {
  bookmark_id: string;
  search_text?: string;
  vector?: number[];
}

interface FacetRow {
  id: string;
  collection_id: string | null;
  tags: unknown;
  source: string | null;
  creator: unknown;
  quote_creator: unknown;
}

/**
 * The lexical half, pushed down into the query.
 *
 * Two things are happening on each side of the wire and it is worth being
 * explicit about which is which. SQL does the *matching*: one `ILIKE '%term%'` per
 * term, which keeps the row set to the documents that actually contain every
 * term. `rankLexical` does the *ranking* and the authoritative every-term check.
 * The overlap is deliberate — `rankLexical` re-verifies every term on rows that
 * already passed `ILIKE`, so the SQL is an optimisation and never the only thing
 * standing between a query and the whole library.
 *
 * `vector` is not selected here. The lexical ranker never looks at it, and at 768
 * floats a row it will not read is the difference between a few KB and several
 * MB, which is the entire reason the term filter is pushed down at all.
 */
function lexicalStatement(userId: string, model: string, terms: string[]): { text: string; values: unknown[] } {
  const conditions = terms.map((_, index) => `AND search_text ILIKE $${index + 3} ESCAPE '\\'`);
  return {
    text: `SELECT bookmark_id, search_text
      FROM nook_embeddings
      WHERE user_id = $1 AND model = $2 ${conditions.join(" ")}
      ORDER BY length(search_text), bookmark_id`,
    values: [userId, model, ...terms.map(likePattern)],
  };
}

/** Every row for this user and model, no term filter, `vector` included. This is
 *  the semantic candidate set: it MUST NOT be filtered by terms, because the whole
 *  point of the second signal is the document that does not contain the query's
 *  words (docs/retrieval.md). The hard cap bounds the response if a library ever
 *  outgrows the measured 1,061 rows.
 *
 *  Ordered by `bookmark_id` so equal-cosine rows fuse in a stable order. */
function semanticStatement(userId: string, model: string): { text: string; values: unknown[] } {
  return {
    text: `SELECT bookmark_id, vector
      FROM nook_embeddings
      WHERE user_id = $1 AND model = $2
      ORDER BY bookmark_id
      LIMIT $3`,
    values: [userId, model, MAX_CANDIDATES],
  };
}

/** The lexical-only path: the same rows as the semantic read minus the vectors.
 *  It is also the emptiness probe, which is why it is not term-filtered — an
 *  unfiltered read that returns nothing means the index for this user and model
 *  is empty, which is a different answer from "your query matched nothing". */
function plainStatement(userId: string, model: string): { text: string; values: unknown[] } {
  return {
    text: `SELECT bookmark_id, search_text
      FROM nook_embeddings
      WHERE user_id = $1 AND model = $2
      ORDER BY length(search_text), bookmark_id
      LIMIT $3`,
    values: [userId, model, MAX_CANDIDATES],
  };
}

/** Facets for the candidates only, and only the jsonb keys the filters need —
 *  `nook_embeddings` has no collection, tag, source or author column, so these
 *  have to come from the authoritative record.
 *
 *  `kind = 'bookmark'` excludes lists, and `deleted_at IS NULL` excludes
 *  soft-deleted bookmarks — whose embedding rows are not necessarily gone, since
 *  the embedder's reconciliation is about matching `content_hash`, not about
 *  tombstones. Without this a deleted bookmark can still be a top hit. */
const FACETS_SQL = `SELECT id,
      data->>'listId'          AS collection_id,
      data->'tags'             AS tags,
      data->>'source'          AS source,
      data->'creator'          AS creator,
      data->'quote'->'creator' AS quote_creator
    FROM nook_records
    WHERE user_id = $1 AND kind = 'bookmark' AND deleted_at IS NULL
      AND id = ANY($2::text[])`;

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  // pg parses jsonb into JS, but a column that arrives as a JSON string should
  // not cost the whole filter.
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
      return [];
    }
  }
  return [];
}

function authorNames(...creators: unknown[]): string[] {
  const names: string[] = [];
  for (const creator of creators) {
    const record = creator as { name?: unknown; handle?: unknown } | null;
    if (!record || typeof record !== "object") continue;
    for (const value of [record.name, record.handle]) {
      const text = cleanText(value);
      if (text && !names.includes(text)) names.push(text);
    }
  }
  return names;
}

function degrade(reason: SearchReason): SearchResponse {
  return { results: [], total: 0, reason };
}

/**
 * Search the index. Never throws for a degraded index: an unconfigured server, a
 * user whose library has not been embedded yet, and a provider that is down all
 * come back as an empty result set with a machine-readable `reason`, because the
 * client's answer in every one of those cases is the local substring pass it
 * already ran, and a 500 would replace the search the user had a second ago with
 * an error (docs/retrieval.md, "Client behaviour").
 *
 * A genuine database failure still propagates: that is a real outage, not a
 * degraded index, and swallowing it would make search look like a library with
 * nothing in it.
 */
export async function searchBookmarks(
  pool: Pool,
  userId: string,
  request: SearchRequest,
  deps: RetrievalDeps = {},
): Promise<SearchResponse> {
  // "Not available" has exactly one wire meaning: there is no index to search, so
  // keep the local substring pass. Whether the key is missing, the model is
  // unknown, or the user's rows have not been embedded yet is an operator's
  // problem, visible in the logs, and the client cannot act differently on any of
  // them.
  const availability = (deps.availability ?? embeddingAvailability)();
  if (!availability?.available) return degrade(UNCONFIGURED_REASON);

  const parsed = queryTerms(request.q);
  const filters: SearchFilters = {
    collections: request.collections,
    tags: [...request.tags, ...parsed.tags],
    sources: request.sources,
    authors: parsed.authors,
  };

  // The empty-term footgun, closed at the boundary: a query of nothing but
  // punctuation has no free text to match and nothing to filter by, so running
  // the lexical half on it would return the whole library ranked by nothing.
  // A query that is *only* a prefix ("#veri") is not this case — it is a filter
  // over the whole index, which is a legitimate full scan and what the client
  // does locally anyway.
  if (parsed.terms.length === 0 && !hasFilter(filters)) return degrade("no-matches");

  const queryVector = await embedQuerySafely(parsed.terms.join(" "), deps);

  let lexicalRows: LexicalRow[];
  let semanticRows: SemanticRow[] = [];

  if (queryVector) {
    // Two reads, and not one: the semantic read must see every row or it cannot
    // find the document that shares none of the query's words, and the lexical
    // read's whole purpose is to return a small row set. Fusing them into one
    // filtered read would mean either shipping every vector for a query that
    // matched three rows, or losing semantic recall. One extra round trip on a
    // 1,061-row table is the cheaper of the two.
    const all = await query<IndexRow>(pool, semanticStatement(userId, availability.model));
    if (all.length === 0) return degrade("empty-index");
    semanticRows = all.map(toSemanticRow);
    const matched = await query<IndexRow>(pool, lexicalStatement(userId, availability.model, parsed.terms));
    lexicalRows = matched.map(toLexicalRow);
  } else {
    // No vector, so no vector payload to keep small: one unfiltered read is both
    // the candidate set and the emptiness probe, and `rankLexical` does the
    // matching that the `ILIKE` conjuncts would otherwise have done.
    const all = await query<IndexRow>(pool, plainStatement(userId, availability.model));
    if (all.length === 0) return degrade("empty-index");
    lexicalRows = all.map(toLexicalRow);
  }

  // No terms means nothing to rank by, so the row order carries through as-is
  // (the SQL's `length(search_text)` order) and the filter does the work. NOT the
  // `rankLexical` footgun — that returns nothing for an empty term list on
  // purpose, and here the index is the candidate set by design rather than by
  // accident.
  const lexical = parsed.terms.length > 0
    ? rankLexical(parsed.terms, lexicalRows)
    : lexicalRows.map((row, index): RankedId => ({ id: row.id, rank: index + 1 }));
  const semantic = rankSemantic(queryVector ?? [], semanticRows);
  const fused = fuseWithRRF([lexical, semantic]);

  if (fused.length === 0) return degrade("no-matches");

  // A cap that binds is a correctness limit, so it is surfaced. `fused.length` is
  // bounded by the smaller of the two reads, so this catches either one.
  const truncated = fused.length > MAX_CANDIDATES;
  const candidates = fused.slice(0, MAX_CANDIDATES);
  const facetsById = await readFacets(pool, userId, candidates.map((entry) => entry.id));

  const scored: ScoredResult[] = [];
  for (const entry of candidates) {
    const facets = facetsById.get(entry.id);
    // A candidate with no row in nook_records is deleted or is a list, not a
    // bookmark. Dropping it here means it cannot survive a search as a result
    // the client then fails to resolve.
    if (!facets) continue;
    scored.push({
      id: entry.id,
      score: entry.score,
      lexicalRank: entry.ranks[0] ?? null,
      semanticRank: entry.ranks[1] ?? null,
      facets,
    });
  }

  const filtered = applyFilters(scored, filters);
  const results = filtered.slice(0, request.limit).map(toResult);
  let reason: SearchReason | undefined;
  if (results.length === 0) reason = "no-matches";
  // The one reason that arrives *with* results: the index is there and the exact
  // matches came back, but nothing was ranked by meaning.
  else if (!queryVector) reason = "no-vector";
  return {
    results,
    total: filtered.length,
    ...(reason ? { reason } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function hasFilter(filters: SearchFilters): boolean {
  return (
    filters.collections.length > 0 ||
    filters.tags.length > 0 ||
    filters.sources.length > 0 ||
    (filters.authors?.length ?? 0) > 0
  );
}

function toLexicalRow(row: IndexRow): LexicalRow {
  return { id: row.bookmark_id, searchText: typeof row.search_text === "string" ? row.search_text : "" };
}

function toSemanticRow(row: IndexRow): SemanticRow {
  return { id: row.bookmark_id, vector: Array.isArray(row.vector) ? row.vector : [] };
}

function toResult({ id, score, lexicalRank, semanticRank }: ScoredResult): SearchResult {
  return { id, score, lexicalRank, semanticRank };
}

async function embedQuerySafely(text: string, deps: RetrievalDeps): Promise<number[] | null> {
  // No terms means nothing to rank by meaning — a filter-only query — and the
  // provider is billed per token, so an empty string is not worth a round trip.
  if (!deps.embedQuery || !text) return null;
  try {
    const vector = await deps.embedQuery(text);
    return Array.isArray(vector) && vector.length > 0 ? vector : null;
  } catch (error) {
    // Never throws: see `RetrievalDeps.embedQuery`. Logged, because a provider
    // that fails on every query is a configuration problem an operator needs to
    // see, and a warning per keystroke is the right amount of it.
    console.warn(`[retrieval] query embedding failed; serving lexical only: ${errorMessage(error)}`);
    return null;
  }
}

async function query<T extends QueryResultRow>(
  pool: Pool,
  statement: { text: string; values: unknown[] },
): Promise<T[]> {
  const result = await pool.query<T>(statement.text, statement.values);
  return result?.rows ?? [];
}

async function readFacets(pool: Pool, userId: string, ids: string[]): Promise<Map<string, Facets>> {
  if (ids.length === 0) return new Map();
  const rows = await query<FacetRow>(pool, { text: FACETS_SQL, values: [userId, ids] });
  const facets = new Map<string, Facets>();
  for (const row of rows) {
    facets.set(row.id, {
      collectionId: cleanText(row.collection_id) ?? null,
      tags: toStringArray(row.tags),
      source: cleanText(row.source) ?? null,
      authorNames: authorNames(row.creator, row.quote_creator),
    });
  }
  return facets;
}
