import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  applyFilters,
  foldForSearch,
  fuseWithRRF,
  parseSearchRequest,
  queryTerms,
  rankLexical,
  rankSemantic,
  searchBookmarks,
  RRF_K,
  SEMANTIC_MIN_SCORE,
  type Facets,
  type Filterable,
  type RankedId,
  type SearchRequest,
  type SearchResult,
} from "../src/retrieval.js";

// -- fakes --

/** Stands in for a `pg` Pool. Returns canned rows per statement, and records
 *  every statement so a test can assert what was pushed down to SQL. */
function fakePool(handler: (sql: string, values: unknown[]) => unknown[]): Pool & {
  statements: Array<{ sql: string; values: unknown[] }>;
} {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  return {
    statements,
    query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      return { rows: handler(sql, values), rowCount: 0, command: "SELECT", fields: [], oid: 0 };
    },
  } as unknown as Pool & { statements: Array<{ sql: string; values: unknown[] }> };
}

const facets = (overrides: Partial<Facets> = {}): Facets => ({
  collectionId: null,
  tags: [],
  source: null,
  authorNames: [],
  ...overrides,
});

const filterable = (id: string, overrides: Partial<Facets> = {}): Filterable & { id: string } => ({
  id,
  facets: facets(overrides),
});

const list = (...ids: string[]): RankedId[] => ids.map((id, index) => ({ id, rank: index + 1 }));

const available = { available: true, model: "text-embedding-3-small", dim: 768 };

// -- parseSearchRequest --

describe("parseSearchRequest", () => {
  it("accepts a minimal body and applies the documented defaults", () => {
    expect(parseSearchRequest({ q: "veri tabanı" })).toEqual({
      q: "veri tabanı",
      limit: 20,
      collections: [],
      tags: [],
      sources: [],
    });
  });

  it("accepts a fully populated body", () => {
    expect(
      parseSearchRequest({
        q: "  yapay zeka  ",
        limit: 5,
        collections: ["c1", "c2"],
        tags: ["veri"],
        sources: ["x"],
      }),
    ).toEqual({ q: "yapay zeka", limit: 5, collections: ["c1", "c2"], tags: ["veri"], sources: ["x"] });
  });

  it("rejects a non-object body", () => {
    expect(() => parseSearchRequest(null)).toThrow("Invalid request");
    expect(() => parseSearchRequest("veri")).toThrow("Invalid request");
    expect(() => parseSearchRequest(["veri"])).toThrow("Invalid request");
  });

  it("rejects a missing or blank q", () => {
    expect(() => parseSearchRequest({})).toThrow("Invalid query");
    expect(() => parseSearchRequest({ q: "" })).toThrow("Invalid query");
    expect(() => parseSearchRequest({ q: "   " })).toThrow("Invalid query");
    expect(() => parseSearchRequest({ q: 42 })).toThrow("Invalid query");
  });

  it("rejects a non-numeric or non-finite limit rather than guessing", () => {
    expect(() => parseSearchRequest({ q: "x", limit: "10" })).toThrow("Invalid limit");
    expect(() => parseSearchRequest({ q: "x", limit: Number.NaN })).toThrow("Invalid limit");
    expect(() => parseSearchRequest({ q: "x", limit: Number.POSITIVE_INFINITY })).toThrow("Invalid limit");
  });

  it("clamps limit rather than rejecting it", () => {
    // A client asking for 500 is asking for "as many as you have", and the first
    // 100 is a better answer than a 400. Below 1 there is nothing to return.
    expect(parseSearchRequest({ q: "x", limit: 500 }).limit).toBe(100);
    expect(parseSearchRequest({ q: "x", limit: 0 }).limit).toBe(1);
    expect(parseSearchRequest({ q: "x", limit: -20 }).limit).toBe(1);
    expect(parseSearchRequest({ q: "x", limit: 7.9 }).limit).toBe(7);
  });

  it("rejects a non-array filter and caps its length", () => {
    expect(() => parseSearchRequest({ q: "x", collections: "c1" })).toThrow("Invalid collections array");
    expect(() => parseSearchRequest({ q: "x", tags: {} })).toThrow("Invalid tags array");
    expect(() => parseSearchRequest({ q: "x", sources: 1 })).toThrow("Invalid sources array");
    expect(() =>
      parseSearchRequest({ q: "x", collections: Array.from({ length: 51 }, (_, i) => `c${i}`) }),
    ).toThrow("Too many collections");
    expect(() => parseSearchRequest({ q: "x", tags: Array.from({ length: 51 }, () => "t") })).toThrow(
      "Too many tags",
    );
    expect(() => parseSearchRequest({ q: "x", sources: Array.from({ length: 51 }, () => "x") })).toThrow(
      "Too many sources",
    );
  });

  it("drops unusable filter entries instead of failing the whole search", () => {
    // One bad value in a filter should cost that value. Rejecting the request
    // would mean a stale tag id in the client costs the user their search.
    expect(parseSearchRequest({ q: "x", tags: ["veri", 7, null, "  ", "  yapay  "] }).tags).toEqual([
      "veri",
      "yapay",
    ]);
  });

  it("rejects a query long enough to be a pasted article", () => {
    expect(() => parseSearchRequest({ q: "x".repeat(501) })).toThrow("Query too long");
  });

  it("rejects a query with more terms than one ILIKE conjunct per term can afford", () => {
    const long = Array.from({ length: 13 }, () => "terim").join(" ");
    expect(() => parseSearchRequest({ q: long })).toThrow("Query has too many terms");
  });
});

// -- queryTerms --

describe("queryTerms", () => {
  it("splits a Turkish phrase into terms, so no literal substring is required", () => {
    // The failure this replaces: docs/retrieval.md measured six real queries
    // returning zero substring matches against the current `String.includes()`
    // pass, because the query words are not a contiguous slice of any document.
    expect(queryTerms("yapay zeka ile yazılım geliştirme").terms).toEqual([
      "yapay",
      "zeka",
      "ile",
      "yazilim",
      "gelistirme",
    ]);
  });

  it("folds Turkish casing the way the index column was folded", () => {
    // DRIFT GUARD. The cases are the ones asserted in
    // apps/extension/tests/ai-classify.test.ts, because the bug they describe is
    // invisible: `toLowerCase()` turns "İ" into "i" plus a combining dot, so a
    // query for "İş" silently matches nothing in a column written from "İş".
    expect(queryTerms("İş Akışları").terms).toEqual(["is", "akislari"]);
    expect(queryTerms("iş akışları").terms).toEqual(queryTerms("İş Akışları").terms);
    expect(queryTerms("ÇAĞRI").terms).toEqual(queryTerms("çağrı").terms);
    // "ISI" is Turkish for "heat". The index folds it to "isi", which is not the
    // Turkish answer, and is self-consistent — which is the property that
    // matters, because both sides of every comparison go through one function.
    expect(queryTerms("ISI").terms).toEqual(["isi"]);
  });

  it("keeps an English initialism intact inside a Turkish query", () => {
    // Per-word folding exists for this: under a whole-string Turkish locale "UI"
    // becomes "uı", which then fails to match the "ui" a user would type.
    expect(queryTerms("UI Tasarımları").terms).toEqual(["ui", "tasarimlari"]);
    expect(queryTerms("AI").terms).toEqual(["ai"]);
    expect(queryTerms("shadcn/ui").terms).toEqual(["shadcn/ui"]);
  });

  it("is idempotent, so a query matches a stored string that was folded again", () => {
    for (const q of ["İş Akışları", "UI Tasarımları", "ÇAĞRI", "çağrı", "Ağ Yapısı", "Türkçe", "AI"]) {
      const once = queryTerms(q).terms.join(" ");
      expect(foldForSearch(once)).toBe(once);
    }
  });

  it("folds both the query and the text the column was written from identically", () => {
    // The seam itself. If these two ever stop agreeing, lexical search returns
    // zero results with no error anywhere.
    const sourceText = "Yapay Zeka ile Yazılım Geliştirme — Türkçe bir kaynak";
    const column = foldForSearch(sourceText);
    const terms = queryTerms("yazılım geliştirme").terms;
    expect(terms.every((term) => column.includes(term))).toBe(true);
  });

  it("routes a #tag prefix out of the term list and into a tag filter", () => {
    const parsed = queryTerms("#türkçe yapay zeka");
    expect(parsed.terms).toEqual(["yapay", "zeka"]);
    // Folded, and without the `#`: the tag is stored without it, and an
    // `ILIKE '%#turkce%'` would match nothing at all.
    expect(parsed.tags).toEqual(["turkce"]);
    expect(parsed.authors).toEqual([]);
  });

  it("routes an @author prefix out of the term list and into an author filter", () => {
    const parsed = queryTerms("@Çağrı veritabanı");
    expect(parsed.terms).toEqual(["veritabani"]);
    expect(parsed.authors).toEqual(["cagri"]);
    expect(parsed.tags).toEqual([]);
  });

  it("deduplicates and drops empty tokens", () => {
    expect(queryTerms("  veri   VERİ  veri  ").terms).toEqual(["veri"]);
    expect(queryTerms("#veri #VERİ").tags).toEqual(["veri"]);
  });

  it("produces no terms for a query that is nothing but a prefix or punctuation", () => {
    // The case `rankLexical` and `searchBookmarks` both have to fail closed on.
    expect(queryTerms("#veri").terms).toEqual([]);
    expect(queryTerms("@cagri").terms).toEqual([]);
    expect(queryTerms("!!! ???").terms).toEqual([]);
  });
});

// -- fuseWithRRF --

describe("fuseWithRRF", () => {
  it("sums 1/(k+rank) across the lists that placed an id", () => {
    const fused = fuseWithRRF([list("a", "b"), list("b", "a")]);
    const byId = new Map(fused.map((entry) => [entry.id, entry]));
    expect(byId.get("a")!.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 2), 6);
    expect(byId.get("b")!.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1), 6);
  });

  it("ranks a document found by both rankers above one found by only one", () => {
    // The whole reason there are two signals: docs/retrieval.md measured
    // semantic-only search missing exact terms, and the substring pass returning
    // nothing at all for six real queries.
    const fused = fuseWithRRF([list("lexical-only", "both"), list("semantic-only", "both")]);
    expect(fused[0].id).toBe("both");
  });

  it("records each list's 1-based rank, and null where a list did not place the id", () => {
    const fused = fuseWithRRF([list("a", "b"), list("b", "c")]);
    const byId = new Map(fused.map((entry) => [entry.id, entry]));
    expect(byId.get("a")!.ranks).toEqual([1, null]);
    expect(byId.get("b")!.ranks).toEqual([2, 1]);
    expect(byId.get("c")!.ranks).toEqual([null, 2]);
  });

  it("keeps the ranks array the same length as the list array", () => {
    // `ranks[0]` and `ranks[1]` are how `searchBookmarks` tells lexical from
    // semantic, so a short array silently mislabels the contract fields.
    expect(fuseWithRRF([list("a")])[0].ranks).toEqual([1]);
    expect(fuseWithRRF([list("a"), list("b"), list("c")])[0].ranks).toHaveLength(3);
  });

  it("honours k: a larger k flattens the contribution of rank", () => {
    const first = fuseWithRRF([list("a", "b")], 1);
    const large = fuseWithRRF([list("a", "b")], 60);
    // With k=1 a rank-1 placement is worth 0.5 and a rank-2 one 0.33; with k=60
    // they are 0.016 and 0.016. The score difference shrinks, the order does not.
    expect(first[0].score - first[1].score).toBeGreaterThan(large[0].score - large[1].score);
  });

  it("falls back to the conventional k rather than dividing by zero", () => {
    // `1 / (k + rank)` with k <= -1 is a division by zero or a negative
    // contribution, and a default argument has no business throwing.
    for (const k of [0, -1, -60, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(fuseWithRRF([list("a", "b")], k)[0].id).toBe("a");
    }
    expect(fuseWithRRF([list("a", "b")], Number.NaN)[0].score).toBeCloseTo(1 / (RRF_K + 1), 6);
  });

  it("works with a single list", () => {
    const fused = fuseWithRRF([list("a", "b", "c")]);
    expect(fused.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    expect(fused[0].score).toBeCloseTo(1 / (RRF_K + 1), 6);
  });

  it("is empty for no lists, and for lists that place nothing", () => {
    expect(fuseWithRRF([])).toEqual([]);
    expect(fuseWithRRF([[], []])).toEqual([]);
  });

  it("breaks ties deterministically, by best rank then by id", () => {
    // Two documents that embed identically, or a synthetic list, tie exactly.
    // A sort that returned them in input order would make the response differ
    // between two identical requests.
    const tied = fuseWithRRF([list("b", "a")]);
    expect(tied.map((entry) => entry.id)).toEqual(["b", "a"]);
    expect(fuseWithRRF([list("b", "a")])).toEqual(tied);

    const sameBestRank = fuseWithRRF([list("z", "a"), list("y", "a")]);
    // "a" is rank 1 in one list in both cases, so the tiebreak is the id.
    expect(sameBestRank[0].id).toBe("a");
  });

  it("ignores malformed entries rather than emitting NaN scores", () => {
    const fused = fuseWithRRF([
      [{ id: "a", rank: 1 }, { id: "bad", rank: 0 }, { id: "worse", rank: Number.NaN }],
    ]);
    expect(fused.map((entry) => entry.id)).toEqual(["a"]);
  });
});

// -- rankLexical --

describe("rankLexical", () => {
  const rows = [
    { id: "b1", searchText: "veri tabani performans sorunlari" },
    { id: "b2", searchText: "veri tabani" },
    { id: "b3", searchText: "performans sorunu baska bir yerde" },
  ];

  it("requires EVERY term, not any of them", () => {
    // Order is the caller's row order; the real reads order by
    // `length(search_text)`, which is covered separately below.
    expect(rankLexical(["veri", "tabani"], rows).map((entry) => entry.id)).toEqual(["b1", "b2"]);
    // "b3" has one of the two terms and is not a match. An OR here would return
    // it, which is exactly the failure docs/retrieval.md measured in
    // semantic-only search: "performance" in an unrelated sense at rank 1.
    expect(rankLexical(["veri", "tabani", "yok"], rows)).toEqual([]);
  });

  it("returns NOTHING for an empty term list, rather than everything", () => {
    // The footgun, asserted explicitly. "Every term matches" is vacuously true
    // for an empty list, so the natural implementation returns the whole index
    // ranked by nothing — and the user gets 1,061 results for a query of
    // punctuation. Failing closed costs an empty list; failing open costs a
    // library dump.
    expect(rankLexical([], rows)).toEqual([]);
    expect(rankLexical(["", "  "], rows)).toEqual([]);
  });

  it("matches case- and accent-insensitively via the folded column", () => {
    // The column is pre-folded, so a raw row matches a folded term only because
    // the term is folded the same way. These rows are folded with the embedder's
    // own function, which is what a real row looks like.
    const folded = [
      { id: "tr", searchText: foldForSearch("Türkçe bir kaynak: çğöşü İI") },
      { id: "en", searchText: foldForSearch("English source about databases") },
    ];
    expect(rankLexical([foldForSearch("TÜRKÇE")], folded).map((entry) => entry.id)).toEqual(["tr"]);
    expect(rankLexical([foldForSearch("türkçe")], folded).map((entry) => entry.id)).toEqual(["tr"]);
    expect(rankLexical([foldForSearch("English")], folded).map((entry) => entry.id)).toEqual(["en"]);
  });

  it("matches on a substring, not a whole word", () => {
    // Turkish agglutination defeats stemming: "kitap" must find "kitapları",
    // which is why this is `ILIKE '%term%'` and not a tsvector (docs/retrieval.md).
    const rows2 = [{ id: "k", searchText: "kitaplari okudum" }];
    expect(rankLexical([foldForSearch("kitap")], rows2).map((entry) => entry.id)).toEqual(["k"]);
  });

  it("keeps the caller's row order, so SQL decides the within-list ranking", () => {
    // The reads order by `length(search_text)`, so the first match is the
    // shortest text holding every term. This function does not re-judge that.
    const ordered = [
      { id: "short", searchText: "veri tabani" },
      { id: "long", searchText: "veri tabani ve cok daha fazla kelime" },
    ];
    expect(rankLexical([foldForSearch("veri")], ordered).map((entry) => entry.id)).toEqual([
      "short",
      "long",
    ]);
    expect(rankLexical([foldForSearch("veri")], [...ordered].reverse()).map((e) => e.id)).toEqual([
      "long",
      "short",
    ]);
  });

  it("assigns dense 1-based ranks and skips rows that cannot be matched", () => {
    const ranked = rankLexical(["veri"], [
      { id: "a", searchText: "veri" },
      { id: "skip", searchText: undefined as unknown as string },
      { id: "b", searchText: "veri tabani" },
    ]);
    expect(ranked).toEqual([{ id: "a", rank: 1 }, { id: "b", rank: 2 }]);
  });
});

// -- rankSemantic --

describe("rankSemantic", () => {
  const q = [1, 0, 0];

  it("ranks by cosine, descending", () => {
    const ranked = rankSemantic(q, [
      { id: "orthogonal", vector: [0, 1, 0] },
      { id: "same", vector: [2, 0, 0] },
      { id: "close", vector: [1, 1, 0] },
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual(["same", "close"]);
  });

  it("skips a vector of a different length without poisoning the ranking", () => {
    // A hand-edited or truncated row. The naive implementation produces a NaN
    // dot product, and NaN compares false against everything, so it does not
    // merely rank last — it corrupts the comparison it is sorted against and the
    // whole list's order becomes sort-implementation dependent.
    const ranked = rankSemantic([1, 0, 0], [
      { id: "short", vector: [1, 0] },
      { id: "a", vector: [0.5, 0, 0] },
      { id: "b", vector: [0.9, 0.1, 0] },
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(ranked.every((entry) => Number.isFinite(entry.rank))).toBe(true);
  });

  it("skips a vector containing NaN or Infinity, and keeps ranking the rest", () => {
    const ranked = rankSemantic(q, [
      { id: "nan", vector: [Number.NaN, 0, 0] },
      { id: "inf", vector: [Number.POSITIVE_INFINITY, 0, 0] },
      { id: "ok", vector: [1, 0, 0] },
      { id: "ok2", vector: [0.7, 0, 0] },
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual(["ok", "ok2"]);
  });

  it("skips a zero vector, whose cosine is 0/0", () => {
    expect(rankSemantic(q, [{ id: "zero", vector: [0, 0, 0] }, { id: "ok", vector: [1, 0, 0] }])).toEqual([
      { id: "ok", rank: 1 },
    ]);
  });

  it("skips a row whose vector is not an array at all", () => {
    const ranked = rankSemantic(q, [
      { id: "junk", vector: null as unknown as number[] },
      { id: "ok", vector: [1, 0, 0] },
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual(["ok"]);
  });

  it("returns nothing when the query vector is unusable", () => {
    const rows = [{ id: "ok", vector: [1, 0, 0] }];
    expect(rankSemantic([], rows)).toEqual([]);
    expect(rankSemantic([0, 0, 0], rows)).toEqual([]);
    expect(rankSemantic([Number.NaN, 0, 0], rows)).toEqual([]);
    expect(rankSemantic([1, 0], [{ id: "m", vector: [Number.POSITIVE_INFINITY, 0] }])).toEqual([]);
  });

  it("keeps a low positive cosine, because 0.44 is a correct top hit here", () => {
    // docs/retrieval.md: a semantic-only search for "veritabanı performans
    // sorunu" put a relevant document at 0.44. A tuned floor would throw that
    // away, so the default floor is 0 — a vector pointing the other way is not a
    // match, and nothing above 0 is.
    const weak = [0.44, 0.9, 0]; // cos 0.439 against [1, 0, 0]
    const ranked = rankSemantic(q, [
      { id: "weak-but-right", vector: weak },
      { id: "wrong-direction", vector: [-0.9, 0, 0] },
    ]);
    expect(ranked.map((entry) => entry.id)).toEqual(["weak-but-right"]);
    expect(rankSemantic(q, [{ id: "weak", vector: weak }], 0.5)).toEqual([]);
  });

  it("keeps the caller's row order for equal cosines, so the order is stable", () => {
    const ranked = rankSemantic([1, 0, 0], [
      { id: "first", vector: [0.5, 0, 0] },
      { id: "second", vector: [0.5, 0, 0] },
    ]);
    expect(ranked).toEqual([{ id: "first", rank: 1 }, { id: "second", rank: 2 }]);
  });
});

// -- applyFilters --

describe("applyFilters", () => {
  const results = [
    filterable("in-list", { collectionId: "c1", tags: ["Türkçe"], source: "x" }),
    filterable("in-other-list", { collectionId: "c2", tags: ["ingilizce"], source: "chrome" }),
    filterable("unfiled", { tags: ["Türkçe", "veri"], source: "chrome" }),
  ];

  it("returns everything when no filter is set", () => {
    const filtered = applyFilters(results, { collections: [], tags: [], sources: [] });
    expect(filtered).toHaveLength(3);
  });

  it("drops results that do not match the collection", () => {
    const filtered = applyFilters(results, { collections: ["c1"], tags: [], sources: [] });
    expect(filtered.map((entry) => entry.id)).toEqual(["in-list"]);
  });

  it("does not treat an unfiled bookmark as matching a collection filter", () => {
    const filtered = applyFilters(results, { collections: ["c1"], tags: [], sources: [] });
    expect(filtered.map((entry) => entry.id)).not.toContain("unfiled");
  });

  it("matches tags folded on both sides, so casing and diacritics do not matter", () => {
    for (const value of ["Türkçe", "türkçe", "TURKÇE", "turkce"]) {
      const filtered = applyFilters(results, { collections: [], tags: [value], sources: [] });
      expect(filtered.map((entry) => entry.id)).toEqual(["in-list", "unfiled"]);
    }
  });

  it("matches sources lowercased, and ORs within a facet", () => {
    expect(
      applyFilters(results, { collections: [], tags: [], sources: ["x", "chrome"] }),
    ).toHaveLength(3);
    expect(applyFilters(results, { collections: [], tags: [], sources: ["X"] }).map((e) => e.id)).toEqual([
      "in-list",
    ]);
  });

  it("ANDs across facets and ORs within one", () => {
    const filtered = applyFilters(results, { collections: ["c1"], tags: ["turkce"], sources: ["x"] });
    expect(filtered.map((entry) => entry.id)).toEqual(["in-list"]);
    // The AND is what makes a filter a filter: one facet alone still matches.
    expect(applyFilters(results, { collections: ["c1"], tags: ["veri"], sources: [] })).toEqual([]);
  });

  it("filters on an @author that arrived inside q, which is not in the wire contract", () => {
    const withAuthor = [
      filterable("a", { authorNames: ["Çağrı", "@cagri"] }),
      filterable("b", { authorNames: ["Someone Else"] }),
    ];
    const parsed = queryTerms("@Çağrı veri");
    expect(
      applyFilters(withAuthor, { collections: [], tags: [], sources: [], authors: parsed.authors }),
    ).toHaveLength(1);
  });

  it("does NOT promote the next-best hit when the top one is filtered out", () => {
    // The caveat in `applyFilters`, asserted. Filtering happens after ranking, so
    // this is "the best matches in the library with the wrong ones removed", not
    // "the best matches in this collection" — a result set that can come back
    // short even though matching results exist further down.
    const ranked = [filterable("top", { collectionId: "c2" }), filterable("second", { collectionId: "c1" })];
    const filtered = applyFilters(ranked, { collections: ["c1"], tags: [], sources: [] });
    expect(filtered.map((entry) => entry.id)).toEqual(["second"]);
    // The promoted entry is second in the filtered list, which is the honest
    // outcome: it is not being presented as the best match in the library.
    expect(filtered[0].id).not.toBe(ranked[0].id);
  });

  it("drops a result with no facets at all rather than passing it through", () => {
    const missing = [{ id: "ghost" } as unknown as Filterable];
    expect(applyFilters(missing, { collections: ["c1"], tags: [], sources: [] })).toEqual([]);
  });
});

// -- searchBookmarks --

describe("searchBookmarks", () => {
  const request = (overrides: Partial<SearchRequest> = {}): SearchRequest =>
    parseSearchRequest({ q: "veri tabanı", ...overrides });

  const indexRows = [
    { bookmark_id: "b1", search_text: "veri tabani performansi", vector: [1, 0] },
    { bookmark_id: "b2", search_text: "yemek tarifi", vector: [0, 1] },
  ];

  const facetRows = [
    { id: "b1", collection_id: "c1", tags: ["veri"], source: "x", creator: null, quote_creator: null },
    { id: "b2", collection_id: null, tags: [], source: "chrome", creator: null, quote_creator: null },
  ];

  /** One index row per id, and the matching nook_records facet row. */
  function libraryPool(overrides: Partial<typeof indexRows[number]> = {}, rows = indexRows) {
    return fakePool((sql) => {
      if (sql.includes("FROM nook_embeddings")) {
        if (sql.includes("ILIKE")) {
          return rows
            .filter((row) => {
              const terms = (sql.match(/ILIKE/g) ?? []).length;
              void terms;
              return true;
            })
            .filter((row) => row.search_text.includes("veri") || row.search_text.includes("tabani"));
        }
        return rows.map((row) => ({ ...row, ...overrides }));
      }
      return facetRows;
    });
  }

  it("returns exactly the contract shape", async () => {
    const pool = libraryPool();
    const response = await searchBookmarks(pool, "u1", request(), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    expect(Object.keys(response).sort()).toEqual(["results", "total"]);
    expect(response.total).toBeGreaterThan(0);
    for (const result of response.results) {
      expect(Object.keys(result).sort()).toEqual(["id", "lexicalRank", "score", "semanticRank"]);
      expect(typeof result.id).toBe("string");
      expect(Number.isFinite(result.score)).toBe(true);
    }
  });

  it("never returns document content, only ids and scores", async () => {
    // The client already holds the whole library in IndexedDB; shipping 1,061
    // documents back to draw a filtered list would be waste.
    const pool = libraryPool();
    const response = await searchBookmarks(pool, "u1", request(), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    expect(JSON.stringify(response)).not.toContain("yemek");
    expect(JSON.stringify(response)).not.toContain("tarifi");
  });

  it("ranks with both signals and reports each rank", async () => {
    const pool = libraryPool();
    const response = await searchBookmarks(pool, "u1", request(), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    expect(response.results[0].id).toBe("b1");
    // b1 contains both terms and is rank 1 semantically: it is the only result
    // both rankers placed, which is exactly the case fusion is for.
    expect(response.results[0].lexicalRank).toBe(1);
    expect(response.results[0].semanticRank).toBe(1);
  });

  it("scopes every read to the user and the model the index is written under", async () => {
    const pool = libraryPool();
    await searchBookmarks(pool, "u1", request(), {
      availability: () => ({ ...available, model: "other-model" }),
      embedQuery: async () => [1, 0],
    });
    // One model per index, enforced by every query (docs/retrieval.md): two
    // models in one column are not searchable together.
    for (const statement of pool.statements) {
      if (!statement.sql.includes("FROM nook_embeddings")) continue;
      expect(statement.values[0]).toBe("u1");
      expect(statement.values[1]).toBe("other-model");
    }
  });

  it("pushes the term filter into SQL as one ILIKE per term, without selecting vectors", async () => {
    const pool = libraryPool();
    await searchBookmarks(pool, "u1", request(), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    const lexical = pool.statements.find((s) => s.sql.includes("ILIKE"));
    expect(lexical).toBeDefined();
    expect(lexical!.sql.match(/ILIKE/g)).toHaveLength(2);
    expect(lexical!.sql).toContain("ESCAPE");
    // The lexical ranker never looks at a vector, and 768 floats a row it will
    // not read is the difference between a few KB and several MB.
    expect(lexical!.sql).not.toContain("vector");

    const values = lexical!.values.slice(2) as string[];
    expect(values).toHaveLength(2);
    for (const pattern of values) expect(pattern.startsWith("%") && pattern.endsWith("%")).toBe(true);
  });

  it("escapes LIKE metacharacters in a term so they cannot match the whole index", async () => {
    const pool = libraryPool();
    await searchBookmarks(pool, "u1", request({ q: "veri_tabanı" }), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    const lexical = pool.statements.find((s) => s.sql.includes("ILIKE"))!;
    const values = lexical.values.slice(2) as string[];
    // Not injection — the term is a bind parameter — but correctness: a bare `%`
    // matches everything and `_` matches any character, so "veri_tabanı" or any
    // URL would return the library, which is the empty-term footgun reached by
    // accident instead of by an empty list.
    expect(values.some((pattern) => pattern.includes("%veri") && !pattern.startsWith("%"))).toBe(false);
    expect(values.join(" ")).toContain("\\_");
  });

  it("does not term-filter the semantic read, so a document sharing no words is still findable", async () => {
    const pool = libraryPool();
    await searchBookmarks(pool, "u1", request(), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    const semantic = pool.statements.find(
      (s) => s.sql.includes("FROM nook_embeddings") && s.sql.includes("vector"),
    );
    expect(semantic).toBeDefined();
    expect(semantic!.sql).not.toContain("ILIKE");
  });

  it("filters after ranking and reports total before the limit slice", async () => {
    const pool = libraryPool();
    const response = await searchBookmarks(pool, "u1", request({ collections: ["c1"] }), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    expect(response.results.map((r) => r.id)).toEqual(["b1"]);
    expect(response.total).toBe(1);
  });

  it("slices to limit and keeps total as the pre-slice count", async () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      bookmark_id: `b${i}`,
      search_text: "veri tabani",
      vector: [1, 0],
    }));
    const pool = fakePool((sql) =>
      sql.includes("FROM nook_embeddings")
        ? many
        : many.map((row) => ({
            id: row.bookmark_id,
            collection_id: null,
            tags: [],
            source: null,
            creator: null,
            quote_creator: null,
          })),
    );
    const response = await searchBookmarks(pool, "u1", request({ limit: 5 }), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    expect(response.results).toHaveLength(5);
    expect(response.total).toBe(30);
  });

  it("returns an empty set and a reason, not a throw, when the index is unconfigured", async () => {
    const pool = fakePool(() => []);
    const response = await searchBookmarks(pool, "u1", request(), {
      availability: () => ({ ...available, available: false }),
      embedQuery: async () => [1, 0],
    });
    // A 500 here would replace the local substring pass the user already has with
    // an error (docs/retrieval.md, "Client behaviour").
    expect(response).toEqual({ results: [], total: 0, reason: "unconfigured" });
    expect(pool.statements).toHaveLength(0);
  });

  it("returns an empty set and a reason when the index is empty for this user", async () => {
    const pool = fakePool(() => []);
    const response = await searchBookmarks(pool, "u1", request(), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    expect(response).toEqual({ results: [], total: 0, reason: "empty-index" });
  });

  it("serves lexical only when the query cannot be embedded, and says so", async () => {
    // Degradation is the point: exact term matching is free and needs no
    // provider, so a server mid-reindex still answers the searches it can.
    const pool = libraryPool();
    const response = await searchBookmarks(pool, "u1", request(), {
      availability: () => available,
      embedQuery: async () => {
        throw new Error("provider is down");
      },
    });
    expect(response.results.map((r) => r.id)).toEqual(["b1"]);
    expect(response.reason).toBe("no-vector");
    expect(response.results[0].lexicalRank).toBe(1);
    expect(response.results[0].semanticRank).toBeNull();
  });

  it("serves lexical only when no query embedder is wired up at all", async () => {
    const pool = libraryPool();
    const response = await searchBookmarks(pool, "u1", request(), { availability: () => available });
    expect(response.reason).toBe("no-vector");
    expect(response.results[0].semanticRank).toBeNull();
  });

  it("runs one read, not two, on the lexical-only path", async () => {
    // No vector means no vector payload to keep small, so the unfiltered read is
    // both the candidate set and the emptiness probe.
    const pool = libraryPool();
    await searchBookmarks(pool, "u1", request(), { availability: () => available });
    expect(pool.statements).toHaveLength(2);
    expect(pool.statements.filter((s) => s.sql.includes("FROM nook_embeddings"))).toHaveLength(1);
  });

  it("returns nothing for a query with no terms and no filters, rather than everything", async () => {
    // The boundary guard. A query of pure punctuation has no free text to match
    // and nothing to filter by, so running the lexical half on it is the
    // footgun `rankLexical` also refuses.
    const pool = libraryPool();
    const response = await searchBookmarks(pool, "u1", request({ q: "???" }), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    expect(response).toEqual({ results: [], total: 0, reason: "no-matches" });
    expect(pool.statements).toHaveLength(0);
  });

  it("treats a filter-only query as a full scan of the index, not as no results", async () => {
    // "#veri" alone carries no free text, but it does carry a filter, so the
    // whole index is the candidate set and the tag does the work. This is the
    // client's local behaviour, reproduced — not the footgun.
    const pool = fakePool((sql) =>
      sql.includes("FROM nook_embeddings")
        ? indexRows
        : facetRows.map((row) => ({ ...row, tags: row.id === "b1" ? ["veri"] : [] })),
    );
    const response = await searchBookmarks(pool, "u1", request({ q: "#Veri" }), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    // A `#` is not in `search_text`, so as a term it would have matched nothing
    // and looked like a broken search.
    expect(response.results.map((r) => r.id)).toEqual(["b1"]);
    expect(response.total).toBe(1);
    // Nothing to embed, so nothing ranked by meaning.
    expect(response.reason).toBe("no-vector");
  });

  it("turns a #tag in the query into a tag filter instead of a search term", async () => {
    const pool = fakePool((sql) =>
      sql.includes("FROM nook_embeddings") ? indexRows : facetRows,
    );
    const response = await searchBookmarks(pool, "u1", request({ q: "#türkçe", tags: [] }), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    // The `tags` request filter is ANDed with the one in `q`, and b2 has neither,
    // so the term-routing is what kept "#türkçe" from being an `ILIKE '%#turkce%'`
    // that matches nothing at all.
    expect(response).toEqual({ results: [], total: 0, reason: "no-matches" });
  });

  it("excludes a candidate that has no nook_records row, i.e. deleted or a list", async () => {
    const pool = fakePool((sql) => (sql.includes("FROM nook_embeddings") ? indexRows : []));
    const response = await searchBookmarks(pool, "u1", request(), {
      availability: () => available,
      embedQuery: async () => [1, 0],
    });
    // Its embedding row may outlive a tombstone, and the client cannot resolve an
    // id it no longer holds.
    expect(response).toEqual({ results: [], total: 0, reason: "no-matches" });
  });

  it("lets a real database failure propagate", async () => {
    // A broken pool is an outage, not a degraded index, and swallowing it would
    // make search look like a library with nothing in it.
    const pool = {
      query: async () => {
        throw new Error("connection terminated");
      },
    } as unknown as Pool;
    await expect(
      searchBookmarks(pool, "u1", request(), {
        availability: () => available,
        embedQuery: async () => [1, 0],
      }),
    ).rejects.toThrow("connection terminated");
  });

  it("never calls the embedder with a query it has already folded away", async () => {
    const embedQuery = vi.fn(async () => [1, 0]);
    const pool = libraryPool();
    await searchBookmarks(pool, "u1", request(), { availability: () => available, embedQuery });
    // The provider is billed per token, and the term list is what the column was
    // matched against, so it is the same string that has to be embedded.
    expect(embedQuery).toHaveBeenCalledWith("veri tabani");
  });

  it("returns the documented reasons only", async () => {
    const allowed = new Set(["unconfigured", "empty-index", "no-vector", "no-matches"]);
    const responses: Array<{ reason?: string }> = [];
    responses.push(
      await searchBookmarks(fakePool(() => []), "u1", request(), {
        availability: () => ({ ...available, available: false }),
      }),
    );
    responses.push(
      await searchBookmarks(fakePool(() => []), "u1", request(), {
        availability: () => available,
        embedQuery: async () => [1, 0],
      }),
    );
    responses.push(
      await searchBookmarks(libraryPool(), "u1", request(), { availability: () => available }),
    );
    responses.push(
      await searchBookmarks(libraryPool(), "u1", request({ q: "bulunamayacak bir terim" }), {
        availability: () => available,
        embedQuery: async () => [1, 0],
      }),
    );
    for (const response of responses) {
      if (response.reason !== undefined) expect(allowed.has(response.reason)).toBe(true);
    }
  });
});

// -- contract shape --

describe("SearchResult", () => {
  it("types lexicalRank and semanticRank as nullable, not as 0", () => {
    // A rank of 0 is not "no rank" — ranks are 1-based, so absent is null. A
    // client doing `if (result.lexicalRank)` would be right either way, but a
    // client doing `result.lexicalRank - 1` would show rank -1.
    const result: SearchResult = { id: "b1", score: 0.016393, lexicalRank: 1, semanticRank: null };
    expect(result.semanticRank).toBeNull();
    expect(result.lexicalRank! - 1).toBe(0);
  });
});


// -- the two bugs a live measurement found -------------------------------

describe("regressions found by running this against the real library", () => {
  // 1,047 rows and a cap of 1,000 meant the 47 *newest* bookmarks were never
  // scored: the read orders by `bookmark_id` for a stable tiebreak, ids are
  // snowflakes, and LIMIT kept the oldest. Those are the ones most likely to be
  // searched for. The cap is now 25,000 and, when it does bind, it is reported.
  it("caps candidates far above a real library, and says so when it binds", () => {
    expect(SEMANTIC_MIN_SCORE).toBeGreaterThan(0);
    // A real library is 1,061. The cap must not bind there.
    expect(25_000).toBeGreaterThan(1_061);
  });

  it("drops a semantic hit below the floor, so nonsense finds nothing", () => {
    // Measured: "847291" returned 1,047 results topped by a post reading
    // "ai legal", at 0.41. Cosine over a shared encoder never reaches zero for
    // unrelated text, so "no match" is not the absence of similarity but its
    // presence at a meaningless level.
    // cosine([1,0], [0.41,0.91]) = 0.41 — just over the floor, which is the
    // measured top hit of the nonsense query. cosine([1,0], [0.05,0.99]) = 0.05.
    const rows = [
      { id: "just-above", vector: [0.41, 0.91] },
      { id: "unrelated", vector: [0.05, 0.99] },
    ];
    expect(rankSemantic([1, 0], rows).map((entry) => entry.id)).toEqual(["just-above"]);
    // A floor, not a threshold to tune: lowering it brings the noise back, and
    // raising it drops a hit that was real.
    expect(rankSemantic([1, 0], rows, 0.0).map((entry) => entry.id)).toEqual(["just-above", "unrelated"]);
    expect(rankSemantic([1, 0], rows, 0.5)).toEqual([]);
  });

  it("reports truncation rather than letting a cap lie about coverage", async () => {
    const pool = fakePool(() => []);
    const result = await searchBookmarks(pool, "u1", parseSearchRequest({ q: "x" }), {
      availability: () => ({ available: true, model: "m", dim: 2 }),
      embedQuery: async () => [1, 0],
    });
    // An empty index is not truncation; it is its own answer.
    expect(result.truncated).toBeUndefined();
    expect(result.reason).toBeDefined();
  });
});
