// @vitest-environment happy-dom
//
// The small "Suggested: X" chip BookmarkCard.tsx renders for a bookmark that
// is in the shared review list (useReviewList.tsx) — and, just as
// importantly, doesn't render for a bookmark that isn't. The list itself is
// loaded once per dashboard (ReviewListProvider), so this test wraps a single
// card in that provider directly rather than the whole DashboardApp.
import "fake-indexeddb/auto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BookmarkCard } from "../src/app/components/BookmarkCard";
import { NookHostProvider, type NookHost } from "../src/app/host/NookHost";
import { ReviewListProvider } from "../src/app/dashboard/organize/useReviewList";
import { _resetAiClientForTests } from "../lib/ai-client";
import { configureCloud, saveCloudSession } from "../lib/cloud-sync";
import * as NookDB from "../lib/db";
import type { Bookmark } from "../lib/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
}

let reviewBody: Record<string, unknown>;
let resolveCalls: Array<Record<string, unknown>>;

function installFetchRouter(): void {
  vi.stubGlobal("fetch", async (input: string, init?: RequestInit): Promise<Response> => {
    if (input.endsWith("/api/ai/review/resolve")) {
      const body = init?.body
        ? (JSON.parse(String(init.body)) as { items: Array<{ bookmarkId: string; action: "accept" | "reject" }> })
        : { items: [] };
      resolveCalls.push(body);
      // Mirror a real server: a resolved row doesn't come back on the next
      // GET, which matters here because a successful resolve announces a
      // change that makes this provider re-read the list right away.
      const resolvedIds = new Set(body.items.map((entry) => entry.bookmarkId));
      reviewBody = {
        ...reviewBody,
        items: (reviewBody.items as Array<{ bookmarkId: string }>).filter((item) => !resolvedIds.has(item.bookmarkId)),
      };
      const filed = body.items.filter((entry) => entry.action === "accept").length;
      const rejected = body.items.filter((entry) => entry.action === "reject").length;
      return json({ filed, rejected, skipped: 0 });
    }
    if (input.endsWith("/api/ai/review")) return json(reviewBody);
    throw new Error(`Unexpected fetch in this test: ${input}`);
  });
}

function aiHost(overrides: Partial<NookHost> = {}): NookHost {
  return {
    kind: "extension",
    appVersion: "1.2.3",
    apiUrl: "https://nook.beyler.co",
    user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
    sync: { requestSync: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

function bookmark(overrides: Partial<Bookmark> & { id: string }): Bookmark {
  return { source: "chrome", title: "A saved page", ...overrides };
}

let container: HTMLElement;
let root: Root;

beforeEach(async () => {
  NookDB._resetForTests();
  _resetAiClientForTests();
  reviewBody = { items: [], total: 0 };
  resolveCalls = [];
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
    for (let i = 0; i < 10; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await NookDB.getMeta("ai.settle-probe");
    }
  });
}

function buttonFor(label: string): HTMLButtonElement {
  const match = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label || element.getAttribute("aria-label") === label,
  );
  if (!match) throw new Error(`No button labelled "${label}"`);
  return match;
}

async function renderCard(item: Bookmark, host: NookHost = aiHost()) {
  act(() => {
    root.render(
      <NookHostProvider host={host}>
        <ReviewListProvider>
          <BookmarkCard item={item} listLabel="" />
        </ReviewListProvider>
      </NookHostProvider>,
    );
  });
  await settle();
}

describe("BookmarkCard — review suggestion chip", () => {
  it("renders no chip for a bookmark that isn't in the review list", async () => {
    reviewBody = { items: [{ bookmarkId: "other-bookmark", listId: "list-1", listName: "Design", confidence: 0.8 }], total: 1 };
    await renderCard(bookmark({ id: "bm-1" }));
    expect(container.textContent).not.toContain("Suggested:");
  });

  it("renders the chip with the guessed collection for a bookmark that is in the review list", async () => {
    reviewBody = { items: [{ bookmarkId: "bm-1", listId: "list-1", listName: "Design", confidence: 0.8 }], total: 1 };
    await renderCard(bookmark({ id: "bm-1" }));
    expect(container.textContent).toContain("Suggested: Design");
  });

  it("accepting the chip resolves it and removes it", async () => {
    reviewBody = { items: [{ bookmarkId: "bm-1", listId: "list-1", listName: "Design", confidence: 0.8 }], total: 1 };
    const host = aiHost();
    await renderCard(bookmark({ id: "bm-1" }), host);

    act(() => buttonFor("Accept suggestion").click());
    await settle();

    expect(resolveCalls[0]).toEqual({ items: [{ bookmarkId: "bm-1", action: "accept" }] });
    expect(host.sync.requestSync).toHaveBeenCalled();
    expect(container.textContent).not.toContain("Suggested:");
  });

  it("dismissing the chip rejects it and removes it, without a sync", async () => {
    reviewBody = { items: [{ bookmarkId: "bm-1", listId: "list-1", listName: "Design", confidence: 0.8 }], total: 1 };
    const host = aiHost();
    await renderCard(bookmark({ id: "bm-1" }), host);

    act(() => buttonFor("Dismiss suggestion").click());
    await settle();

    expect(resolveCalls[0]).toEqual({ items: [{ bookmarkId: "bm-1", action: "reject" }] });
    expect(host.sync.requestSync).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain("Suggested:");
  });
});
