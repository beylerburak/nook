// The extension's whole relationship with the classifier is lib/ai-client.ts
// (see docs/ai-cloud-contract.md). This file covers the two halves of it that
// the settings panel cannot cover for us: the status/error mapping each route
// applies before it decides what to hand back, and the tolerant parsing that
// stands between a hand-edited or future server body and a crash in the
// settings dialog.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  _resetAiClientForTests,
  acceptClusters,
  acceptTaxonomy,
  announceAiStatusChange,
  loadAiStatus,
  loadReview,
  requestClassificationRun,
  requestClusterProposals,
  requestTaxonomyProposals,
  resolveReview,
  subscribeToAiStatus,
  type AiStatus,
} from "../lib/ai-client";
import { DEFAULT_AI_SETTINGS } from "../lib/ai-settings";
import { DEFAULT_CLOUD_API_URL, configureCloud, saveCloudSession, type RequestAuth } from "../lib/cloud-sync";
import * as NookDB from "../lib/db";

const API_URL = "https://api.example.com";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function bearer(): RequestAuth {
  return { mode: "bearer", token: "test-token" };
}

/** A route stub that records what it was asked and answers whatever the test set. */
class MockRoute {
  calls: Array<{ url: string; method: string; body: unknown; headers: Record<string, string>; credentials?: string }> = [];
  response: (init: RequestInit) => Response = () => json({});
  throws: Error | null = null;

  fetch = async (input: string, init: RequestInit): Promise<Response> => {
    this.calls.push({
      url: input,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      headers: (init.headers as Record<string, string>) ?? {},
      ...(init.credentials !== undefined ? { credentials: init.credentials } : {}),
    });
    if (this.throws) throw this.throws;
    return this.response(init);
  };
}

let route: MockRoute;

function deps(overrides: Partial<Parameters<typeof loadAiStatus>[0]> = {}) {
  return { fetch: route.fetch, apiUrl: API_URL, session: async () => bearer(), ...overrides };
}

/** A status body shaped exactly like the contract's `AiStatusResponse`. */
function statusBody(overrides: Record<string, unknown> = {}) {
  return {
    available: true,
    settings: { ...DEFAULT_AI_SETTINGS, autoClassify: true },
    pending: 0,
    taxonomy: { acceptedAt: null, collections: [], tags: [] },
    run: { processed: 0, assigned: 0, tagged: 0, skipped: 0, lastRunAt: null, lastError: null, isUnavailable: false, isBackingOff: false, log: [] },
    summarize: { available: true, model: "gpt-4o-mini", pending: 0, summarised: 0, written: 0, skipped: 0, lastRunAt: null, lastError: null, isUnavailable: false, isBackingOff: false },
    ...overrides,
  };
}

/** The filled reading of a `summarize` the server did not send — a build that
 *  predates the summarisation pass, which is the only way this can be absent. */
const NO_SUMMARISER = {
  available: false,
  model: "",
  pending: 0,
  summarised: 0,
  written: 0,
  skipped: 0,
  lastRunAt: null,
  lastError: null,
  isUnavailable: false,
  isBackingOff: false,
};

beforeEach(async () => {
  route = new MockRoute();
  _resetAiClientForTests();
  NookDB._resetForTests();
  // The global fetch and a stored bearer session are what the no-deps path —
  // the one the settings panel and subscribeToAiStatus use — resolves, so they
  // are the default in this file and the injected `deps()` are the exception.
  vi.stubGlobal("fetch", route.fetch);
  await saveCloudSession("test-token", "user-1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  configureCloud({ apiUrl: DEFAULT_CLOUD_API_URL, auth: "bearer" });
});

describe("the session gate", () => {
  test("every call reports signed out before it builds a request", async () => {
    const session = async () => null;
    expect(await loadAiStatus(deps({ session }))).toBeNull();
    expect(await requestClassificationRun(deps({ session }))).toBeNull();
    expect((await requestTaxonomyProposals(deps({ session }))).kind).toBe("signed-out");
    expect((await acceptTaxonomy({ collections: ["Tasarım"], tags: [] }, deps({ session }))).kind).toBe("signed-out");
    expect((await loadReview(deps({ session }))).kind).toBe("signed-out");
    expect((await resolveReview({ items: [{ bookmarkId: "b-1", action: "accept" }] }, deps({ session }))).kind).toBe("signed-out");
    expect((await requestClusterProposals(deps({ session }))).kind).toBe("signed-out");
    expect((await acceptClusters({ collections: [{ name: "Design", memberIds: ["b-1"] }] }, deps({ session }))).kind).toBe("signed-out");
    // The point of the gate: a signed-out browser must not reach the network.
    expect(route.calls).toHaveLength(0);
  });

  test("a bearer session goes out as an Authorization header", async () => {
    route.response = () => json(statusBody());
    await loadAiStatus(deps());
    expect(route.calls[0]).toMatchObject({
      url: `${API_URL}/api/ai/status`,
      method: "GET",
      headers: { Authorization: "Bearer test-token" },
    });
    expect(route.calls[0].credentials).toBeUndefined();
  });

  // The web app has no bearer token to send — it authenticates with the session
  // cookie the browser attaches itself. Getting this branch right is the whole
  // reason the panel can do any of this on the web host.
  test("a cookie session goes out as credentials, with no Authorization header", async () => {
    route.response = () => json(statusBody());
    await loadAiStatus(deps({ session: async () => ({ mode: "cookie" }) }));
    expect(route.calls[0].headers.Authorization).toBeUndefined();
    expect(route.calls[0].credentials).toBe("include");
  });
});

describe("status mapping", () => {
  test("401 is signed out, on every route", async () => {
    route.response = () => json({ error: "no session" }, 401);
    expect(await loadAiStatus(deps())).toBeNull();
    expect(await requestClassificationRun(deps())).toBeNull();
    expect((await requestTaxonomyProposals(deps())).kind).toBe("signed-out");
    expect((await acceptTaxonomy({ collections: ["a"], tags: [] }, deps())).kind).toBe("signed-out");
    expect((await loadReview(deps())).kind).toBe("signed-out");
    expect((await resolveReview({ items: [{ bookmarkId: "b-1", action: "accept" }] }, deps())).kind).toBe("signed-out");
    expect((await requestClusterProposals(deps())).kind).toBe("signed-out");
    expect((await acceptClusters({ collections: [{ name: "Design", memberIds: ["b-1"] }] }, deps())).kind).toBe("signed-out");
  });

  test("503 is unavailable — a missing server key, not a failure", async () => {
    route.response = () => json({ error: "not configured" }, 503);
    expect((await requestTaxonomyProposals(deps())).kind).toBe("unavailable");
    expect((await acceptTaxonomy({ collections: ["a"], tags: [] }, deps())).kind).toBe("unavailable");
    expect((await requestClusterProposals(deps())).kind).toBe("unavailable");
    expect((await acceptClusters({ collections: [{ name: "Design", memberIds: ["b-1"] }] }, deps())).kind).toBe("unavailable");
  });

  test("429 and 529 are throttled", async () => {
    for (const status of [429, 529]) {
      route.response = () => json({ error: "slow down" }, status);
      expect((await requestTaxonomyProposals(deps())).kind).toBe("throttled");
      expect((await loadReview(deps())).kind).toBe("throttled");
      expect((await requestClusterProposals(deps())).kind).toBe("throttled");
    }
  });

  test("any other non-2xx is failed, with the status in the message", async () => {
    route.response = () => json({ error: "boom" }, 418);
    const outcome = await requestTaxonomyProposals(deps());
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("418");

    const accept = await acceptTaxonomy({ collections: ["a"], tags: [] }, deps());
    expect(accept.kind === "failed" && accept.message).toContain("418");
  });

  test("a thrown fetch is failed rather than an unhandled rejection", async () => {
    route.throws = new TypeError("offline");
    const outcome = await requestTaxonomyProposals(deps());
    expect(outcome).toEqual({ kind: "failed", message: "Could not reach the taxonomy proposal endpoint." });
    // The two null-returning calls stay null rather than throwing at the caller.
    expect(await loadAiStatus(deps())).toBeNull();
    expect(await requestClassificationRun(deps())).toBeNull();
  });
});

describe("loadAiStatus", () => {
  test("reads the account's status from the server", async () => {
    route.response = () =>
      json(
        statusBody({
          pending: 12,
          run: { processed: 25, assigned: 18, tagged: 40, skipped: 7, lastRunAt: "2026-09-20T10:00:00.000Z", lastError: null, isUnavailable: false, isBackingOff: false, log: [{ id: "b-1", confidence: 0.91, assigned: true, at: "2026-09-20T10:00:00.000Z" }] },
        }),
      );
    const status = await loadAiStatus(deps());
    expect(status?.pending).toBe(12);
    expect(status?.run.assigned).toBe(18);
    expect(status?.run.skipped).toBe(7);
    expect(status?.run.lastRunAt).toBe("2026-09-20T10:00:00.000Z");
    expect(status?.run.log).toEqual([{ id: "b-1", confidence: 0.91, assigned: true, at: "2026-09-20T10:00:00.000Z" }]);
    expect(status?.settings.autoClassify).toBe(true);
  });

  // Every field is filled rather than trusted, because these numbers are what a
  // user reads as fact and a hand-edited body must not be able to crash the
  // settings dialog on the way to the screen.
  test("fills a body that is missing everything, rather than throwing", async () => {
    route.response = () => json({});
    const status = await loadAiStatus(deps());
    expect(status).toEqual({
      available: false,
      settings: DEFAULT_AI_SETTINGS,
      pending: 0,
      taxonomy: { acceptedAt: null, collections: [], tags: [] },
      run: { processed: 0, assigned: 0, tagged: 0, skipped: 0, lastRunAt: null, lastError: null, isUnavailable: false, isBackingOff: false, log: [] },
      // The same filling as `run`, and the reason a build without the
      // summarisation pass renders as the missing deploy it is rather than
      // crashing the panel.
      summarize: NO_SUMMARISER,
      reviewCount: 0,
    });
  });

  test("a body that is not an object at all is still a status", async () => {
    route.response = () => json("nope");
    const status = await loadAiStatus(deps());
    expect(status?.pending).toBe(0);
    expect(status?.available).toBe(false);
  });

  test("normalizes a garbled run record and a garbled settings row", async () => {
    route.response = () =>
      json(
        statusBody({
          settings: { collectionMinConfidence: 7, maxTags: "nope", autoClassify: true },
          run: { assigned: "eighteen", skipped: 2.7, lastRunAt: 5, isUnavailable: "yes", log: [{ confidence: 0.5 }, { id: "b-2", confidence: "x" }] },
        }),
      );
    const status = await loadAiStatus(deps());
    expect(status?.settings.collectionMinConfidence).toBe(1);
    expect(status?.settings.maxTags).toBe(DEFAULT_AI_SETTINGS.maxTags);
    expect(status?.run.assigned).toBe(0);
    expect(status?.run.skipped).toBe(2);
    expect(status?.run.lastRunAt).toBeNull();
    expect(status?.run.isUnavailable).toBe(false);
    // A log entry with no id is not a decision anything could be read from.
    expect(status?.run.log).toEqual([{ id: "b-2", confidence: 0, assigned: false, at: "" }]);
  });

  test("reads a partial accepted taxonomy, keeping what is readable", async () => {
    route.response = () =>
      json(
        statusBody({
          taxonomy: {
            acceptedAt: "2026-09-01T00:00:00.000Z",
            collections: [{ id: "l1", name: "Tasarım", samples: ["A note"] }, { name: "  " }, "nonsense"],
            tags: [{ name: "ücretsiz", definition: "free to use" }, "not-an-object"],
          },
        }),
      );
    const status = await loadAiStatus(deps());
    expect(status?.taxonomy).toEqual({
      acceptedAt: "2026-09-01T00:00:00.000Z",
      collections: [{ id: "l1", name: "Tasarım", samples: ["A note"] }],
      tags: [{ name: "ücretsiz", definition: "free to use" }],
    });
  });

  test("reads the summarisation half of the status", async () => {
    route.response = () =>
      json(
        statusBody({
          summarize: {
            available: true,
            model: "gpt-4o-mini",
            pending: 12,
            summarised: 240,
            written: 25,
            skipped: 3,
            lastRunAt: "2026-09-26T09:30:00.000Z",
            lastError: null,
            isUnavailable: false,
            isBackingOff: false,
          },
        }),
      );
    const status = await loadAiStatus(deps());
    expect(status?.summarize).toEqual({
      available: true,
      model: "gpt-4o-mini",
      pending: 12,
      // The count the panel's "In your library" row is a claim about: a server
      // count over the records, not the upper bound a local count could reach.
      summarised: 240,
      written: 25,
      skipped: 3,
      lastRunAt: "2026-09-26T09:30:00.000Z",
      lastError: null,
      isUnavailable: false,
      isBackingOff: false,
    });
  });

  // `summarize` is additive on the wire, so a server build that predates the
  // pass sends a status without it. That has to read as a deployment with no
  // summariser — which is what such a build is — rather than as a crash or a
  // library the user has never summarised.
  test("a build that predates the field reads as a server with no summariser", async () => {
    route.response = () => {
      const body = statusBody();
      delete (body as Record<string, unknown>).summarize;
      return json(body);
    };
    const status = await loadAiStatus(deps());
    expect(status?.summarize).toEqual(NO_SUMMARISER);
    // The classification half is untouched by the absence.
    expect(status?.available).toBe(true);
    expect(status?.pending).toBe(0);
  });

  test("a summarize that is not an object at all is still a status", async () => {
    route.response = () => json(statusBody({ summarize: "unavailable" }));
    const status = await loadAiStatus(deps());
    expect(status?.summarize).toEqual(NO_SUMMARISER);
  });

  // Field by field, the same discipline as `run`: a counter it cannot read is 0,
  // a date it cannot read is null, a flag it cannot read is false, and a model
  // it cannot read is "" rather than a name the panel would print.
  test("normalizes a garbled summarize record", async () => {
    route.response = () =>
      json(
        statusBody({
          summarize: {
            available: "yes",
            model: 7,
            pending: -3,
            summarised: 240.9,
            written: "25",
            skipped: null,
            lastRunAt: 1756183800,
            lastError: { message: "nope" },
            isUnavailable: "true",
            isBackingOff: 1,
          },
        }),
      );
    const status = await loadAiStatus(deps());
    expect(status?.summarize).toEqual({
      available: false,
      model: "",
      pending: 0,
      // A fractional count is floored, never rendered as "240.9 summaries".
      summarised: 240,
      written: 0,
      skipped: 0,
      lastRunAt: null,
      lastError: null,
      isUnavailable: false,
      isBackingOff: false,
    });
  });
});

describe("requestClassificationRun", () => {
  test("POSTs an empty body and reports only how much each queue got", async () => {
    route.response = () => json({ queued: 3, summariesQueued: 8, status: statusBody({ pending: 3 }) });
    const result = await requestClassificationRun(deps());
    expect(result).toEqual({ queued: 3, summariesQueued: 8 });
    // The contract's whole point: the reply is a queue depth, not a pass
    // result, so there is nothing here to claim was filed or written.
    expect(route.calls[0]).toMatchObject({ url: `${API_URL}/api/ai/run`, method: "POST", body: {} });
  });

  // Each half of the route is gated on its own toggle, so one depth can be zero
  // while the other is not, and a build predating the second reports neither.
  // Both have to be a number the panel can put in a sentence.
  test("reads a missing or nonsense queued count as zero, for both queues", async () => {
    route.response = () => json({});
    expect(await requestClassificationRun(deps())).toEqual({ queued: 0, summariesQueued: 0 });
    route.response = () => json({ queued: -4, summariesQueued: "eight" });
    expect(await requestClassificationRun(deps())).toEqual({ queued: 0, summariesQueued: 0 });
    // Summaries only: an account with `autoSummarize` on and `autoClassify` off.
    route.response = () => json({ queued: 0, summariesQueued: 5 });
    expect(await requestClassificationRun(deps())).toEqual({ queued: 0, summariesQueued: 5 });
  });
});

describe("requestTaxonomyProposals", () => {
  test("sends the language only when it is not `auto`", async () => {
    route.response = () => json({ sampleSize: 0, existingCollections: [] });
    await requestTaxonomyProposals({ ...deps(), language: "auto" });
    expect(route.calls[0]).toMatchObject({ url: `${API_URL}/api/ai/taxonomy/propose`, method: "POST", body: {} });

    await requestTaxonomyProposals({ ...deps(), language: "tr" });
    expect(route.calls[1].body).toEqual({ language: "tr" });
  });

  test("reads a well-formed response", async () => {
    route.response = () =>
      json({
        sampleSize: 200,
        collections: [{ name: "Tasarım", why: "Design systems." }],
        tags: [{ name: "ücretsiz", why: "free", coveredBy: ["Tasarım"] }],
        existingCollections: ["Reading"],
      });
    const outcome = await requestTaxonomyProposals(deps());
    expect(outcome).toEqual({
      kind: "proposals",
      sampleSize: 200,
      proposals: [{ name: "Tasarım", why: "Design systems." }],
      tags: [{ name: "ücretsiz", why: "free", coveredBy: ["Tasarım"] }],
      existingCollections: ["Reading"],
    });
  });

  test("a 200 that names nothing is a decline, not a failure", async () => {
    route.response = () => json({ sampleSize: 200, collections: [], tags: [] });
    expect(await requestTaxonomyProposals(deps())).toEqual({
      kind: "proposals",
      sampleSize: 200,
      proposals: [],
      tags: [],
      existingCollections: [],
    });
  });

  // The server samples its own records, so "there was nothing to read" is its
  // call — and a sample of nothing is how it says so. Kept apart from a decline,
  // which is the same empty answer with a real sample behind it.
  test("an empty body is nothing to read, and an answer that names something is never swallowed by that", async () => {
    route.response = () => json({});
    expect(await requestTaxonomyProposals(deps())).toEqual({ kind: "nothing-to-read" });

    route.response = () => json({ sampleSize: 0, collections: [{ name: "Tasarım", why: "Design." }], tags: [] });
    const outcome = await requestTaxonomyProposals(deps());
    expect(outcome.kind).toBe("proposals");
    expect(outcome.kind === "proposals" && outcome.proposals).toEqual([{ name: "Tasarım", why: "Design." }]);
  });

  test("drops a collection proposal with no reason, which the review list cannot show", async () => {
    route.response = () => json({ collections: [{ name: "Tasarım" }, { name: "Sistem", why: "Servers." }], tags: [] });
    const outcome = await requestTaxonomyProposals(deps());
    expect(outcome.kind === "proposals" && outcome.proposals).toEqual([{ name: "Sistem", why: "Servers." }]);
  });

  // The default matters: an empty `coveredBy` is what makes a tag start ticked,
  // so a server build that predates the field offers every tag rather than
  // silently unticking all of them.
  test("defaults a tag's coveredBy to empty, and keeps a tag with no reason usable", async () => {
    route.response = () => json({ collections: [], tags: [{ name: "ücretsiz" }, { name: "tasarım", coveredBy: "not-an-array" }] });
    const outcome = await requestTaxonomyProposals(deps());
    expect(outcome.kind === "proposals" && outcome.tags).toEqual([
      { name: "ücretsiz", coveredBy: [] },
      { name: "tasarım", coveredBy: [] },
    ]);
  });
});

describe("acceptTaxonomy", () => {
  test("PUTs names, and a tag's definition with its name", async () => {
    route.response = () => json({ createdCollections: 2, addedTags: 1, dropped: 0, taxonomy: { acceptedAt: null, collections: [], tags: [] } });
    const result = await acceptTaxonomy(
      { collections: ["Tasarım", "Sistem"], tags: [{ name: "ücretsiz", definition: "Ücretsiz planlar." }] },
      deps(),
    );
    expect(result.kind).toBe("accepted");
    // Nothing else travels: the sample, the live lists and the library's own tags
    // are the server's to read, and a re-sent snapshot could be stale.
    expect(route.calls[0]).toMatchObject({
      url: `${API_URL}/api/ai/taxonomy`,
      method: "PUT",
      body: { collections: ["Tasarım", "Sistem"], tags: [{ name: "ücretsiz", definition: "Ücretsiz planlar." }] },
    });
  });

  // The definition is dropped by the caller, not by this module, so a tag the
  // proposer gave no reason for must not acquire a `definition: undefined` key
  // that JSON.stringify would then send as absent anyway.
  test("a tag with no definition sends only its name", async () => {
    route.response = () => json({ createdCollections: 0, addedTags: 1, dropped: 0, taxonomy: { acceptedAt: null, collections: [], tags: [] } });
    await acceptTaxonomy({ collections: [], tags: [{ name: "ücretsiz" }] }, deps());
    expect(route.calls[0]).toMatchObject({ body: { tags: [{ name: "ücretsiz" }] } });
  });

  test("reports what the server actually did with the names", async () => {
    route.response = () => json({ createdCollections: 1, addedTags: 0, dropped: 2, taxonomy: { acceptedAt: null, collections: [], tags: [] } });
    const result = await acceptTaxonomy({ collections: ["a"], tags: [] }, deps());
    expect(result).toMatchObject({ kind: "accepted", createdCollections: 1, addedTags: 0, dropped: 2 });
  });
});

describe("loadReview", () => {
  test("reads the review list, highest confidence first as the server sent it", async () => {
    route.response = () =>
      json({
        items: [
          { bookmarkId: "b-1", listId: "list-1", listName: "Design", confidence: 0.72 },
          { bookmarkId: "b-2", listId: "list-2", listName: "Reading", confidence: 0.55 },
        ],
        total: 2,
      });
    const outcome = await loadReview(deps());
    expect(outcome).toEqual({
      kind: "items",
      items: [
        { bookmarkId: "b-1", listId: "list-1", listName: "Design", confidence: 0.72 },
        { bookmarkId: "b-2", listId: "list-2", listName: "Reading", confidence: 0.55 },
      ],
      total: 2,
    });
    expect(route.calls[0]).toMatchObject({ url: `${API_URL}/api/ai/review`, method: "GET" });
  });

  test("drops a row missing a bookmark id or a collection id", async () => {
    route.response = () =>
      json({
        items: [
          { bookmarkId: "b-1", listId: "list-1", confidence: 0.6 },
          { bookmarkId: "", listId: "list-2", confidence: 0.9 },
          { listId: "list-3", confidence: 0.9 },
        ],
        total: 3,
      });
    const outcome = await loadReview(deps());
    expect(outcome.kind).toBe("items");
    expect(outcome.kind === "items" && outcome.items).toEqual([{ bookmarkId: "b-1", listId: "list-1", listName: "list-1", confidence: 0.6 }]);
  });

  test("fills a missing or nonsense body with an empty list", async () => {
    route.response = () => json({});
    expect(await loadReview(deps())).toEqual({ kind: "items", items: [], total: 0 });
  });

  test("any other non-2xx is failed, with the status in the message", async () => {
    route.response = () => json({ error: "boom" }, 418);
    const outcome = await loadReview(deps());
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("418");
  });
});

describe("resolveReview", () => {
  test("POSTs the batch and reports the three-way split", async () => {
    route.response = () => json({ filed: 3, rejected: 1, skipped: 0 });
    const result = await resolveReview(
      { items: [{ bookmarkId: "b-1", action: "accept" }, { bookmarkId: "b-2", action: "reject" }] },
      deps(),
    );
    expect(result).toEqual({ kind: "resolved", filed: 3, rejected: 1, skipped: 0 });
    expect(route.calls[0]).toMatchObject({
      url: `${API_URL}/api/ai/review/resolve`,
      method: "POST",
      body: { items: [{ bookmarkId: "b-1", action: "accept" }, { bookmarkId: "b-2", action: "reject" }] },
    });
  });

  test("sends an accept into a different collection than the one Jev guessed", async () => {
    route.response = () => json({ filed: 1, rejected: 0, skipped: 0 });
    await resolveReview({ items: [{ bookmarkId: "b-1", action: "accept", listId: "list-9" }] }, deps());
    expect(route.calls[0].body).toEqual({ items: [{ bookmarkId: "b-1", action: "accept", listId: "list-9" }] });
  });

  test("a thrown fetch is failed rather than an unhandled rejection", async () => {
    route.throws = new TypeError("offline");
    const outcome = await resolveReview({ items: [{ bookmarkId: "b-1", action: "accept" }] }, deps());
    expect(outcome).toEqual({ kind: "failed", message: "Could not reach Nook's server to save that." });
  });
});

describe("requestClusterProposals", () => {
  test("sends the language only when it is not `auto`", async () => {
    route.response = () => json({ proposals: [], unclustered: 0, considered: 0 });
    await requestClusterProposals({ ...deps(), language: "auto" });
    expect(route.calls[0]).toMatchObject({ url: `${API_URL}/api/ai/clusters/propose`, method: "POST", body: {} });

    await requestClusterProposals({ ...deps(), language: "tr" });
    expect(route.calls[1].body).toEqual({ language: "tr" });
  });

  test("reads a well-formed response, including an existing-collection match", async () => {
    route.response = () =>
      json({
        proposals: [
          {
            id: "c1",
            name: "Design",
            why: "Design systems and UI craft.",
            size: 12,
            memberIds: ["b-1", "b-2"],
            sampleTitles: ["A design system", "On grids"],
            existingListId: "list-design",
          },
        ],
        unclustered: 87,
        considered: 412,
      });
    const outcome = await requestClusterProposals(deps());
    expect(outcome).toEqual({
      kind: "proposals",
      proposals: [
        {
          id: "c1",
          name: "Design",
          why: "Design systems and UI craft.",
          size: 12,
          memberIds: ["b-1", "b-2"],
          sampleTitles: ["A design system", "On grids"],
          existingListId: "list-design",
        },
      ],
      unclustered: 87,
      considered: 412,
    });
  });

  test("drops a group with no name or no members, and defaults size to the member count", async () => {
    route.response = () =>
      json({
        proposals: [
          { name: "", memberIds: ["b-1"] },
          { name: "Empty group", memberIds: [] },
          { name: "Reading", memberIds: ["b-3", "b-4"] },
        ],
        unclustered: 0,
        considered: 0,
      });
    const outcome = await requestClusterProposals(deps());
    expect(outcome.kind === "proposals" && outcome.proposals).toEqual([
      { id: "Reading", name: "Reading", why: "", size: 2, memberIds: ["b-3", "b-4"], sampleTitles: [], existingListId: null },
    ]);
  });

  test("503 is unavailable, same as the taxonomy proposer", async () => {
    route.response = () => json({ error: "not configured" }, 503);
    expect((await requestClusterProposals(deps())).kind).toBe("unavailable");
  });
});

describe("acceptClusters", () => {
  test("PUTs the kept groups and reports what the server filed", async () => {
    route.response = () => json({ createdCollections: 2, filed: 18, skipped: 1 });
    const result = await acceptClusters(
      { collections: [{ name: "Design", memberIds: ["b-1", "b-2"] }, { name: "Reading", memberIds: ["b-3"], existingListId: "list-reading" }] },
      deps(),
    );
    expect(result).toEqual({ kind: "accepted", createdCollections: 2, filed: 18, skipped: 1 });
    expect(route.calls[0]).toMatchObject({
      url: `${API_URL}/api/ai/clusters/accept`,
      method: "PUT",
      body: {
        collections: [
          { name: "Design", memberIds: ["b-1", "b-2"] },
          { name: "Reading", memberIds: ["b-3"], existingListId: "list-reading" },
        ],
      },
    });
  });

  test("any other non-2xx is failed, with the status in the message", async () => {
    route.response = () => json({ error: "boom" }, 418);
    const outcome = await acceptClusters({ collections: [{ name: "Design", memberIds: ["b-1"] }] }, deps());
    expect(outcome.kind).toBe("failed");
    expect(outcome.kind === "failed" && outcome.message).toContain("418");
  });
});

describe("subscribeToAiStatus", () => {
  test("emits once on subscribe, with the current status", async () => {
    route.response = () => json(statusBody({ pending: 4 }));
    const seen: Array<AiStatus | null> = [];
    const unsubscribe = subscribeToAiStatus((status) => seen.push(status));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]?.pending).toBe(4);
    unsubscribe();
  });

  // A run requested in this context, or a settings save in another one, is
  // announced on the "nook-db" channel every subscriber here already opens.
  test("re-reads when the context announces a change", async () => {
    route.response = () => json(statusBody({ pending: 1 }));
    const seen: Array<AiStatus | null> = [];
    const unsubscribe = subscribeToAiStatus((status) => seen.push(status));
    await vi.waitFor(() => expect(seen).toHaveLength(1));

    route.response = () => json(statusBody({ pending: 0 }));
    announceAiStatusChange();
    // Once through this context's own listeners and once more through the
    // channel this call also posts on, so the count is not fixed — what matters
    // is that the last thing the subscriber was told is the new value.
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(2));
    await vi.waitFor(() => expect(seen[seen.length - 1]?.pending).toBe(0));

    unsubscribe();
  });

  test("stops reading once unsubscribed", async () => {
    route.response = () => json(statusBody());
    const seen: Array<AiStatus | null> = [];
    const unsubscribe = subscribeToAiStatus((status) => seen.push(status));
    await vi.waitFor(() => expect(seen).toHaveLength(1));
    unsubscribe();
    announceAiStatusChange();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toHaveLength(1);
  });
});

describe("the default (no-deps) path", () => {
  test("reads the server with the global fetch and the stored session", async () => {
    route.response = () => json(statusBody({ pending: 3 }));
    const status = await loadAiStatus();
    expect(status?.pending).toBe(3);
    expect(route.calls[0]).toMatchObject({
      url: `${DEFAULT_CLOUD_API_URL}/api/ai/status`,
      headers: { Authorization: "Bearer test-token" },
    });
  });

  test("a browser with no account bound is null, and makes no request", async () => {
    // The default `session` is cloudRequestAuth(), which is null with no token
    // stored — a local-only extension, or a web tab before its first sign-in.
    await NookDB.setMeta("cloud:https://nook.beyler.co:token", null);
    expect(await loadAiStatus()).toBeNull();
    expect(route.calls).toHaveLength(0);
  });
});
