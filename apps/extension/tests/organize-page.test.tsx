// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "@astryxdesign/core/Toast";
import { NookHostProvider, type NookHost } from "../src/app/host/NookHost";
import { OrganizePage } from "../src/app/dashboard/organize/OrganizePage";
import { ReviewListProvider } from "../src/app/dashboard/organize/useReviewList";
import { _resetAiClientForTests } from "../lib/ai-client";
import { DEFAULT_AI_SETTINGS, _resetAiSettingsCacheForTests, type AiSettings } from "../lib/ai-settings";
import { configureCloud, saveCloudSession } from "../lib/cloud-sync";
import * as NookDB from "../lib/db";
import type { Bookmark, BookmarkList } from "../lib/types";

vi.mock("../src/app/host/useCloudStatus", () => ({
  useCloudStatus: () => null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// -- the AI routes the Organize page touches ---------------------------------
//
// GET/PUT /api/ai/settings and GET /api/ai/status back the page's header and
// outage banner (same shape as tests/settings-ai-panel.test.tsx's router);
// POST /api/ai/clusters/propose + PUT /api/ai/clusters/accept back the
// primary "Suggest collections" block; GET /api/ai/review + POST
// /api/ai/review/resolve back "Needs your review"; POST
// /api/ai/taxonomy/propose + PUT /api/ai/taxonomy back the secondary
// "Suggest tags" action (useSuggestCollections.ts, tagsOnly mode) — same
// routes the old primary flow used to call.

class MockSettingsServer {
  settings: AiSettings = { ...DEFAULT_AI_SETTINGS };
  respond = (init: RequestInit | undefined): Response => {
    const method = init?.method ?? "GET";
    const body = init?.body ? (JSON.parse(String(init.body)) as Partial<AiSettings>) : undefined;
    if (method === "PUT" && body) this.settings = { ...this.settings, ...body };
    return json(this.settings);
  };
}

class MockStatusServer {
  body: Record<string, unknown> = {};
  respond = (): Response => json({ ...this.body });
}

function status(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true,
    settings: { ...DEFAULT_AI_SETTINGS },
    pending: 0,
    taxonomy: { acceptedAt: null, collections: [], tags: [] },
    run: {
      processed: 0,
      assigned: 0,
      tagged: 0,
      skipped: 0,
      lastRunAt: null,
      lastError: null,
      isUnavailable: false,
      isBackingOff: false,
      log: [],
    },
    summarize: {
      available: true,
      model: "gpt-4o-mini",
      pending: 0,
      summarised: 0,
      written: 0,
      skipped: 0,
      lastRunAt: null,
      lastError: null,
      isUnavailable: false,
      isBackingOff: false,
    },
    reviewCount: 0,
    ...overrides,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
}

let settingsServer: MockSettingsServer;
let statusServer: MockStatusServer;
type RouteReply = () => Response | Promise<Response>;

let taxonomyProposerHandler: RouteReply | null;
let taxonomyAcceptHandler: RouteReply | null;
let runHandler: RouteReply | null;
let runRequests: number;
let acceptedSettingsPatches: Array<Partial<AiSettings>>;

let reviewBody: Record<string, unknown>;
let resolveHandler: RouteReply | null;
let resolveResponseBody: Record<string, unknown>;
let resolveCalls: Array<Record<string, unknown>>;

let clusterProposeHandler: RouteReply | null;
let clusterAcceptResponseBody: Record<string, unknown>;
let clusterAcceptCalls: Array<Record<string, unknown>>;

function installFetchRouter(): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.endsWith("/api/ai/settings")) {
      const method = init?.method ?? "GET";
      if (method === "PUT" && init?.body) acceptedSettingsPatches.push(JSON.parse(String(init.body)));
      return settingsServer.respond(init);
    }
    if (input.endsWith("/api/ai/status")) return statusServer.respond();
    if (input.endsWith("/api/ai/taxonomy/propose")) {
      if (taxonomyProposerHandler) return taxonomyProposerHandler();
      return json({ sampleSize: 0, collections: [], tags: [], existingCollections: [] });
    }
    if (input.endsWith("/api/ai/taxonomy")) {
      if (taxonomyAcceptHandler) return taxonomyAcceptHandler();
      return json({ createdCollections: 0, addedTags: 0, dropped: 0, taxonomy: { acceptedAt: null, collections: [], tags: [] } });
    }
    if (input.endsWith("/api/ai/run")) {
      runRequests++;
      if (runHandler) return runHandler();
      return json({ queued: 0, summariesQueued: 0, status: status() });
    }
    if (input.endsWith("/api/ai/review/resolve")) {
      const body = init?.body ? (JSON.parse(String(init.body)) as { items: Array<{ bookmarkId: string }> }) : { items: [] };
      resolveCalls.push(body);
      if (resolveHandler) return resolveHandler();
      // A real server would no longer return a resolved row — mirror that so
      // the subsequent re-read this route's own success triggers
      // (announceAiStatusChange -> subscribeToAiStatus -> a fresh GET
      // /api/ai/review) doesn't hand the optimistically-removed row right
      // back.
      const resolvedIds = new Set(body.items.map((entry) => entry.bookmarkId));
      reviewBody = {
        ...reviewBody,
        items: (reviewBody.items as Array<{ bookmarkId: string }>).filter((item) => !resolvedIds.has(item.bookmarkId)),
      };
      return json(resolveResponseBody);
    }
    if (input.endsWith("/api/ai/review")) return json(reviewBody);
    if (input.endsWith("/api/ai/clusters/propose")) {
      if (clusterProposeHandler) return clusterProposeHandler();
      return json({ proposals: [], unclustered: 0, considered: 0 });
    }
    if (input.endsWith("/api/ai/clusters/accept")) {
      if (init?.body) clusterAcceptCalls.push(JSON.parse(String(init.body)));
      return json(clusterAcceptResponseBody);
    }
    throw new Error(`Unexpected fetch in this test: ${input}`);
  });
}

function stubClusterProposals(body: unknown, responseStatus = 200): void {
  clusterProposeHandler = () => json(body, { status: responseStatus });
}

function stubTaxonomyProposer(body: unknown, responseStatus = 200): void {
  taxonomyProposerHandler = () => json(body, { status: responseStatus });
}

const TAGS_ONLY_PROPOSAL = {
  sampleSize: 50,
  existingCollections: ["Reading"],
  // The server still names collections here — the point of tagsOnly is that
  // the client never shows or acts on them.
  collections: [{ name: "Design", why: "Design systems and UI craft." }],
  tags: [{ name: "free", why: "Free to use.", coveredBy: [] }],
};

function aiHost(overrides: Partial<NookHost> = {}): NookHost {
  return {
    kind: "extension",
    appVersion: "1.2.3",
    apiUrl: "https://nook.beyler.co",
    user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
    sync: { requestSync: vi.fn().mockResolvedValue(undefined) },
    openWebApp: vi.fn(),
    ...overrides,
  };
}

const LISTS: BookmarkList[] = [
  { id: "list-design", name: "Design", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as BookmarkList,
];

function items(count: number, filed: number): Bookmark[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `bm-${index}`,
    source: "chrome",
    title: `Bookmark ${index}`,
    ...(index < filed ? { listId: "list-design", listName: "Design" } : {}),
  }));
}

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  NookDB._resetForTests();
  _resetAiSettingsCacheForTests();
  _resetAiClientForTests();
  settingsServer = new MockSettingsServer();
  statusServer = new MockStatusServer();
  statusServer.body = status();
  taxonomyProposerHandler = null;
  taxonomyAcceptHandler = null;
  runHandler = null;
  runRequests = 0;
  acceptedSettingsPatches = [];
  reviewBody = { items: [], total: 0 };
  resolveHandler = null;
  resolveResponseBody = { filed: 0, rejected: 0, skipped: 0 };
  resolveCalls = [];
  clusterProposeHandler = null;
  clusterAcceptResponseBody = { createdCollections: 0, filed: 0, skipped: 0 };
  clusterAcceptCalls = [];
  installFetchRouter();
  await saveCloudSession("test-token", "user-1");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await settle();
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  configureCloud({ apiUrl: "https://nook.beyler.co", auth: "bearer" });
});

async function settle() {
  await act(async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await NookDB.getMeta("ai.settle-probe");
    }
  });
}

function hasText(text: string): boolean {
  return container.textContent?.includes(text) ?? false;
}

function buttonFor(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
  );
  if (!match) {
    const seen = [...container.querySelectorAll<HTMLButtonElement>("button")].map((element) => element.textContent?.trim());
    throw new Error(`No button labelled "${label}". Saw: ${seen.join(" | ")}`);
  }
  return match;
}

function buttonsFor(label: string): HTMLButtonElement[] {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
  );
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setValue.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

async function renderOrganizePage(host: NookHost, props: { bookmarks?: Bookmark[]; lists?: BookmarkList[] } = {}) {
  const onOpenAiSettings = vi.fn();
  act(() => {
    root.render(
      <NookHostProvider host={host}>
        <ToastViewport>
          <ReviewListProvider>
            <OrganizePage items={props.bookmarks ?? items(10, 0)} lists={props.lists ?? LISTS} onOpenAiSettings={onOpenAiSettings} />
          </ReviewListProvider>
        </ToastViewport>
      </NookHostProvider>,
    );
  });
  await settle();
  return { onOpenAiSettings };
}

describe("OrganizePage — signed out / unavailable", () => {
  it("shows the sign-in banner instead of the page when there's no user", async () => {
    await renderOrganizePage(aiHost({ user: null }));
    expect(hasText("Sign in to use AI features")).toBe(true);
    expect(hasText("Suggest collections")).toBe(false);
  });

  it("shows the outage banner when neither AI deployment is configured, and hides every suggest action", async () => {
    statusServer.body = status({ available: false, summarize: { ...(status().summarize as object), available: false } });
    await renderOrganizePage(aiHost());
    expect(hasText("AI isn't set up on this server yet")).toBe(true);
    expect(() => buttonFor("Suggest collections")).toThrow();
    expect(() => buttonFor("Suggest tags")).toThrow();
  });
});

describe("OrganizePage — nothing suggested yet", () => {
  it("shows the compact prompt with the progress line and the primary button", async () => {
    const { onOpenAiSettings } = await renderOrganizePage(aiHost(), { bookmarks: items(10, 2) });

    expect(hasText("2 bookmarks filed")).toBe(true);
    expect(hasText("8 left to organize")).toBe(true);
    expect(buttonFor("Suggest collections")).toBeTruthy();

    act(() => buttonFor("AI settings").click());
    expect(onOpenAiSettings).toHaveBeenCalledTimes(1);
  });

  it("shows the empty state once nothing is unfiled and nothing needs review", async () => {
    await renderOrganizePage(aiHost(), { bookmarks: items(5, 5) });
    expect(hasText("Everything is organized")).toBe(true);
    expect(() => buttonFor("Suggest collections")).toThrow();
    expect(buttonFor("Suggest again")).toBeTruthy();
  });

  it("still shows 'Needs your review' even when everything is filed, if something needs a look", async () => {
    reviewBody = { items: [{ bookmarkId: "bm-0", listId: "list-design", listName: "Design", confidence: 0.7 }], total: 1 };
    await renderOrganizePage(aiHost(), { bookmarks: items(5, 5) });
    expect(hasText("Everything is organized")).toBe(false);
    expect(hasText("Needs your review")).toBe(true);
  });
});

describe("OrganizePage — suggest collections (clusters)", () => {
  const PROPOSALS = {
    proposals: [
      { id: "c1", name: "Design", why: "Design systems and UI craft.", size: 2, memberIds: ["bm-0", "bm-1"], sampleTitles: ["Bookmark 0", "Bookmark 1"], existingListId: null },
      { id: "c2", name: "Reading", why: "Long-form reading.", size: 1, memberIds: ["bm-2"], sampleTitles: ["Bookmark 2"], existingListId: "list-design" },
    ],
    unclustered: 3,
    considered: 6,
  };

  it("renders proposals full-width with counts, samples and an existing-collection badge", async () => {
    stubClusterProposals(PROPOSALS);
    await renderOrganizePage(aiHost(), { bookmarks: items(6, 0) });

    act(() => buttonFor("Suggest collections").click());
    await settle();

    expect(hasText("Design")).toBe(true);
    expect(hasText("Design systems and UI craft.")).toBe(true);
    expect(hasText("Reading")).toBe(true);
    expect(hasText("Adds to Design")).toBe(true);
    expect(hasText("3 bookmarks didn't form a clear group — you can file them by hand below or suggest again later.")).toBe(true);
    expect(hasText("Create 1 collection and file 3 bookmarks")).toBe(true);
  });

  it("deselecting a proposal updates the footer's label", async () => {
    stubClusterProposals(PROPOSALS);
    await renderOrganizePage(aiHost(), { bookmarks: items(6, 0) });
    act(() => buttonFor("Suggest collections").click());
    await settle();

    const checkboxes = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(checkboxes).toHaveLength(2);
    act(() => checkboxes[1].click());
    await settle();

    expect(hasText("Create 1 collection and file 2 bookmarks")).toBe(true);
  });

  it("renaming a proposal sends the new name in the accept body, not the original", async () => {
    stubClusterProposals(PROPOSALS);
    clusterAcceptResponseBody = { createdCollections: 2, filed: 3, skipped: 0 };
    const host = aiHost();
    await renderOrganizePage(host, { bookmarks: items(6, 0) });
    act(() => buttonFor("Suggest collections").click());
    await settle();

    act(() => buttonsFor("Rename")[0].click());
    await settle();
    const nameInput = container.querySelector<HTMLInputElement>('input[type="text"]')!;
    act(() => setInputValue(nameInput, "Design & UX"));
    await settle();

    act(() => buttonFor("Create 1 collection and file 3 bookmarks").click());
    await settle();

    expect(clusterAcceptCalls[0]).toMatchObject({
      collections: [
        { name: "Design & UX", memberIds: ["bm-0", "bm-1"], existingListId: null },
        { name: "Reading", memberIds: ["bm-2"], existingListId: "list-design" },
      ],
    });
    expect(host.sync.requestSync).toHaveBeenCalled();
    expect(hasText("Created 2 collections and filed 3 bookmarks.")).toBe(true);
  });

  it("expands 'show all' to the full local membership, beyond the server's sample", async () => {
    stubClusterProposals({
      proposals: [
        { id: "c1", name: "Design", why: "Design systems.", size: 3, memberIds: ["bm-0", "bm-1", "bm-2"], sampleTitles: ["Bookmark 0"], existingListId: null },
      ],
      unclustered: 0,
      considered: 3,
    });
    await renderOrganizePage(aiHost(), { bookmarks: items(3, 0) });
    act(() => buttonFor("Suggest collections").click());
    await settle();

    expect(hasText("Bookmark 0")).toBe(true);
    expect(hasText("Bookmark 1")).toBe(false);

    act(() => buttonFor("Show all 3").click());
    await settle();

    expect(hasText("Bookmark 1")).toBe(true);
    expect(hasText("Bookmark 2")).toBe(true);
  });

  it("cancel returns to the compact prompt without accepting anything", async () => {
    stubClusterProposals(PROPOSALS);
    await renderOrganizePage(aiHost(), { bookmarks: items(6, 0) });
    act(() => buttonFor("Suggest collections").click());
    await settle();
    expect(hasText("Design systems and UI craft.")).toBe(true);

    act(() => buttonFor("Cancel").click());
    await settle();

    expect(hasText("Design systems and UI craft.")).toBe(false);
    expect(clusterAcceptCalls).toHaveLength(0);
    expect(buttonFor("Suggest collections")).toBeTruthy();
  });

  it("declines to unavailable/nothing-new outcomes without crashing", async () => {
    stubClusterProposals({ error: "not configured" }, 503);
    await renderOrganizePage(aiHost(), { bookmarks: items(6, 0) });
    act(() => buttonFor("Suggest collections").click());
    await settle();
    expect(hasText("Not available on this server yet.")).toBe(true);
  });
});

describe("OrganizePage — needs your review", () => {
  it("shows a plain confidence word per row, never a raw decimal", async () => {
    reviewBody = {
      items: [
        { bookmarkId: "bm-0", listId: "list-design", listName: "Design", confidence: 0.82 },
        { bookmarkId: "bm-1", listId: "list-design", listName: "Design", confidence: 0.4 },
      ],
      total: 2,
    };
    await renderOrganizePage(aiHost(), { bookmarks: items(5, 0) });

    expect(hasText("Needs your review")).toBe(true);
    expect(hasText("Likely")).toBe(true);
    expect(hasText("Maybe")).toBe(true);
    expect(hasText("0.82")).toBe(false);
  });

  it("accepting a row resolves it, removes it optimistically, and syncs", async () => {
    reviewBody = { items: [{ bookmarkId: "bm-0", listId: "list-design", listName: "Design", confidence: 0.82 }], total: 1 };
    resolveResponseBody = { filed: 1, rejected: 0, skipped: 0 };
    const host = aiHost();
    await renderOrganizePage(host, { bookmarks: items(5, 0) });

    act(() => buttonFor("Accept").click());
    await settle();

    expect(resolveCalls[0]).toEqual({ items: [{ bookmarkId: "bm-0", action: "accept" }] });
    expect(host.sync.requestSync).toHaveBeenCalled();
    expect(hasText("Needs your review")).toBe(false);
  });

  it("rejecting a row resolves it without a sync (nothing local changed)", async () => {
    reviewBody = { items: [{ bookmarkId: "bm-0", listId: "list-design", listName: "Design", confidence: 0.82 }], total: 1 };
    resolveResponseBody = { filed: 0, rejected: 1, skipped: 0 };
    const host = aiHost();
    await renderOrganizePage(host, { bookmarks: items(5, 0) });

    act(() => buttonFor("Dismiss").click());
    await settle();

    expect(resolveCalls[0]).toEqual({ items: [{ bookmarkId: "bm-0", action: "reject" }] });
    expect(host.sync.requestSync).not.toHaveBeenCalled();
  });

  it("bulk-accepts every likely row in one call, leaving the unsure ones behind", async () => {
    reviewBody = {
      items: [
        { bookmarkId: "bm-0", listId: "list-design", listName: "Design", confidence: 0.9 },
        { bookmarkId: "bm-1", listId: "list-design", listName: "Design", confidence: 0.65 },
        { bookmarkId: "bm-2", listId: "list-design", listName: "Design", confidence: 0.3 },
      ],
      total: 3,
    };
    resolveResponseBody = { filed: 2, rejected: 0, skipped: 0 };
    await renderOrganizePage(aiHost(), { bookmarks: items(5, 0) });

    act(() => buttonFor("Accept all likely").click());
    await settle();

    expect(resolveCalls[0].items).toHaveLength(2);
    expect((resolveCalls[0].items as Array<{ bookmarkId: string }>).map((entry) => entry.bookmarkId).sort()).toEqual(["bm-0", "bm-1"]);
    expect(hasText("2 bookmarks filed.")).toBe(true);
  });

  it("rolls the row back when the resolve call fails outright", async () => {
    reviewBody = { items: [{ bookmarkId: "bm-0", listId: "list-design", listName: "Design", confidence: 0.9 }], total: 1 };
    resolveHandler = () => json({ error: "boom" }, { status: 500 });
    await renderOrganizePage(aiHost(), { bookmarks: items(5, 0) });

    expect(hasText("Bookmark 0")).toBe(true);
    act(() => buttonFor("Dismiss").click());
    await settle();

    expect(hasText("Bookmark 0")).toBe(true);
    expect(hasText("Could not save that — try again.")).toBe(true);
  });
});

describe("OrganizePage — filing in progress", () => {
  it("shows a live progress line while the server's queue is draining, at the current rate", async () => {
    statusServer.body = status({ pending: 300 });
    await renderOrganizePage(aiHost(), { bookmarks: items(40, 10) });

    expect(hasText("Nook is organizing")).toBe(true);
    expect(hasText("About 300 bookmarks left — about 2 min.")).toBe(true);
  });
});

describe("OrganizePage — recently filed", () => {
  it("maps assigned log entries to local bookmarks by title and collection, and explains the rest", async () => {
    const bookmarks = items(5, 0);
    bookmarks[0].listId = "list-design";
    bookmarks[0].listName = "Design";
    statusServer.body = status({
      taxonomy: { acceptedAt: "2026-09-01T00:00:00.000Z", collections: [], tags: [] },
      run: {
        processed: 3,
        assigned: 1,
        tagged: 0,
        skipped: 2,
        lastRunAt: "2026-09-20T10:00:00.000Z",
        lastError: null,
        isUnavailable: false,
        isBackingOff: false,
        log: [
          { id: "bm-0", confidence: 0.95, assigned: true, at: "2026-09-20T09:00:00.000Z" },
          { id: "bm-1", confidence: 0.9, assigned: false, at: "2026-09-20T09:05:00.000Z" },
          { id: "bm-2", confidence: 0.4, assigned: false, at: "2026-09-20T09:10:00.000Z" },
        ],
      },
    });

    await renderOrganizePage(aiHost(), { bookmarks });

    expect(hasText("Recently filed")).toBe(true);
    expect(hasText("Bookmark 0")).toBe(true);
    expect(hasText("Design")).toBe(true);
    expect(hasText("1 bookmark didn't fit any collection.")).toBe(true);
    expect(hasText("1 came close, but below your confidence setting.")).toBe(true);
  });

  it("says nothing was filed yet when the log is empty", async () => {
    await renderOrganizePage(aiHost(), { bookmarks: items(5, 0) });
    expect(hasText("Nothing filed yet.")).toBe(true);
  });
});

describe("OrganizePage — suggest tags (secondary, collapsed)", () => {
  it("is collapsed by default, and only ever reviews/accepts tags even though the route also names collections", async () => {
    stubTaxonomyProposer(TAGS_ONLY_PROPOSAL);
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: false };
    await renderOrganizePage(aiHost(), { bookmarks: items(10, 0) });

    // Collapsed: the trigger is there, the "New collections" review list is not.
    expect(hasText("New collections")).toBe(false);

    act(() => buttonFor("Suggest tags").click());
    await settle();
    act(() => buttonFor("Look for tags").click());
    await settle();

    expect(hasText("New tags")).toBe(true);
    expect(hasText("free")).toBe(true);
    // The collections the proposer also returned are never shown here — the
    // cluster-suggestion block above is where a new collection comes from now.
    expect(hasText("New collections")).toBe(false);
    expect(hasText("Design systems and UI craft.")).toBe(false);

    act(() => buttonFor("Add 1 tag").click());
    await settle();

    expect(acceptedSettingsPatches).toContainEqual(expect.objectContaining({ autoClassify: true }));
    expect(runRequests).toBeGreaterThan(0);
  });
});
