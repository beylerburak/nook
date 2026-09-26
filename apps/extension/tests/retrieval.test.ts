// @vitest-environment happy-dom
//
// The client half of semantic search (docs/retrieval.md). happy-dom is here for
// one reason: the race guard lives in a React effect, and the only honest way to
// prove it is to let two real requests land out of order against a real
// component. Everything else in this file is plain functions over a stubbed
// server, and the session half runs against the real cloudSession() on
// fake-indexeddb rather than a stub, because "signed out means no request" is a
// claim about the auth the extension actually holds.
import "fake-indexeddb/auto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  SEARCH_RESULT_LIMIT,
  createSearchAvailability,
  isSearchConfigured,
  localResults,
  matchesSearch,
  parseSearchResponse,
  resolveServerIds,
  searchLibrary,
  shouldUseServerSearch,
  type SearchAvailability,
  type SearchDeps,
} from "../lib/retrieval";
import {
  SEARCH_DEBOUNCE_MS,
  describeEmptySearch,
  describeSearchCount,
  describeSearchSignal,
  matchesLibraryView,
  searchFiltersForView,
  useLibrarySearch,
  type LibrarySearch,
  type LibraryView,
  type MediaFilter,
} from "../src/app/dashboard/bookmark-utils";
import { DEFAULT_CLOUD_API_URL, cloudSession, saveCloudSession } from "../lib/cloud-sync";
import * as NookDB from "../lib/db";
import type { Bookmark } from "../lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

// -- mock server ------------------------------------------------------------
//
// Stands in for POST {apiUrl}/api/search. An answer of `null` holds the request
// open until settleHeld(), which is what makes the ordering of two replies the
// test's to choose — the race cannot be exercised with an auto-replying stub.

type Answer = { status: number; body: unknown } | { throws: unknown } | null;

interface SearchRequestBody {
  q: string;
  limit?: number;
  collections?: string[];
  tags?: string[];
  sources?: string[];
}

class MockSearchServer {
  requests: SearchRequestBody[] = [];
  urls: string[] = [];
  authorizations: Array<string | null> = [];
  /** `init.credentials` as sent, so a cookie-mode request can be told apart from a bearer one. */
  credentials: Array<RequestCredentials | undefined> = [];
  /** Answers handed out in request order. `null` means "hold this one open". */
  answers: Answer[] = [];
  /** Used once `answers` runs dry. */
  defaultAnswer: Answer = { status: 200, body: { results: [], total: 0 } };
  private held: Array<(response: Response) => void> = [];

  /** How many requests are issued but not yet answered. */
  get inFlight(): number {
    return this.held.length;
  }

  get queries(): string[] {
    return this.requests.map((request) => request.q);
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    this.urls.push(input);
    this.authorizations.push((init.headers as Record<string, string>).Authorization ?? null);
    this.credentials.push(init.credentials);
    this.requests.push(JSON.parse(String(init.body)) as SearchRequestBody);
    const answer = this.answers.length > 0 ? this.answers.shift()! : this.defaultAnswer;
    if (answer === null) return new Promise<Response>((resolve) => this.held.push(resolve));
    if ("throws" in answer) throw answer.throws;
    return json(answer.body, answer.status);
  };

  /**
   * Answers one of the requests that are still open. "newest" is what a test
   * needs to make a later query answer first while an earlier one is still open.
   */
  settleHeld(body: unknown, status = 200, which: "oldest" | "newest" = "oldest"): void {
    const resolve = which === "oldest" ? this.held.shift() : this.held.pop();
    if (!resolve) throw new Error("no request is waiting for a reply");
    resolve(json(body, status));
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** A body the way the route sends one: ids and scores, no content. */
function results(ids: string[], total = ids.length, reason?: string): unknown {
  return {
    results: ids.map((id, index) => ({
      id,
      score: 0.03 - index / 100,
      lexicalRank: index + 1,
      semanticRank: index + 1,
    })),
    total,
    ...(reason ? { reason } : {}),
  };
}

// -- fixtures ---------------------------------------------------------------

let clock = BASE_TIME;
let server: MockSearchServer;
let availability: SearchAvailability;
let consoleWarn: ReturnType<typeof vi.spyOn>;
let consoleError: ReturnType<typeof vi.spyOn>;

function bookmark(overrides: Partial<Bookmark> & { id: string }): Bookmark {
  return { source: "x", ...overrides };
}

function deps(overrides: Partial<SearchDeps> = {}): SearchDeps {
  return {
    fetch: server.fetch,
    apiUrl: DEFAULT_CLOUD_API_URL,
    availability,
    ...overrides,
  };
}

beforeEach(async () => {
  NookDB._resetForTests();
  await NookDB.ready();
  clock = BASE_TIME;
  server = new MockSearchServer();
  availability = createSearchAvailability({ now: () => clock });
  consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

// -- what may be asked ------------------------------------------------------

describe("shouldUseServerSearch", () => {
  test("leaves the exact prefixes local and sends a bare query", () => {
    expect(shouldUseServerSearch("#veri")).toBe(false);
    expect(shouldUseServerSearch("#Veri Tabanı")).toBe(false);
    expect(shouldUseServerSearch("@ada")).toBe(false);
    expect(shouldUseServerSearch("@Ada Lovelace")).toBe(false);
    expect(shouldUseServerSearch("veritabanı")).toBe(true);
    expect(shouldUseServerSearch("veri tabanı performans sorunu")).toBe(true);
  });

  test("an empty query is not a search", () => {
    expect(shouldUseServerSearch("")).toBe(false);
    expect(shouldUseServerSearch("   ")).toBe(false);
  });
});

// -- reading the answer -----------------------------------------------------

describe("parseSearchResponse", () => {
  test("reads ids, scores and the pre-slice total", () => {
    const parsed = parseSearchResponse({
      results: [
        { id: "a", score: 0.03, lexicalRank: 1, semanticRank: 4 },
        { id: "b", score: 0.02, lexicalRank: null, semanticRank: 9 },
      ],
      total: 137,
    });
    expect(parsed.results).toHaveLength(2);
    expect(parsed.results[0]).toEqual({ id: "a", score: 0.03, lexicalRank: 1, semanticRank: 4 });
    expect(parsed.results[1].lexicalRank).toBeNull();
    expect(parsed.total).toBe(137);
    expect(parsed.reason).toBeUndefined();
  });

  test("a body that is not an object yields nothing and does not throw", () => {
    for (const body of [null, undefined, "unconfigured", 42, true, [1, 2]]) {
      expect(parseSearchResponse(body)).toEqual({ results: [], total: 0 });
    }
  });

  test("a missing or malformed results array yields nothing", () => {
    expect(parseSearchResponse({ total: 5 })).toEqual({ results: [], total: 5 });
    expect(parseSearchResponse({ results: "nope", total: 5 })).toEqual({ results: [], total: 5 });
  });

  test("a null or unusable entry is skipped, not fatal", () => {
    const parsed = parseSearchResponse({
      results: [null, { id: "keep", score: 0.01 }, { score: 0.5 }, { id: "" }, 7, "x"],
      total: 1,
    });
    expect(parsed.results).toEqual([{ id: "keep", score: 0.01, lexicalRank: null, semanticRank: null }]);
  });

  test("a non-numeric score or rank degrades instead of poisoning the order", () => {
    const parsed = parseSearchResponse({
      results: [{ id: "a", score: "high", lexicalRank: "first", semanticRank: Number.NaN }],
      total: 1,
    });
    expect(parsed.results).toEqual([{ id: "a", score: 0, lexicalRank: null, semanticRank: null }]);
  });

  test("total never falls below the ids that arrived with it", () => {
    expect(parseSearchResponse({ results: [{ id: "a" }, { id: "b" }], total: 0 }).total).toBe(2);
  });

  test("an unknown reason is carried through, not dropped", () => {
    // `reason` is documented as additive, so a server that grows a new
    // degradation mode must not read as "no reason given" on this build.
    expect(parseSearchResponse({ results: [], total: 0, reason: "quota-exhausted" }).reason)
      .toBe("quota-exhausted");
  });
});

// -- the local pass ---------------------------------------------------------

describe("the local pass", () => {
  const items: Bookmark[] = [
    bookmark({ id: "b1", title: "PostgreSQL notları", description: "veritabanı performans sorunu" }),
    bookmark({ id: "b2", title: "Sharding a monolith", description: "cutting a database in half" }),
    bookmark({ id: "b3", title: "Arayüz tasarımı", tags: ["tasarım", "arayüz"] }),
    bookmark({ id: "b4", source: "chrome", url: "https://example.com/tokens", tags: ["design"] }),
    bookmark({ id: "b5", source: "chrome", creator: { name: "Ada Lovelace", handle: "ada" } }),
  ];

  test("a bare query is a substring pass over the text the library holds", () => {
    expect(localResults(items, "veritabanı").map((item) => item.id)).toEqual(["b1"]);
    // The case this feature exists for: nothing contains the Turkish word, so the
    // local pass is empty and only the index can answer.
    expect(localResults(items, "veri tabanı performans")).toEqual([]);
  });

  test("#tag and @author stay local and exact", () => {
    expect(localResults(items, "#arayüz").map((item) => item.id)).toEqual(["b3"]);
    expect(localResults(items, "@ada").map((item) => item.id)).toEqual(["b5"]);
    expect(matchesSearch(items[3], "#design")).toBe(true);
  });

  test("an empty query is the whole library, not an empty list", () => {
    expect(localResults(items, "")).toHaveLength(items.length);
    expect(localResults(items, "   ")).toHaveLength(items.length);
  });

  test("works with no session at all — this is the offline answer", async () => {
    // Nothing has signed in during this test, so there is no session to use: the
    // local pass is the whole answer, and it never asks for one.
    expect(await cloudSession()).toBeNull();
    expect(localResults(items, "arayüz").map((item) => item.id)).toEqual(["b3"]);
    expect(localResults(items, "@ada").map((item) => item.id)).toEqual(["b5"]);
  });
});

describe("resolveServerIds", () => {
  const items: Bookmark[] = [
    bookmark({ id: "b1" }),
    bookmark({ id: "chrome:412" }),
    bookmark({ id: "x:1801" }),
  ];

  test("maps ids back onto the local library, in the server's order", () => {
    expect(resolveServerIds(items, ["x:1801", "b1"]).map((item) => item.id)).toEqual(["x:1801", "b1"]);
  });

  test("resolves a Chrome bookmark whose id carries a device id", () => {
    // cloud-sync uploads these as chrome:<deviceId>:<numeric> while the record
    // keeps chrome:<numeric>; without the alias every saved web page would drop
    // out of a semantic search.
    expect(resolveServerIds(items, ["chrome:9f2c-4a1:412"]).map((item) => item.id)).toEqual(["chrome:412"]);
  });

  test("drops ids the local library does not have, and never duplicates a row", () => {
    expect(resolveServerIds(items, ["b1", "gone", "b1", "chrome:9f2c-4a1:412"]).map((item) => item.id))
      .toEqual(["b1", "chrome:412"]);
  });

  test("an empty id list is an empty list", () => {
    expect(resolveServerIds(items, [])).toEqual([]);
  });
});

// -- the server pass --------------------------------------------------------

describe("searchLibrary", () => {
  test("asks for a full page of ids, with the cloud bearer token", async () => {
    await saveCloudSession("test-token", "user-1");
    server.answers = [{ status: 200, body: results(["b2", "b1"], 137) }];

    const outcome = await searchLibrary("veritabanı", deps());

    expect(server.urls).toEqual([`${DEFAULT_CLOUD_API_URL}/api/search`]);
    expect(server.authorizations).toEqual(["Bearer test-token"]);
    // Bearer mode never sets `credentials` — only cookie mode needs it.
    expect(server.credentials).toEqual([undefined]);
    expect(server.requests[0]).toEqual({ q: "veritabanı", limit: SEARCH_RESULT_LIMIT });
    expect(outcome.ids).toEqual(["b2", "b1"]);
    // `total` is the count before the limit slice, which is what lets the UI say
    // "2 of 137" instead of implying the library holds two.
    expect(outcome.total).toBe(137);
    expect(outcome.fallback).toBeNull();
  });

  test("cookie auth (the web host) sends credentials and no bearer header", async () => {
    // The web app authenticates with `configureCloud({ auth: "cookie" })`, so
    // `cloudRequestAuth()` there resolves to `{ mode: "cookie" }` rather than a
    // token — this is the shape that used to make the web host's searches
    // silently answer "signed-out" (root cause of the web semantic-search bug).
    server.answers = [{ status: 200, body: results(["b1"]) }];

    const outcome = await searchLibrary("veritabanı", deps({ session: async () => ({ mode: "cookie" }) }));

    expect(server.requests).toHaveLength(1);
    expect(server.authorizations).toEqual([null]);
    expect(server.credentials).toEqual(["include"]);
    expect(outcome.ids).toEqual(["b1"]);
    expect(outcome.fallback).toBeNull();
  });

  test("a null auth (either host, signed out) sends no request at all", async () => {
    const outcome = await searchLibrary("veritabanı", deps({ session: async () => null }));

    expect(server.requests).toHaveLength(0);
    expect(outcome).toEqual({ ids: [], total: 0, fallback: "signed-out" });
  });

  test("sends the facets mirroring the current view, and omits the rest", async () => {
    await saveCloudSession("test-token", "user-1");
    server.answers = [{ status: 200, body: results(["b1"]) }];

    await searchLibrary("arayüz", deps({ filters: { tags: ["arayuz"], sources: [] } }));
    expect(server.requests[0]).toEqual({ q: "arayüz", limit: SEARCH_RESULT_LIMIT, tags: ["arayuz"] });

    server.answers = [{ status: 200, body: results(["b1"]) }];
    await searchLibrary("arayüz", deps());
    expect(server.requests[1]).toEqual({ q: "arayüz", limit: SEARCH_RESULT_LIMIT });
  });

  test("no session means no request at all", async () => {
    const outcome = await searchLibrary("veritabanı", deps());

    expect(server.requests).toHaveLength(0);
    expect(outcome).toEqual({ ids: [], total: 0, fallback: "signed-out" });
  });

  test("#tag and @author never reach the server", async () => {
    await saveCloudSession("test-token", "user-1");

    expect(await searchLibrary("#arayüz", deps())).toMatchObject({ fallback: "local-query" });
    expect(await searchLibrary("@ada", deps())).toMatchObject({ fallback: "local-query" });
    expect(server.requests).toHaveLength(0);
  });

  test("offline is a quiet stop, not a failed search", async () => {
    await saveCloudSession("test-token", "user-1");

    const outcome = await searchLibrary("veritabanı", deps({ isOffline: () => true }));

    expect(server.requests).toHaveLength(0);
    expect(outcome.fallback).toBe("offline");
    // Connectivity is the sync indicator's story to tell, not an error here.
    expect(consoleError).not.toHaveBeenCalled();
  });

  test("a 401 is terminal for the session and is not retried", async () => {
    await saveCloudSession("test-token", "user-1");
    server.answers = [{ status: 401, body: { error: "Unauthorized" } }];

    const outcome = await searchLibrary("veritabanı", deps());

    expect(server.requests).toHaveLength(1);
    expect(outcome).toEqual({ ids: [], total: 0, fallback: "unauthorized" });
    // Not retried, and search does not tear the session down — syncCloud owns that.
    expect(consoleWarn).toHaveBeenCalledTimes(1);
    expect(await NookDB.getMeta<string>("cloud:https://nook.beyler.co:token")).toBe("test-token");
  });

  test("a 400 is a client bug: logged once, not retried", async () => {
    await saveCloudSession("test-token", "user-1");
    server.answers = [{ status: 400, body: { error: "Query has too many terms" } }];

    const outcome = await searchLibrary("veri tabanı", deps());

    expect(server.requests).toHaveLength(1);
    expect(outcome).toEqual({ ids: [], total: 0, fallback: "failed" });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0]?.[0])).toContain("400");
  });

  test("a 5xx is quiet and does not retry either", async () => {
    await saveCloudSession("test-token", "user-1");
    server.answers = [{ status: 503, body: { error: "unavailable" } }];

    expect((await searchLibrary("veritabanı", deps())).fallback).toBe("failed");
    expect(server.requests).toHaveLength(1);
  });

  test("a network failure is a quiet empty result", async () => {
    await saveCloudSession("test-token", "user-1");
    server.answers = [{ throws: new TypeError("Failed to fetch") }];

    expect(await searchLibrary("veritabanı", deps())).toEqual({ ids: [], total: 0, fallback: "failed" });
    expect(server.requests).toHaveLength(1);
  });

  test("an unreadable body is a quiet empty result, never a throw", async () => {
    await saveCloudSession("test-token", "user-1");
    // A 200 carrying an HTML error page from a proxy is the shape this has to
    // survive: the status says fine and the body says nothing at all.
    const html = new Response("<html>gateway</html>", { status: 200 });

    expect(await searchLibrary("veritabanı", deps({ fetch: async () => html })))
      .toEqual({ ids: [], total: 0, fallback: "failed" });
  });

  test("unconfigured and no-matches are told apart", async () => {
    await saveCloudSession("test-token", "user-1");

    server.answers = [{ status: 200, body: { results: [], total: 0, reason: "unconfigured" } }];
    const unconfigured = await searchLibrary("veritabanı", deps());
    expect(unconfigured).toEqual({ ids: [], total: 0, reason: "unconfigured", fallback: "unconfigured" });

    // The window has to be advanced past, or the latch would suppress this one.
    clock = BASE_TIME + 20 * 60_000;
    availability = createSearchAvailability({ now: () => clock });

    server.answers = [{ status: 200, body: { results: [], total: 0, reason: "no-matches" } }];
    const nothing = await searchLibrary("veritabanı", deps());
    expect(nothing).toEqual({ ids: [], total: 0, reason: "no-matches", fallback: "unsearchable" });
  });

  test("an unindexed library is the same quiet state as no index at all", async () => {
    await saveCloudSession("test-token", "user-1");
    server.answers = [{ status: 200, body: { results: [], total: 0, reason: "empty-index" } }];

    expect((await searchLibrary("veritabanı", deps())).fallback).toBe("unconfigured");
  });

  test("results with no vector still count as server results", async () => {
    await saveCloudSession("test-token", "user-1");
    server.answers = [{ status: 200, body: results(["b1", "b3"], 2, "no-vector") }];

    const outcome = await searchLibrary("veritabanı", deps());
    // `no-vector` arrives *with* results: the index is there and the exact matches
    // came back, nothing was ranked by meaning. It is not a degraded answer.
    expect(outcome.ids).toEqual(["b1", "b3"]);
    expect(outcome.reason).toBe("no-vector");
    expect(outcome.fallback).toBeNull();
  });

  test("a session that cannot be read degrades instead of rejecting", async () => {
    const outcome = await searchLibrary("veritabanı", deps({
      session: async () => {
        throw new Error("IndexedDB is closed");
      },
    }));

    expect(server.requests).toHaveLength(0);
    expect(outcome.fallback).toBe("failed");
  });
});

// -- learning that a server has no index -----------------------------------

describe("the unconfigured latch", () => {
  test("an account that has never been asked is assumed configured", () => {
    // The only way to learn a server has no index is to ask it, so the first
    // answer always costs one request.
    expect(isSearchConfigured()).toBe(true);
    expect(availability.isConfigured()).toBe(true);
  });

  test("a server that reports no index is not asked again inside the window", async () => {
    await saveCloudSession("test-token", "user-1");
    server.answers = [{ status: 200, body: { results: [], total: 0, reason: "unconfigured" } }];

    await searchLibrary("veritabanı", deps());
    expect(availability.isConfigured()).toBe(false);

    await searchLibrary("arayüz", deps());
    await searchLibrary("tasarım", deps());
    expect(server.requests).toHaveLength(1);
  });

  test("an index that appears later is picked up without a reload", async () => {
    await saveCloudSession("test-token", "user-1");
    server.answers = [{ status: 200, body: { results: [], total: 0, reason: "unconfigured" } }];
    await searchLibrary("veritabanı", deps());
    expect(availability.isConfigured()).toBe(false);

    clock = BASE_TIME + 20 * 60_000;
    expect(availability.isConfigured()).toBe(true);

    server.answers = [{ status: 200, body: results(["b1"]) }];
    const outcome = await searchLibrary("veritabanı", deps());
    expect(outcome.ids).toEqual(["b1"]);
    expect(server.requests).toHaveLength(2);
  });

  test("a later answer that is not \"no index\" reopens the latch at once", async () => {
    await saveCloudSession("test-token", "user-1");
    const latch = createSearchAvailability({ now: () => clock });
    latch.record({ ids: [], total: 0, fallback: "unconfigured" });
    expect(latch.isConfigured()).toBe(false);

    // Reachable in production when a second query was already in flight when the
    // first one reported no index: that second one gets a real answer, and an
    // answer that is not "no index" is proof there is one.
    latch.record({ ids: ["b1"], total: 1, fallback: null });
    expect(latch.isConfigured()).toBe(true);

    server.answers = [{ status: 200, body: results(["b1"]) }];
    expect((await searchLibrary("veritabanı", deps({ availability: latch }))).ids).toEqual(["b1"]);
  });

  test("an empty result set is not evidence that there is no index", async () => {
    await saveCloudSession("test-token", "user-1");
    const latch = createSearchAvailability({ now: () => clock });
    server.answers = [{ status: 200, body: { results: [], total: 0, reason: "no-matches" } }];

    await searchLibrary("veritabanı", deps({ availability: latch }));
    // The index was there and had nothing for this query, so the next query is
    // still worth asking — only a server without an index silences the box.
    expect(latch.isConfigured()).toBe(true);
  });
});

describe("the view pipeline", () => {
  const items: Bookmark[] = [
    bookmark({ id: "x1", listId: "l1", tags: ["arayuz"], note: "note" }),
    bookmark({ id: "c1", source: "chrome", listId: null, media: [{ type: "image", url: "https://x/1.png" }] }),
    bookmark({ id: "c2", source: "chrome", listId: "l1" }),
  ];

  function admitted(view: LibraryView, mediaFilter: MediaFilter = "all", notesOnly = false): string[] {
    return items.filter((item) => matchesLibraryView(item, view, mediaFilter, notesOnly)).map((item) => item.id);
  }

  test("keeps every view rule the sidebar had", () => {
    expect(admitted({ kind: "x" })).toEqual(["x1"]);
    expect(admitted({ kind: "chrome" })).toEqual(["c1", "c2"]);
    expect(admitted({ kind: "unorganized" })).toEqual(["c1"]);
    expect(admitted({ kind: "list", id: "l1" })).toEqual(["x1", "c2"]);
    expect(admitted({ kind: "tag", id: "arayuz" })).toEqual(["x1"]);
    expect(admitted({ kind: "all" })).toEqual(["x1", "c1", "c2"]);
  });

  test("keeps the media and notes filters, which the server knows nothing about", () => {
    expect(admitted({ kind: "all" }, "media")).toEqual(["c1"]);
    expect(admitted({ kind: "all" }, "text")).toEqual(["x1", "c2"]);
    expect(admitted({ kind: "all" }, "all", true)).toEqual(["x1"]);
  });

  test("the facets sent to the server mirror the view", () => {
    expect(searchFiltersForView({ kind: "list", id: "l1" })).toEqual({ collections: ["l1"] });
    expect(searchFiltersForView({ kind: "tag", id: "arayuz" })).toEqual({ tags: ["arayuz"] });
    expect(searchFiltersForView({ kind: "x" })).toEqual({ sources: ["x"] });
    expect(searchFiltersForView({ kind: "chrome" })).toEqual({ sources: ["chrome"] });
    // Nothing to express: unorganized has no server-side facet, so it stays local.
    expect(searchFiltersForView({ kind: "unorganized" })).toEqual({});
  });
});

// -- what the search says ---------------------------------------------------

function searchState(overrides: Partial<LibrarySearch> = {}): LibrarySearch {
  return { items: [], semantic: null, fallback: null, isPending: false, ...overrides };
}

describe("the search signal", () => {
  test("says the results are semantic when the server's ids are the list", () => {
    expect(describeSearchSignal(searchState({ semantic: { total: 137 } }))).toEqual({
      label: "Semantic",
      detail: "Ranked by meaning, not just by matching words.",
      variant: "accent",
    });
  });

  test("says what the local pass can and cannot do", () => {
    expect(describeSearchSignal(searchState({ fallback: "signed-out" }))?.label).toBe("Keyword match");
    expect(describeSearchSignal(searchState({ fallback: "offline" }))?.variant).toBe("warning");
    expect(describeSearchSignal(searchState({ fallback: "unsearchable" }))?.detail)
      .toContain("by word or by meaning");
  });

  test("says nothing at all for a server that simply has no index", () => {
    // The user never turned this on, so they should not learn that a feature they
    // did not ask for does not exist — a red dot for a missing API key would be a
    // fault on their device that they can do nothing about.
    expect(describeSearchSignal(searchState({ fallback: "unconfigured" }))).toBeNull();
    expect(describeSearchSignal(searchState({ fallback: "failed" }))).toBeNull();
    expect(describeSearchSignal(searchState({ fallback: "unauthorized" }))).toBeNull();
    expect(describeSearchSignal(searchState({ fallback: "local-query" }))).toBeNull();
    expect(describeSearchSignal(searchState())).toBeNull();
  });
});

describe("the search counts", () => {
  test("no query is just the library count", () => {
    expect(describeSearchCount(searchState(), 42, "")).toBe("42 saved items");
    expect(describeSearchCount(searchState(), 1, "")).toBe("1 saved item");
  });

  test("a server total above the page says so rather than implying a small library", () => {
    expect(describeSearchCount(searchState({ semantic: { total: 137 } }), 20, "veritabanı"))
      .toBe("20 of 137 saved items matching “veritabanı”");
    expect(describeSearchCount(searchState({ semantic: { total: 20 } }), 20, "veritabanı"))
      .toBe("20 saved items matching “veritabanı”");
  });
});

describe("the empty state", () => {
  test("an empty library is not a failed search", () => {
    expect(describeEmptySearch(searchState(), "", 0).title).toBe("Your library is ready");
  });

  test("says which pass found nothing when the index answered", () => {
    const copy = describeEmptySearch(searchState({ fallback: "unsearchable" }), "veritabanı", 12);
    expect(copy.title).toBe("No results for “veritabanı”");
    expect(copy.description).toContain("by word or by meaning");
  });

  test("a request in flight is not yet a result", () => {
    const copy = describeEmptySearch(searchState({ isPending: true }), "veritabanı", 12);
    expect(copy.title).toBe("No results for “veritabanı”");
    expect(copy.description).toContain("still looking by meaning");
  });

  test("falls back to the plain copy when the server never had a say", () => {
    expect(describeEmptySearch(searchState({ fallback: "unconfigured" }), "veritabanı", 12)).toEqual({
      title: "No matching bookmarks",
      description: "Try another search or clear the current filter.",
    });
  });
});

// -- the hook ---------------------------------------------------------------
//
// A probe component rather than the whole dashboard: what is under test is the
// effect, and rendering 1,000 bookmarks through the data table to watch two
// promises settle would test the Astryx components instead.

const LIBRARY: Bookmark[] = [
  bookmark({ id: "local-db", title: "PostgreSQL notları", description: "veritabanı performans sorunu" }),
  bookmark({ id: "semantic-db", title: "Sharding a monolith", description: "cutting a database in half" }),
  bookmark({ id: "local-ui", title: "Arayüz tasarımı", tags: ["arayüz"] }),
  bookmark({ id: "ui-kit", source: "chrome", title: "Design tokens handbook" }),
];

let container: HTMLElement;
let root: Root;
let searchDeps: SearchDeps;

function Probe(props: { query: string; canSearch?: boolean }) {
  const state = useLibrarySearch({
    items: LIBRARY,
    query: props.query,
    canSearch: props.canSearch ?? true,
    deps: searchDeps,
  });
  return createElement(
    "section",
    null,
    createElement("p", null, state.semantic ? `semantic:${state.semantic.total}` : state.fallback ?? "local"),
    createElement("ul", null, state.items.map((item) => createElement("li", { key: item.id }, item.title))),
  );
}

function visible(): string[] {
  return [...container.querySelectorAll("li")].map((li) => li.textContent ?? "");
}

function stateLine(): string {
  return container.querySelector("p")?.textContent ?? "";
}

/** A keystroke: re-render with the new query, then let any pending microtasks run. */
async function type(query: string, canSearch = true): Promise<void> {
  await act(async () => {
    root.render(createElement(Probe, { query, canSearch }));
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Answers a held request and lets the resulting render land. */
async function answer(body: unknown, status = 200, which: "oldest" | "newest" = "oldest"): Promise<void> {
  await act(async () => {
    server.settleHeld(body, status, which);
    await vi.advanceTimersByTimeAsync(0);
  });
}

/** Lets the debounce elapse and any reply that follows it. */
async function waitForDebounce(multiplier = 1): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS * multiplier);
  });
}

describe("useLibrarySearch", () => {
  // Fake timers belong to this block alone: they also fake `setImmediate`, which
  // is what fake-indexeddb schedules its transactions on, so a file-wide
  // `useFakeTimers` silently deadlocks every test that reads the session.
  beforeEach(() => {
    vi.useFakeTimers();
    // The session is injected rather than read from IndexedDB on purpose: the
    // session gate is covered above against the real cloudSession(), and
    // fake-indexeddb schedules on the setImmediate that useFakeTimers also fakes,
    // so a real read here would simply never resolve.
    searchDeps = deps({ session: async () => ({ mode: "bearer", token: "test-token" }) });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  test("the local pass renders on the keystroke, before any request exists", async () => {
    await type("veritabanı");
    expect(visible()).toEqual(["PostgreSQL notları"]);
    expect(stateLine()).toBe("local");
    expect(server.requests).toHaveLength(0);
  });

  test("waits for a pause in typing before it asks the server", async () => {
    await type("veritabanı");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    });
    expect(server.requests).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(server.queries).toEqual(["veritabanı"]);
  });

  test("replaces the local set with the server's ids when the answer lands", async () => {
    await type("veritabanı");
    server.answers = [{ status: 200, body: results(["semantic-db"], 1) }];
    await waitForDebounce();

    // The substring pass found one bookmark; the index found another that shares
    // no words with the query at all. That second one is the whole feature.
    expect(visible()).toEqual(["Sharding a monolith"]);
    expect(stateLine()).toBe("semantic:1");
  });

  test("a slow answer for an older query never overwrites a newer one", async () => {
    // Both requests are held open, so the order they are answered in is the
    // test's to choose rather than the server's.
    server.answers = [null, null];
    await type("veritabanı");
    await waitForDebounce();
    expect(server.queries).toEqual(["veritabanı"]);

    // The user keeps typing before the first answer comes back.
    await type("arayüz");
    await waitForDebounce();
    expect(server.queries).toEqual(["veritabanı", "arayüz"]);
    expect(server.inFlight).toBe(2);

    // The newer query is answered first.
    await answer(results(["ui-kit"], 1), 200, "newest");
    expect(visible()).toEqual(["Design tokens handbook"]);

    // The older, slower answer lands afterwards and must be dropped: it belongs to
    // a query the user has already moved on from. Left alone it would replace the
    // list with a result for "veritabanı" the user can no longer see in the box.
    await answer(results(["semantic-db", "local-db"], 2));
    expect(visible()).toEqual(["Design tokens handbook"]);
    expect(stateLine()).toBe("semantic:1");
  });

  test("an answer that arrives after the box is cleared changes nothing", async () => {
    server.answers = [null];
    await type("veritabanı");
    await waitForDebounce();
    expect(server.inFlight).toBe(1);

    await type("");
    expect(visible()).toHaveLength(LIBRARY.length);

    await answer(results(["semantic-db"], 1));
    expect(visible()).toHaveLength(LIBRARY.length);
    expect(stateLine()).toBe("local");
  });

  test("a #tag query is answered locally and never asks the server", async () => {
    await type("#arayüz");
    await waitForDebounce(4);
    expect(visible()).toEqual(["Arayüz tasarımı"]);
    expect(server.requests).toHaveLength(0);
    expect(stateLine()).toBe("local");
  });

  test("signed out keeps the local pass and says so", async () => {
    await type("veritabanı", false);
    await waitForDebounce(4);
    expect(server.requests).toHaveLength(0);
    expect(visible()).toEqual(["PostgreSQL notları"]);
    expect(stateLine()).toBe("local");
  });

  test("a server with no index keeps the local pass and stays silent", async () => {
    await type("veritabanı");
    server.answers = [{ status: 200, body: { results: [], total: 0, reason: "unconfigured" } }];
    await waitForDebounce();
    expect(visible()).toEqual(["PostgreSQL notları"]);
    expect(describeSearchSignal(searchState({ fallback: "unconfigured" }))).toBeNull();

    // And the next query is not asked either, until the window passes.
    await type("arayüz");
    await waitForDebounce(4);
    expect(server.queries).toEqual(["veritabanı"]);
  });

  test("an empty local result with a request in flight is not a final answer", async () => {
    await type("şema");
    expect(visible()).toEqual([]);
    expect(describeEmptySearch(searchState({ isPending: true }), "şema", 4).description)
      .toContain("still looking by meaning");

    server.answers = [{ status: 200, body: results(["semantic-db"], 1) }];
    await waitForDebounce();
    expect(visible()).toEqual(["Sharding a monolith"]);
  });

  test("the view pipeline stays authoritative over the server's ids", async () => {
    // The hook resolves the server's ids against the bookmarks the view admitted,
    // so an id the view filtered out cannot reappear through the index.
    const admitted = [LIBRARY[1]];
    const state: LibrarySearch = { ...searchState(), items: admitted };
    expect(resolveServerIds(admitted, ["ui-kit", "semantic-db"]).map((item) => item.id)).toEqual(["semantic-db"]);
    expect(state.items).toHaveLength(1);
  });

  test("an unanswered request does not leave the list claiming to be pending forever", async () => {
    server.answers = [null];
    await type("veritabanı");
    await waitForDebounce();
    // Switching to a local-only query retires the in-flight one.
    await type("#arayüz");
    await answer(results(["semantic-db"], 1));
    expect(visible()).toEqual(["Arayüz tasarımı"]);
    expect(describeEmptySearch(searchState({ isPending: false }), "arayüz", 4).description)
      .toBe("Try another search or clear the current filter.");
  });
});
