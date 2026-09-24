import { defineBackground } from "wxt/utils/define-background";
import * as NookDB from "../../lib/db";
import { initBookmarkToastDelivery, sendBookmarkToast } from "../../lib/toast";
import type {
  ActivePageStateResponse,
  BookmarkPatch,
  ContentToBackgroundMessage,
  MessageResponse,
  PopupToBackgroundMessage,
} from "../../lib/types";
import { getActivePageState, notifyActiveTabBookmarkState, saveActivePage } from "./active-page-state";
import { refreshBadgeForActiveTab, refreshBadgeForTab } from "./badge";
import { handleContextMenuClick, registerContextMenus } from "./context-menu";
import { classifyUnsavableUrl } from "./page-access";
import { saveCurrentTab, savePage } from "./save-page";
// Nook Background Service Worker
// Listens for Chrome bookmark creation and captures web pages automatically,
// and backs the popup's page-state / save / organize messages.

type BackgroundMessage = ContentToBackgroundMessage | PopupToBackgroundMessage;

export default defineBackground(() => {
console.log("[Nook Background] Service Worker initialized");

initBookmarkToastDelivery();

// Open the DB (and run the one-time chrome.storage.local migration) as soon
// as the service worker wakes up, so the first message handler that needs
// it doesn't pay the open+migrate cost on the critical path.
NookDB.ready().catch((err) => {
  console.error("[Nook Background] NookDB.ready() failed:", err);
});

// Set the badge for whichever tab is active right now — tabs.onActivated/
// onUpdated only fire on the *next* switch/navigation, which would otherwise
// leave a stale (or missing) badge after the service worker wakes up fresh.
refreshBadgeForActiveTab().catch(() => {});

// Cached X Bookmarks GraphQL queryId (captured from network by inject.js)
let _cachedBookmarkQueryId: string | null = null;

// -- native Chrome bookmark capture ----------------------------------------

chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  try {
    if (!bookmark.url) return; // Skip folders

    const urlStr = bookmark.url;
    if (await classifyUnsavableUrl(urlStr)) return;

    console.log("[Nook Background] New Chrome bookmark detected:", bookmark.title, urlStr);

    // Find a tab actually showing this URL, if any, for live metadata + toast.
    let targetTab: chrome.tabs.Tab | undefined;
    try {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTabs[0]?.url && activeTabs[0].url.split("#")[0] === urlStr.split("#")[0]) {
        targetTab = activeTabs[0];
      } else {
        const matchingTabs = await chrome.tabs.query({ url: urlStr.split("#")[0] + "*" });
        targetTab = matchingTabs[0];
      }
    } catch (tabErr) {
      console.log(
        "[Nook Background] Could not find a matching tab, will capture without one:",
        tabErr instanceof Error ? tabErr.message : String(tabErr)
      );
    }
    const scriptableTabId =
      targetTab?.id !== undefined && targetTab.url && !(await classifyUnsavableUrl(targetTab.url))
        ? targetTab.id
        : undefined;

    const { bookmark: saved } = await savePage({
      url: urlStr,
      id: `chrome:${id}`,
      source: "chrome",
      metadataTabId: scriptableTabId,
      toastTabId: scriptableTabId,
      favIconUrl: targetTab?.favIconUrl,
      fallbackTitle: bookmark.title,
      createdAt: new Date(bookmark.dateAdded || Date.now()).toISOString(),
    });
    console.log("[Nook Background] Bookmark successfully saved to Nook:", saved);
  } catch (err) {
    console.error("[Nook Background] Error capturing bookmark:", err);
  }
});

// -- toolbar badge: reflects whether the active tab's page is saved -------

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    refreshBadgeForTab(tabId, tab.url).catch(() => {});
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  refreshBadgeForTab(tabId, tab.url).catch(() => {});
});

// -- context menu: "Save page/link/image to Nook" --------------------------

chrome.contextMenus.onClicked.addListener((info, tab) => {
  handleContextMenuClick(info, tab).catch((err) => {
    console.error("[Nook Background] Context menu save failed:", err);
  });
});

// -- keyboard shortcut: save the active tab directly ------------------------

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "save-page" || !tab) return;
  saveCurrentTab(tab).catch((err) => {
    console.error("[Nook Background] Save-page command failed:", err);
  });
});

// -- message listener: content scripts (X) + extension pages (popup) -------

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse: (response?: MessageResponse | ActivePageStateResponse) => void) => {
  if (message?.type === "SHOW_BOOKMARK_TOAST") {
    const tabId = sender.tab?.id;
    if (tabId === undefined) {
      sendResponse({ success: false, error: "Cannot show a toast without a page tab" });
      return;
    }

    sendBookmarkToast(tabId, message).then(
      () => sendResponse({ success: true }),
      (err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }),
    );
    return true;
  }

  if (message?.type === "UPDATE_BOOKMARK_NOTE") {
    NookDB.updateBookmark(message.id, { note: message.note.trim() }).then((item) => {
      sendResponse({ success: Boolean(item) });
    }).catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (message?.type === "SAVE_ITEM") {
    (async () => {
      try {
        const item = message.item;
        if (!item || !item.id) {
          sendResponse({ success: false, error: "Invalid item" });
          return;
        }

        await NookDB.saveOrRestoreBookmark(item);
        const count = (await NookDB.getAllBookmarks()).length;
        sendResponse({ success: true, count });
      } catch (err) {
        console.error("[Nook Background] Error in SAVE_ITEM:", err);
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true; // Keep channel open for async response
  }

  if (message?.type === "GET_NOOK_BOOKMARK_STATES") {
    (async () => {
      try {
        const states: Record<string, boolean> = {};
        await Promise.all(message.ids.map(async (id) => {
          const item = await NookDB.getBookmark(id);
          states[id] = Boolean(item && !item.deletedAt);
        }));
        sendResponse({ success: true, states });
      } catch (err) {
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "TOGGLE_NOOK_BOOKMARK") {
    (async () => {
      try {
        const item = message.item;
        if (!item?.id || !item.url) {
          sendResponse({ success: false, error: "Invalid item" });
          return;
        }
        const existing = await NookDB.getBookmark(item.id);
        if (existing && !existing.deletedAt) {
          await NookDB.softDeleteBookmark(item.id);
          sendResponse({ success: true, saved: false });
          return;
        }
        await NookDB.saveOrRestoreBookmark(item);
        sendResponse({ success: true, saved: true });
      } catch (err) {
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "SYNC_ITEMS_BATCH") {
    // mergeBatch() runs the whole batch inside a single IndexedDB
    // transaction, so the page's own Bookmarks fetch and auto sync arriving
    // together can no longer race the way parallel get/set on a single
    // chrome.storage.local "items" array could (the old _syncQueue promise
    // chain that serialized those writes is no longer needed).
    (async () => {
      try {
        const incoming = message.items;
        if (!Array.isArray(incoming) || incoming.length === 0) {
          sendResponse({ success: false, error: "No items" });
          return;
        }

        // Already-saved items get their tweet content (quote, media, text)
        // refreshed when an older parser missed something, but keep the
        // user's list, tags and savedAt — see NookDB.mergeTweetContent.
        const { added, updated } = await NookDB.mergeBatch(incoming, NookDB.mergeTweetContent);
        sendResponse({ success: true, count: added.length, updated: updated.length });
      } catch (err) {
        console.error("[Nook Background] Error in SYNC_ITEMS_BATCH:", err);
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true; // Keep channel open
  }

  if (message?.type === "STORE_QUERY_ID") {
    // Content script reports a captured queryId from inject.js interception
    if (message.queryId) {
      _cachedBookmarkQueryId = message.queryId;
      console.log("[Nook Background] Cached queryId:", _cachedBookmarkQueryId);
    }
    sendResponse({ success: true });
    return true;
  }

  if (message?.type === "GET_QUERY_ID") {
    sendResponse({ queryId: _cachedBookmarkQueryId });
    return true;
  }

  if (message?.type === "START_AUTO_SYNC_X") {
    chrome.tabs.create({ url: "https://x.com/i/bookmarks", active: true }, (tab) => {
      const syncTabId = tab.id;
      if (syncTabId === undefined) return;
      const tabId = syncTabId;
      let tabComplete = false;
      let queryIdReady = !!_cachedBookmarkQueryId;

      function maybeSendSync() {
        if (!tabComplete || !queryIdReady) return;

        // Verify tab is actually on x.com (not some redirect)
        chrome.tabs.get(tabId, (t) => {
          if (chrome.runtime.lastError || !t) return;
          console.log("[Nook Background] Tab URL when sending sync:", t.url);

          chrome.tabs.sendMessage(tabId, {
            type: "BEGIN_AUTO_SYNC",
            queryId: _cachedBookmarkQueryId
          } as const, () => {
            if (chrome.runtime.lastError) {
              console.warn("[Nook Background] sendMessage failed, retrying in 1.5s...");
              setTimeout(() => {
                chrome.tabs.sendMessage(tabId, {
                  type: "BEGIN_AUTO_SYNC",
                  queryId: _cachedBookmarkQueryId
                }, () => {});
              }, 1500);
            }
          });
        });
      }

      // Wait for tab to finish loading
      function onTabUpdated(updatedTabId: number, changeInfo: { status?: string }) {
        if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(onTabUpdated);
        // Small delay to let React render and inject.js intercept the API call
        setTimeout(() => {
          tabComplete = true;
          maybeSendSync();
        }, 2000);
      }
      chrome.tabs.onUpdated.addListener(onTabUpdated);

      // Also check if we already have a queryId — if so, just wait for tab complete
      // If not, wait up to 10s for STORE_QUERY_ID to arrive
      if (!queryIdReady) {
        const queryIdTimeout = setTimeout(() => {
          console.warn("[Nook Background] queryId not received in 10s, proceeding without it");
          queryIdReady = true; // let content script try on its own
          maybeSendSync();
        }, 10000);

        // Override: if STORE_QUERY_ID arrives before timeout, resolve immediately
        const queryIdWatcher = (msg: ContentToBackgroundMessage, _sender: chrome.runtime.MessageSender, resp: (response?: MessageResponse) => void) => {
          if (msg?.type === "STORE_QUERY_ID" && msg.queryId) {
            _cachedBookmarkQueryId = msg.queryId;
            queryIdReady = true;
            clearTimeout(queryIdTimeout);
            chrome.runtime.onMessage.removeListener(queryIdWatcher);
            resp({ success: true });
            maybeSendSync();
          }
        };
        chrome.runtime.onMessage.addListener(queryIdWatcher);
      }
    });
    sendResponse({ success: true });
    return true;
  }

  if (message?.type === "CLOSE_CURRENT_TAB") {
    if (sender.tab && sender.tab.id) {
      chrome.tabs.remove(sender.tab.id).catch(() => {});
    }
    sendResponse({ success: true });
    return true;
  }

  // -- popup (control center) messages --------------------------------------

  if (message?.type === "GET_ACTIVE_PAGE_STATE") {
    getActivePageState()
      .then((state) => sendResponse({ success: true, state }))
      .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (message?.type === "SAVE_ACTIVE_PAGE") {
    saveActivePage()
      .then(sendResponse)
      .catch((err) => sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) }));
    return true;
  }

  if (message?.type === "REMOVE_BOOKMARK") {
    (async () => {
      try {
        await NookDB.softDeleteBookmark(message.id);
        sendResponse({ success: true });
        notifyActiveTabBookmarkState(message.id, false).catch(() => {});
        refreshBadgeForActiveTab().catch(() => {});
      } catch (err) {
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }

  if (message?.type === "UPDATE_BOOKMARK") {
    (async () => {
      try {
        const patch: BookmarkPatch = { ...message.patch };
        if (patch.listId) {
          const lists = await NookDB.getAllLists();
          const matchedList = lists.find((list) => list.id === patch.listId);
          if (matchedList) patch.listName = matchedList.name;
        } else if (patch.listId === null) {
          patch.listName = null;
        }
        const item = await NookDB.updateBookmark(message.id, patch);
        sendResponse({ success: Boolean(item) });
      } catch (err) {
        sendResponse({ success: false, error: err instanceof Error ? err.message : String(err) });
      }
    })();
    return true;
  }
});


// Auto-reload x.com tabs when extension is updated to prevent invalidated context errors
chrome.runtime.onInstalled.addListener(() => {
  NookDB.ready().catch((err) => {
    console.error("[Nook Background] NookDB.ready() failed:", err);
  });

  registerContextMenus();

  chrome.tabs.query({ url: ["*://x.com/*", "*://twitter.com/*"] }, (tabs) => {
    for (const tab of tabs) {
      if (tab.id !== undefined) chrome.tabs.reload(tab.id);
    }
  });
});

});
