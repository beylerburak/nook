/**
 * Backs the popup's GET_ACTIVE_PAGE_STATE / SAVE_ACTIVE_PAGE messages: what
 * the active tab's page looks like to Nook, and saving it (through the X
 * path or generic page capture, whichever applies).
 */

import { findBookmarkForUrl } from "../../lib/bookmark-lookup";
import { isXPostUrl } from "../../lib/url";
import type { ActivePageState, ActivePageStateResponse, BackgroundToContentMessage } from "../../lib/types";
import { classifyUnsavableUrl } from "./page-access";
import { saveCurrentTab, savePage } from "./save-page";
import { saveXPostFromTab } from "./x-save";

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export async function getActivePageState(): Promise<ActivePageState> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined || !tab.url) {
    return { kind: "unsavable", reason: "no-tab" };
  }

  const reason = await classifyUnsavableUrl(tab.url);
  if (reason) return { kind: "unsavable", reason, url: tab.url };

  const bookmark = await findBookmarkForUrl(tab.url);
  const hostname = hostnameOf(tab.url);

  return {
    kind: "page",
    tabId: tab.id,
    url: tab.url,
    title: tab.title || hostname,
    hostname,
    favIconUrl: tab.favIconUrl,
    isXPost: isXPostUrl(tab.url),
    bookmark,
  };
}

export async function saveActivePage(): Promise<ActivePageStateResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || tab.id === undefined || !tab.url) {
    return { success: false, error: "No active tab to save" };
  }

  if (await classifyUnsavableUrl(tab.url)) {
    return { success: false, error: "This page can't be saved" };
  }

  try {
    if (isXPostUrl(tab.url)) {
      const saved = await saveXPostFromTab(tab.id);
      if (!saved) {
        // The X content script didn't answer (tab still loading, or the
        // status page's focal tweet couldn't be found) — still save *something*.
        await savePage({
          url: tab.url,
          metadataTabId: tab.id,
          toastTabId: tab.id,
          fallbackTitle: tab.title,
          favIconUrl: tab.favIconUrl,
        });
      }
    } else {
      await saveCurrentTab(tab);
    }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }

  const state = await getActivePageState();
  return { success: true, state };
}

/**
 * After REMOVE_BOOKMARK/UPDATE_BOOKMARK from the popup: if the active tab
 * happens to be showing the affected post, tell its in-page Nook button
 * about the change too. A harmless no-op when the id doesn't match anything
 * on screen (see entrypoints/content/nook-button.ts's updateNookButtonState).
 */
export async function notifyActiveTabBookmarkState(id: string, saved: boolean): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [] as chrome.tabs.Tab[]);
  if (tab?.id === undefined) return;
  const message: BackgroundToContentMessage = { type: "NOOK_BOOKMARK_STATE_CHANGED", id, saved };
  chrome.tabs.sendMessage(tab.id, message).catch(() => {});
}
