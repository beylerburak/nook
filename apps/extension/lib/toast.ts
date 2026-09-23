/**
 * On-demand delivery for the "bookmark saved" toast.
 *
 * The toast UI (`entrypoints/bookmark-toast.content.tsx`) bundles React and
 * the full Astryx toast stack, so it's registered with
 * `registration: "runtime"` instead of matching every page in the manifest.
 * That keeps the ~520kB bundle out of pages that never save a bookmark, at
 * the cost of having to inject it ourselves the first time a tab needs it.
 *
 * Flow for `sendBookmarkToast`:
 *  1. Try delivering directly — cheap, and covers tabs that already have the
 *     toast host mounted from an earlier save.
 *  2. If nothing is listening, inject the content script's built file with
 *     `chrome.scripting.executeScript`.
 *  3. Wait for the injected host to signal it has mounted and registered its
 *     `chrome.runtime.onMessage` listener (see `notifyBookmarkToastReady`)
 *     before delivering — otherwise the message can arrive before React has
 *     rendered and would be silently dropped.
 *
 * Restricted pages (chrome://, the Web Store, etc.) are handled by simply
 * giving up: `chrome.scripting.executeScript` rejects for them, and that
 * rejection is swallowed here so callers never see an unhandled rejection.
 */

import type { ShowBookmarkToastMessage } from "./types";

/** Built path of the runtime-registered toast content script (verified against `.output/chrome-mv3` after `npm run build`). */
const TOAST_CONTENT_SCRIPT_PATH = "content-scripts/bookmark-toast.js";

/** How long to wait for the injected host to report it's ready before attempting delivery anyway. */
const READY_TIMEOUT_MS = 2000;

export const BOOKMARK_TOAST_READY_MESSAGE = "BOOKMARK_TOAST_READY" as const;

/**
 * What the toast host replies to SHOW_BOOKMARK_TOAST. Delivery only counts when
 * this comes back: other Nook content scripts (e.g. the X one) also listen on
 * chrome.runtime.onMessage, so a bare successful sendMessage proves nothing.
 */
export interface BookmarkToastAck {
  toastShown: true;
}

interface BookmarkToastReadyMessage {
  type: typeof BOOKMARK_TOAST_READY_MESSAGE;
}

// Tabs whose toast host has confirmed it's mounted and listening.
const readyTabs = new Set<number>();
// Resolvers waiting on a not-yet-ready tab's readiness ping.
const readyWaiters = new Map<number, Set<() => void>>();

function markTabReady(tabId: number): void {
  readyTabs.add(tabId);
  const waiters = readyWaiters.get(tabId);
  if (!waiters) return;
  readyWaiters.delete(tabId);
  waiters.forEach((resolve) => resolve());
}

function forgetTab(tabId: number): void {
  readyTabs.delete(tabId);
  readyWaiters.delete(tabId);
}

function waitForReady(tabId: number): Promise<void> {
  if (readyTabs.has(tabId)) return Promise.resolve();

  return new Promise((resolve) => {
    const waiters = readyWaiters.get(tabId) ?? new Set();
    readyWaiters.set(tabId, waiters);

    const onReady = () => resolve();
    waiters.add(onReady);

    setTimeout(() => {
      waiters.delete(onReady);
      resolve(); // Give up waiting; the caller will still attempt delivery.
    }, READY_TIMEOUT_MS);
  });
}

function isBookmarkToastReadyMessage(message: unknown): message is BookmarkToastReadyMessage {
  return Boolean(
    message &&
    typeof message === "object" &&
    "type" in message &&
    (message as { type: unknown }).type === BOOKMARK_TOAST_READY_MESSAGE,
  );
}

// Only http(s) pages can be scripted; chrome://, chrome-extension://,
// about:, the Web Store, etc. reject `executeScript` outright, so skip the
// injection attempt for those instead of relying solely on the try/catch.
function isInjectableUrl(url: string | undefined): boolean {
  return Boolean(url && (url.startsWith("http://") || url.startsWith("https://")));
}

async function trySendToast(tabId: number, message: ShowBookmarkToastMessage): Promise<boolean> {
  try {
    const response: unknown = await chrome.tabs.sendMessage(tabId, message);
    return (response as Partial<BookmarkToastAck> | undefined)?.toastShown === true;
  } catch {
    return false; // No receiver in this tab yet.
  }
}

/**
 * Delivers a "bookmark saved" toast to a tab, injecting the toast content
 * script on demand if it isn't already running there. Never throws/rejects.
 */
export async function sendBookmarkToast(tabId: number, message: ShowBookmarkToastMessage): Promise<void> {
  if (await trySendToast(tabId, message)) return;

  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!isInjectableUrl(tab?.url)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [TOAST_CONTENT_SCRIPT_PATH],
    });
  } catch {
    return; // Restricted page (Web Store, etc.) or the tab closed mid-flight.
  }

  await waitForReady(tabId);
  await trySendToast(tabId, message);
}

/** Called by the toast content script once it has mounted and is listening for `SHOW_BOOKMARK_TOAST`. */
export function notifyBookmarkToastReady(): void {
  const message: BookmarkToastReadyMessage = { type: BOOKMARK_TOAST_READY_MESSAGE };
  chrome.runtime.sendMessage(message).catch(() => {
    // Background service worker not around to hear it; the next
    // sendBookmarkToast call will fall back to its own timeout.
  });
}

/**
 * Background-only: tracks toast-host readiness per tab. Must be called once from
 * the service worker; it isn't a module side effect because the toast content
 * script imports this file too, and content scripts have no chrome.tabs.
 */
export function initBookmarkToastDelivery(): void {
  chrome.runtime.onMessage.addListener((message: unknown, sender) => {
    if (!isBookmarkToastReadyMessage(message) || sender.tab?.id === undefined) return;
    markTabReady(sender.tab.id);
  });

  // A navigated or closed tab loses its injected host; drop the stale "ready" record.
  chrome.tabs.onRemoved.addListener(forgetTab);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "loading") forgetTab(tabId);
  });
}
