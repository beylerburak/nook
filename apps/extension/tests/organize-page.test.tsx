// @vitest-environment happy-dom
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "@astryxdesign/core/Toast";
import { NookHostProvider, type NookHost } from "../src/app/host/NookHost";
import { OrganizePage } from "../src/app/dashboard/organize/OrganizePage";
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
// The same shape as tests/settings-ai-panel.test.tsx's router, plus the three
// routes that used to be exercised there before the suggest/accept/run flow
// moved to this page: POST /api/ai/taxonomy/propose, PUT /api/ai/taxonomy and
// POST /api/ai/run.

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
    ...overrides,
  };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
}

let settingsServer: MockSettingsServer;
let statusServer: MockStatusServer;
type RouteReply = () => Response | Promise<Response>;
let proposerHandler: RouteReply | null;
let acceptHandler: RouteReply | null;
let runHandler: RouteReply | null;
let runRequests: number;
let acceptedSettingsPatches: Array<Partial<AiSettings>>;

function installFetchRouter(): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.endsWith("/api/ai/settings")) {
      const method = init?.method ?? "GET";
      if (method === "PUT" && init?.body) acceptedSettingsPatches.push(JSON.parse(String(init.body)));
      return settingsServer.respond(init);
    }
    if (input.endsWith("/api/ai/status")) return statusServer.respond();
    if (input.endsWith("/api/ai/taxonomy/propose")) {
      if (proposerHandler) return proposerHandler();
      return json({ sampleSize: 0, collections: [], tags: [], existingCollections: [] });
    }
    if (input.endsWith("/api/ai/taxonomy")) {
      if (acceptHandler) return acceptHandler();
      return json({ createdCollections: 0, addedTags: 0, dropped: 0, taxonomy: { acceptedAt: null, collections: [], tags: [] } });
    }
    if (input.endsWith("/api/ai/run")) {
      runRequests++;
      if (runHandler) return runHandler();
      return json({ queued: 0, summariesQueued: 0, status: status() });
    }
    throw new Error(`Unexpected fetch in this test: ${input}`);
  });
}

function stubProposer(body: unknown, responseStatus = 200): void {
  proposerHandler = () => json(body, { status: responseStatus });
}

const PROPOSALS = {
  sampleSize: 50,
  existingCollections: [],
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
  proposerHandler = null;
  acceptHandler = null;
  runHandler = null;
  runRequests = 0;
  acceptedSettingsPatches = [];
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

async function renderOrganizePage(host: NookHost, props: { bookmarks?: Bookmark[]; lists?: BookmarkList[] } = {}) {
  const onOpenAiSettings = vi.fn();
  act(() => {
    root.render(
      <NookHostProvider host={host}>
        <ToastViewport>
          <OrganizePage items={props.bookmarks ?? items(10, 0)} lists={props.lists ?? LISTS} onOpenAiSettings={onOpenAiSettings} />
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

  it("shows the outage banner when neither AI deployment is configured", async () => {
    statusServer.body = status({ available: false, summarize: { ...(status().summarize as object), available: false } });
    await renderOrganizePage(aiHost());
    expect(hasText("AI isn't set up on this server yet")).toBe(true);
  });
});

describe("OrganizePage — no suggestions yet", () => {
  it("prompts to suggest collections for the unfiled count, and links to AI settings", async () => {
    const { onOpenAiSettings } = await renderOrganizePage(aiHost(), { bookmarks: items(10, 2) });

    expect(hasText("Suggest collections for the 8 bookmarks that are still unfiled.")).toBe(true);
    expect(hasText("2 bookmarks filed")).toBe(true);
    expect(hasText("8 left to organize")).toBe(true);

    act(() => buttonFor("AI settings").click());
    expect(onOpenAiSettings).toHaveBeenCalledTimes(1);
  });

  it("shows 'everything is filed' once nothing is unfiled", async () => {
    await renderOrganizePage(aiHost(), { bookmarks: items(5, 5) });
    expect(hasText("Everything is filed. Nice work.")).toBe(true);
    expect(() => buttonFor("Suggest collections")).toThrow();
  });
});

describe("OrganizePage — review, accept triggers a run", () => {
  it("reviews the proposals full-width, and accepting turns on filing and queues a run", async () => {
    stubProposer(PROPOSALS);
    settingsServer.settings = { ...DEFAULT_AI_SETTINGS, autoClassify: false };
    await renderOrganizePage(aiHost(), { bookmarks: items(10, 0) });

    act(() => buttonFor("Suggest collections").click());
    await settle();

    expect(hasText("New collections")).toBe(true);
    expect(hasText("Design")).toBe(true);
    expect(hasText("New tags")).toBe(true);

    act(() => buttonFor("Add 1 collection and 1 tag").click());
    await settle();

    expect(acceptedSettingsPatches).toContainEqual(expect.objectContaining({ autoClassify: true }));
    expect(runRequests).toBeGreaterThan(0);
    expect(hasText("Filing is now on too, so new bookmarks keep getting sorted.")).toBe(true);
  });

  it("cancel returns to the primary action without accepting anything", async () => {
    stubProposer(PROPOSALS);
    await renderOrganizePage(aiHost(), { bookmarks: items(10, 0) });

    act(() => buttonFor("Suggest collections").click());
    await settle();
    expect(hasText("New collections")).toBe(true);

    act(() => buttonFor("Cancel").click());
    await settle();

    expect(hasText("New collections")).toBe(false);
    expect(hasText("Suggest collections for the 10 bookmarks")).toBe(true);
  });
});

describe("OrganizePage — filing in progress", () => {
  it("shows a live progress line while the server's queue is draining", async () => {
    statusServer.body = status({ pending: 30 });
    await renderOrganizePage(aiHost(), { bookmarks: items(40, 10) });

    expect(hasText("Nook is organizing")).toBe(true);
    expect(hasText("About 30 bookmarks left — about 2 min.")).toBe(true);
    // The primary "suggest" action is not shown while a pass is draining.
    expect(() => buttonFor("Suggest more collections")).toThrow();
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
