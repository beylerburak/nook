import "fake-indexeddb/auto";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { DEFAULT_AI_SETTINGS, _resetAiSettingsCacheForTests, saveAiSettings, type AiSettings } from "../lib/ai-settings";
import {
  AI_BATCH_SIZE,
  AI_CONCURRENCY,
  AI_CURSOR_META_KEY,
  AI_LOG_MAX_ENTRIES,
  AI_LOG_META_KEY,
  isAiRunInFlight,
  runClassification,
  type AiCursor,
  type AiLogEntry,
  type AiRunnerDeps,
} from "../lib/ai-runner";
import { DEFAULT_CLOUD_API_URL, configureCloud, saveCloudSession } from "../lib/cloud-sync";
import * as NookDB from "../lib/db";
import type { Bookmark } from "../lib/types";

// -- mock server ---------------------------------------------------------
//
// Stands in for POST {apiUrl}/api/ai/classify. The real route is one bookmark
// -> one decision (docs/ai.md, Contract), so the stub's unit is one request.
// What it records beyond the response is what the runner's shape claims: how
// many requests a tick makes, and how many of them were in flight at once.

interface ClassifyRequestBody {
  bookmark: { id: string; title?: string; summary?: string; note?: string; site?: string; author?: string };
  collections: Array<{ id: string; name: string; samples: string[] }>;
  tags: Array<{ name: string; samples: string[] }>;
  settings: { collectionMinConfidence: number; tagMinNoul: number; maxTags: number };
}

interface Decision {
  assign?: boolean;
  id?: string | null;
  name?: string | null;
  confidence?: number;
  tags?: Array<{ name: string; noul: number }>;
  skipped?: "none-fit" | "low-confidence";
}

class MockClassifyServer {
  requests: ClassifyRequestBody[] = [];
  /** Requests whose response has not been produced yet. */
  inFlight = 0;
  peakInFlight = 0;
  /** Forced status for every request, before any per-id override. */
  status = 200;
  /** Status used for the first request only, then cleared. */
  statusOnce: number | null = null;
  /** Replaces the body with something that is not a decision. */
  malformed = false;
  /** Replaces the body with the server's neutral placeholder: a 200 that is not
   *  a decision at all, because the server never reached the model. */
  neutral = false;
  /** Per-bookmark decision overrides, keyed by the request's bookmark id. */
  decisions = new Map<string, Decision>();
  defaultDecision: Decision = { assign: true, id: "list-1", name: "Reading", confidence: 0.91, tags: [] };
  /** Headers the runner sent, so the bearer token is checked once. */
  lastAuthorization: string | null = null;
  lastUrl: string | null = null;

  /**
   * GET/PUT /api/ai/settings, since `execute()` now reads settings through the
   * same injected `fetch` it uses for /api/ai/classify (see `AiRunnerDeps`,
   * "the toggle is (almost) the whole gate"). Separate from `requests` above:
   * that array's length is what most tests assert as "how many classify calls
   * were made", and a settings GET must not pollute it.
   */
  settings: AiSettings = { ...DEFAULT_AI_SETTINGS };
  settingsRequests: Array<{ method: string }> = [];

  json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }

  respondSettings(init: RequestInit | undefined): Response {
    this.lastAuthorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    const method = init?.method ?? "GET";
    this.settingsRequests.push({ method });
    if (method === "PUT") {
      const patch = JSON.parse(String(init?.body)) as Partial<AiSettings>;
      this.settings = { ...this.settings, ...patch };
    }
    return this.json(this.settings);
  }

  async respond(body: ClassifyRequestBody, init: RequestInit | undefined): Promise<Response> {
    this.requests.push(body);
    this.lastAuthorization = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
    this.inFlight++;
    if (this.inFlight > this.peakInFlight) this.peakInFlight = this.inFlight;
    // Yield so the whole pool is inside fetch() before the first reply lands —
    // without this, a serial runner would also report a peak of 1.
    await new Promise((resolve) => setTimeout(resolve, 0));
    this.inFlight--;

    const status = this.statusOnce ?? this.status;
    this.statusOnce = null;
    if (status === 200 && this.malformed) return new Response("<html>not json</html>", { status: 200 });
    // The server's neutral placeholder: a 200 shaped exactly like a decision,
    // carrying `model: "unavailable"` to say it never reached the model.
    if (status === 200 && this.neutral) {
      return this.json(
        {
          model: "unavailable",
          collection: { assign: false, id: null, name: null, confidence: 0, probabilities: {} },
          tags: [],
        },
        status,
      );
    }

    const decision = this.decisions.get(body.bookmark.id) ?? this.defaultDecision;
    const confidence = decision.confidence ?? 0.91;
    const assign = decision.assign === true;
    return this.json(
      {
        model: "jev-1.13.0",
        collection: {
          assign,
          id: assign ? (decision.id ?? "list-1") : null,
          name: assign ? (decision.name ?? "Reading") : null,
          confidence,
          probabilities: { "__none__": Number((1 - confidence).toFixed(2)), "list-1": confidence },
        },
        tags: decision.tags ?? [],
        ...(decision.skipped ? { skipped: decision.skipped } : {}),
      },
      status,
    );
  }

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    this.lastUrl = input;
    if (input.endsWith("/api/ai/settings")) return this.respondSettings(init);
    return this.respond(JSON.parse(String(init.body)) as ClassifyRequestBody, init);
  };
}

// -- fixtures ------------------------------------------------------------

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

let clock = BASE_TIME;
let server: MockClassifyServer;

function deps(overrides: Partial<AiRunnerDeps> = {}): AiRunnerDeps {
  return {
    fetch: server.fetch,
    now: () => clock,
    apiUrl: DEFAULT_CLOUD_API_URL,
    ...overrides,
  };
}

function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  return {
    id: `b-${Math.random().toString(36).slice(2, 10)}`,
    source: "web",
    url: "https://example.com/post",
    title: "A page worth filing",
    ...overrides,
  };
}

async function seed(count: number, make: (index: number) => Partial<Bookmark> = () => ({})): Promise<Bookmark[]> {
  const saved: Bookmark[] = [];
  for (let index = 0; index < count; index++) {
    saved.push(await NookDB.putBookmark({ ...bookmark(), id: `b-${index}`, ...make(index) }));
  }
  return saved;
}

async function readCursor(): Promise<AiCursor | undefined> {
  return NookDB.getMeta<AiCursor>(AI_CURSOR_META_KEY);
}

async function readLog(): Promise<AiLogEntry[]> {
  return (await NookDB.getMeta<AiLogEntry[]>(AI_LOG_META_KEY)) ?? [];
}

beforeEach(async () => {
  NookDB._resetForTests();
  await NookDB.ready();
  _resetAiSettingsCacheForTests();
  clock = BASE_TIME;
  server = new MockClassifyServer();
  server.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
  // `execute()` reads settings through its own injected `apiUrl`/`fetch`, which
  // `deps()` below always supplies — so this only matters for the handful of
  // tests that call `saveAiSettings()` directly (its own default path, no deps,
  // uses the global fetch and the real cloudSession()-derived bearer token).
  vi.stubGlobal("fetch", server.fetch);
  await saveCloudSession("test-token", "user-1");
  await NookDB.putList({ id: "list-1", name: "Reading" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  configureCloud({ apiUrl: DEFAULT_CLOUD_API_URL, auth: "bearer" });
});

// -- the gate -------------------------------------------------------------

test("issues no fetch at all while autoClassify is off", async () => {
  await saveAiSettings({ autoClassify: false });
  await seed(3);

  const result = await runClassification(deps());

  expect(result).toEqual({ processed: 0, assigned: 0, tagged: 0, skipped: 0 });
  expect(server.requests).toHaveLength(0);
  expect(await readCursor()).toBeUndefined();
});

test("issues nothing without a session, even with the toggle on", async () => {
  await NookDB.setMeta("cloud:https://nook.beyler.co:token", null);
  await seed(3);

  const result = await runClassification(deps());

  expect(result.processed).toBe(0);
  expect(server.requests).toHaveLength(0);
});

test("a run that gets past the gate posts to the classify route with the bearer token", async () => {
  await seed(1);
  const result = await runClassification(deps());

  expect(result.processed).toBe(1);
  expect(server.lastUrl).toBe(`${DEFAULT_CLOUD_API_URL}/api/ai/classify`);
  expect(server.lastAuthorization).toBe("Bearer test-token");
});

// -- eligibility ----------------------------------------------------------

test("a bookmark with a manual collection is never sent", async () => {
  await seed(1, () => ({ listId: "list-1", listName: "Reading" }));

  const result = await runClassification(deps());

  expect(server.requests).toHaveLength(0);
  expect(result).toEqual({ processed: 0, assigned: 0, tagged: 0, skipped: 0 });
});

test("a bookmark the AI already decided on is never sent again", async () => {
  await seed(1, () => ({ ai: { model: "jev-1.13.0", at: "2025-12-01T00:00:00.000Z" } }));

  await runClassification(deps());

  expect(server.requests).toHaveLength(0);
});

test("candidate selection is bounded by the batch size, and the next tick takes the remainder", async () => {
  await seed(AI_BATCH_SIZE + 5);

  const first = await runClassification(deps());
  expect(server.requests).toHaveLength(AI_BATCH_SIZE);
  expect(first.processed).toBe(AI_BATCH_SIZE);

  // Every first-tick candidate now carries attribution, so the second tick
  // sees exactly what the first one left behind.
  const second = await runClassification(deps());
  expect(server.requests).toHaveLength(AI_BATCH_SIZE + 5);
  expect(second.processed).toBe(5);
});

// -- batching and concurrency ---------------------------------------------

test("never runs more than AI_CONCURRENCY requests in flight, and does run more than one", async () => {
  await seed(AI_BATCH_SIZE);

  await runClassification(deps());

  expect(server.requests).toHaveLength(AI_BATCH_SIZE);
  expect(server.peakInFlight).toBe(AI_CONCURRENCY);
  expect(server.peakInFlight).toBeGreaterThan(1);
});

// -- writing --------------------------------------------------------------

test("assigns a collection through updateBookmark and records the confidence", async () => {
  const [saved] = await seed(1);
  server.defaultDecision = { assign: true, id: "list-1", name: "Reading", confidence: 0.93, tags: [] };

  const result = await runClassification(deps());

  expect(result.assigned).toBe(1);
  const written = await NookDB.getBookmark(saved.id);
  expect(written?.listId).toBe("list-1");
  expect(written?.listName).toBe("Reading");
  expect((written?.ai as { collectionConfidence?: number } | undefined)?.collectionConfidence).toBe(0.93);

  const log = await readLog();
  expect(log).toHaveLength(1);
  expect(log[0]).toMatchObject({ id: saved.id, confidence: 0.93, assigned: true });
});

test("a decision that assigns nothing writes nothing", async () => {
  const [saved] = await seed(1);
  server.defaultDecision = { assign: false, id: null, name: null, confidence: 0.2, tags: [], skipped: "none-fit" };
  const before = await NookDB.getBookmark(saved.id);

  const result = await runClassification(deps());

  expect(result.assigned).toBe(0);
  expect(result.skipped).toBe(1);
  const after = await NookDB.getBookmark(saved.id);
  // Same record: no write happened at all (updatedAt would have moved).
  expect(after).toEqual(before);
});

test("a bookmark answered 'nothing fit' is not bought a second decision", async () => {
  await seed(2);
  server.defaultDecision = { assign: false, id: null, name: null, confidence: 0.1, tags: [], skipped: "none-fit" };

  const first = await runClassification(deps());
  expect(first.processed).toBe(2);

  // Nothing was written, so there is no `ai` attribution to filter on — only
  // the processed-id cursor, which is why it has to be recorded even for a
  // pass that deliberately filed nothing.
  expect((await readCursor())?.processedIds).toHaveLength(2);
  await runClassification(deps());
  expect(server.requests).toHaveLength(2);
});

test("a request that never got a decision does not consume the bookmark's one pass", async () => {
  await seed(1);
  server.status = 503;
  await runClassification(deps());

  expect((await readCursor())?.processedIds).toHaveLength(0);

  // Once the cooldown expires it is still a candidate, and unassigned.
  clock += 60 * 60_000 + 1;
  server.status = 200;
  const result = await runClassification(deps());
  expect(result.assigned).toBe(1);
});

// -- terminal states ------------------------------------------------------

test("401 ends the run, records lastError, and does not retry within the run", async () => {
  await seed(AI_BATCH_SIZE);
  server.status = 401;

  const result = await runClassification(deps());

  // Four workers were already dispatched; none of them re-tries, and the
  // remaining 21 candidates are never sent.
  expect(server.requests.length).toBeLessThanOrEqual(AI_CONCURRENCY);
  expect(result.processed).toBe(0);
  expect(result.error).toBeTruthy();

  const cursor = await readCursor();
  expect(cursor?.lastError).toBeTruthy();
  expect(cursor?.signedOutUntil).toBeTruthy();
  expect(Date.parse(cursor!.signedOutUntil!)).toBeGreaterThan(clock);

  // The next tick inside the cooldown does no work at all.
  const second = await runClassification(deps());
  expect(second).toEqual({ processed: 0, assigned: 0, tagged: 0, skipped: 0 });
  expect(server.requests).toHaveLength(4);
});

test("503 is a state to report, not a failure to retry, and is quiet for an hour", async () => {
  await seed(AI_BATCH_SIZE);
  server.status = 503;

  const result = await runClassification(deps());

  expect(server.requests.length).toBeLessThanOrEqual(AI_CONCURRENCY);
  // No `error` in the result: a missing key on the server is a deployment state,
  // not something the user did or can fix, and `unavailableUntil` is where the
  // panel reads it from. Reporting it as an error made a quiet misconfiguration
  // show up as a red "needs attention" on this device.
  expect(result.error).toBeUndefined();
  const cursor = await readCursor();
  expect(cursor?.unavailableUntil).toBeTruthy();
  expect(cursor?.lastError).toBeUndefined();
  // An hour, not the alarm period — a server config needs a deploy, not a tick.
  expect(Date.parse(cursor!.unavailableUntil!) - clock).toBe(60 * 60_000);

  await runClassification(deps());
  expect(server.requests).toHaveLength(4);
});

// A neutral 200 from the server is NOT a decision. Swallowed as one, it entered
// the cursor and the confidence log as a 0-confidence verdict, which both
// poisoned the histogram and retired bookmarks the model never actually saw.
test("a neutral placeholder from the server is a non-decision, not a confidence-0 verdict", async () => {
  await seed(AI_BATCH_SIZE);
  server.neutral = true;

  const result = await runClassification(deps());

  expect(result.processed).toBe(0);
  expect(result.assigned).toBe(0);
  // Stopped the batch rather than paying for 25 more identical non-answers.
  expect(server.requests.length).toBeLessThanOrEqual(AI_CONCURRENCY);
  expect(result.error).toMatch(/could not reach the classification model/i);

  const cursor = await readCursor();
  expect(cursor?.processedIds ?? []).toEqual([]);
  const log = await readLog();
  expect(log).toEqual([]);

  // And the bookmarks are still eligible: nothing was recorded against them, so
  // once the backoff lapses the next pass re-asks the whole batch.
  clock += 60 * 60_000;
  server.neutral = false;
  const before = server.requests.length;
  await runClassification(deps());
  expect(server.requests.length).toBeGreaterThan(before);
  expect((await readCursor())?.assigned).toBeGreaterThan(0);
});

test.each([429, 529])("%i backs off instead of spending the rest of the batch", async (status) => {
  await seed(AI_BATCH_SIZE);
  server.status = status;

  const result = await runClassification(deps());

  expect(server.requests.length).toBeLessThanOrEqual(AI_CONCURRENCY);
  expect(result.error).toBe("Rate limited by the server — backing off.");
  const cursor = await readCursor();
  expect(cursor?.backoffMs).toBe(60_000);
  expect(Date.parse(cursor!.backoffUntil!) - clock).toBe(60_000);
});

test("a repeated rate limit doubles the backoff and a success resets it", async () => {
  await seed(1);
  server.status = 429;
  await runClassification(deps());
  expect((await readCursor())?.backoffMs).toBe(60_000);

  // Let the first cooldown expire, then get throttled again. The bookmark
  // wasn't decided, so it is still a candidate — which is the point of not
  // recording ids for requests that never got a decision.
  clock += 60_001;
  await runClassification(deps());
  expect((await readCursor())?.backoffMs).toBe(120_000);

  // Expire that one too; a clean request clears the step entirely.
  clock += 120_001;
  server.status = 200;
  await runClassification(deps());
  const cursor = await readCursor();
  expect(cursor?.backoffMs).toBe(0);
  expect(cursor?.backoffUntil).toBeUndefined();
  expect(cursor?.processed).toBe(1);
});

test("an unreachable server backs off rather than firing the rest of the batch", async () => {
  await seed(AI_BATCH_SIZE);
  // Only the classify route is unreachable — the settings GET this tick also
  // makes must still answer, or the run would never get past the toggle check
  // at all and this test would be exercising the wrong gate entirely.
  const throwing: AiRunnerDeps["fetch"] = async (input, init) => {
    if (input.endsWith("/api/ai/settings")) return server.respondSettings(init);
    throw new TypeError("Failed to fetch");
  };

  const result = await runClassification(deps({ fetch: throwing }));

  expect(result.error).toBe("Could not reach the classification endpoint.");
  expect((await readCursor())?.backoffUntil).toBeTruthy();
});

test("a non-terminal server error is recorded but does not stop the batch", async () => {
  await seed(2);
  server.status = 500;

  const result = await runClassification(deps());

  expect(result.processed).toBe(0);
  expect(result.error).toBe("Classify request failed (500)");
  expect(server.requests).toHaveLength(2);
  expect((await readCursor())?.backoffUntil).toBeUndefined();
});

// -- malformed responses --------------------------------------------------

test("a malformed body degrades to nothing assigned without throwing", async () => {
  const [saved] = await seed(1);
  server.malformed = true;
  const before = await NookDB.getBookmark(saved.id);

  const result = await runClassification(deps());

  expect(result).toEqual({ processed: 1, assigned: 0, tagged: 0, skipped: 1 });
  expect(result.error).toBeUndefined();
  expect(await NookDB.getBookmark(saved.id)).toEqual(before);
  // A body we could not read still has a row in the histogram, at 0.
  expect(await readLog()).toEqual([
    { id: saved.id, confidence: 0, assigned: false, at: new Date(clock).toISOString() },
  ]);
});

test("a 200 with a truncated collection block is also treated as no decision", async () => {
  await seed(1);
  const truncated: AiRunnerDeps["fetch"] = async (input, init) => {
    if (input.endsWith("/api/ai/settings")) return server.respondSettings(init);
    return new Response(JSON.stringify({ model: "jev-1.13.0", collection: { assign: true } }), { status: 200 });
  };

  const result = await runClassification(deps({ fetch: truncated }));

  expect(result).toEqual({ processed: 1, assigned: 0, tagged: 0, skipped: 1 });
});

// -- progress records -----------------------------------------------------

test("the decision log is a ring buffer that never exceeds its cap", async () => {
  // Pre-fill it to just under the cap, then run two ticks' worth of decisions.
  const seeded = 190;
  await NookDB.setMeta(
    AI_LOG_META_KEY,
    Array.from({ length: seeded }, (_, index) => ({
      id: `old-${index}`,
      confidence: 0.5,
      assigned: false,
      at: "2025-01-01T00:00:00.000Z",
    })),
  );
  await seed(30);

  await runClassification(deps());
  await runClassification(deps());

  const log = await readLog();
  expect(log).toHaveLength(AI_LOG_MAX_ENTRIES);
  // Oldest first: 20 of the seeded entries fell off the front.
  expect(log[0].id).toBe(`old-${20}`);
  // The surviving tail is the 190-20 still-seeded entries plus all 30
  // decisions, each exactly once. Which of the 30 landed in which tick is
  // selectCandidates' ordering, not the log buffer's business.
  const tail = log.slice(AI_LOG_MAX_ENTRIES - 30).map((entry) => entry.id);
  expect(tail.length).toBe(30);
  expect(new Set(tail)).toEqual(new Set(Array.from({ length: 30 }, (_, index) => `b-${index}`)));
  expect(new Set(log.map((entry) => entry.id)).size).toBe(AI_LOG_MAX_ENTRIES);
});

test("cursor counters are cumulative across ticks and cleared of a stale error by a clean run", async () => {
  await seed(2);
  server.status = 500;
  await runClassification(deps());
  expect((await readCursor())?.lastError).toBe("Classify request failed (500)");

  server.status = 200;
  clock += 1000;
  await runClassification(deps());

  const cursor = await readCursor();
  expect(cursor?.processed).toBe(2);
  expect(cursor?.assigned).toBe(2);
  expect(cursor?.lastError).toBeUndefined();
  expect(cursor?.lastRunAt).toBe(new Date(clock).toISOString());
});

// -- the taxonomy the runner only reads -----------------------------------

test("a taxonomy entry enriches the live list it names, and an orphan is ignored", async () => {
  await NookDB.setMeta("ai.taxonomy", [
    { id: "list-1", name: "Reading", samples: ["A curated sample"] },
    { id: "ghost", name: "Never Accepted", samples: ["A proposal nobody took"] },
  ]);
  await seed(1);

  await runClassification(deps());

  const collections = server.requests[0].collections;
  // Only the real BookmarkList is offered: an orphan would hand back a listId
  // that nothing backs.
  expect(collections).toEqual([
    { id: "list-1", name: "Reading", samples: ["A curated sample"] },
  ]);
});

test("a taxonomy value of the wrong shape does not fail the tick", async () => {
  await NookDB.setMeta("ai.taxonomy", { accepted: "yesterday" });
  await seed(1);

  const result = await runClassification(deps());

  expect(result.processed).toBe(1);
  expect(server.requests[0].collections).toEqual([{ id: "list-1", name: "Reading", samples: [] }]);
});

test("an absent taxonomy is simply no extra samples", async () => {
  await seed(1);
  await runClassification(deps());
  expect(server.requests[0].collections).toEqual([{ id: "list-1", name: "Reading", samples: [] }]);
});

test("the accepted-taxonomy date is stamped on the attribution, not the decision time", async () => {
  const [saved] = await seed(1);
  await NookDB.setMeta("ai.taxonomy", {
    acceptedAt: "2025-11-30T09:00:00.000Z",
    collections: [{ id: "list-1", name: "Reading", samples: [] }],
  });

  await runClassification(deps());

  const attribution = (await NookDB.getBookmark(saved.id))?.ai as { taxonomyAt?: string } | undefined;
  expect(attribution?.taxonomyAt).toBe("2025-11-30T09:00:00.000Z");
});

test("an unreadable accepted-taxonomy date is left off rather than guessed", async () => {
  const [saved] = await seed(1);
  await NookDB.setMeta("ai.taxonomy", { acceptedAt: "last tuesday", collections: [] });

  await runClassification(deps());

  const attribution = (await NookDB.getBookmark(saved.id))?.ai as { taxonomyAt?: string } | undefined;
  expect(attribution).toBeDefined();
  expect(attribution?.taxonomyAt).toBeUndefined();
});

test("tags are offered as options, most frequent first", async () => {
  await seed(3, (index) => (index < 2 ? { tags: ["Rare"] } : { tags: ["Common", "Rare"] }));
  await runClassification(deps());

  expect(server.requests[0].tags.map((tag) => tag.name)).toEqual(["rare", "common"]);
});

// -- single flight --------------------------------------------------------

test("a second call joins the in-flight run instead of billing the batch twice", async () => {
  await seed(AI_BATCH_SIZE);
  expect(isAiRunInFlight()).toBe(false);

  const first = runClassification(deps());
  const second = runClassification(deps());
  expect(isAiRunInFlight()).toBe(true);

  // One batch of requests, not two, and the second caller got the first
  // caller's run — not a second pass that would bill the same 25 records.
  expect(await second).toBe(await first);
  expect(server.requests).toHaveLength(AI_BATCH_SIZE);
  expect(isAiRunInFlight()).toBe(false);
});

test("settings can be injected through deps", async () => {
  await seed(1);
  const off: AiSettings = { ...DEFAULT_AI_SETTINGS, autoClassify: false };

  const result = await runClassification(deps({ loadSettings: async () => off }));

  expect(result.processed).toBe(0);
  expect(server.requests).toHaveLength(0);
});
