import { defineBackground } from "wxt/utils/define-background";
import { loadAiSettings } from "../../lib/ai-settings";
import { runClassification, type AiRunResult } from "../../lib/ai-runner";
import * as NookDB from "../../lib/db";
import {
  cloudApiUrl,
  cloudSession,
  cloudStatus,
  createJoinable,
  createTaskQueue,
  resetCloudSync,
  saveCloudSession,
  signOutCloud,
  syncCloud,
} from "../../lib/cloud-sync";
import { fetchBridgeSessionProfile, handleBridgeMessage, type ExtensionBridgeDeps } from "../../lib/extension-bridge";
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

const CLOUD_ALARM_PERIODIC = "nook-cloud-sync-periodic";
// After a local write (BroadcastChannel "nook-db"), give writes a moment to
// settle before syncing rather than firing once per record.
const DB_WRITE_SYNC_DEBOUNCE_MS = 2000;

// All cloud state-changing operations (sync, bridge connect/disconnect,
// sign-out, reset) run through this single serial queue, so e.g. a bridge
// CONNECT triggered from the web app can never race the periodic background
// sync and have its result silently overwritten. A plain sync (periodic
// alarm / debounced db-write / SYNC_CLOUD_NOW) joins an already
// queued-or-running sync instead of enqueueing a redundant extra one;
// connect/disconnect/sign-out/reset always get their own queue slot (see
// cloudQueue.enqueue below).
const cloudQueue = createTaskQueue();
function enqueue<T>(task: () => Promise<T>): Promise<T> {
  return cloudQueue.enqueue(task);
}
const queueSync = createJoinable(cloudQueue, () => syncCloud());

async function ensureCloudAlarm(): Promise<void> {
  await chrome.alarms.create(CLOUD_ALARM_PERIODIC, { periodInMinutes: 1 });
}
async function clearCloudAlarm(): Promise<void> {
  await chrome.alarms.clear(CLOUD_ALARM_PERIODIC);
}

// The periodic alarm only costs anything while signed in — re-check after
// every sync attempt so a 401 (which clears the token) stops it too.
async function syncAlarmUpkeep(): Promise<void> {
  if (!(await cloudSession())) await clearCloudAlarm();
}

function runCloudSync() {
  return queueSync().then(
    (result) => {
      syncAlarmUpkeep().catch(() => {});
      return result;
    },
    (error) => {
      syncAlarmUpkeep().catch(() => {});
      throw error;
    },
  );
}

// Same as runCloudSync(), but calls syncCloud() directly instead of going
// through the queue again. Only for use from *inside* a task that's already
// running as a queued slot (the bridge's CONNECT, below) — queueSync()
// there would enqueue onto the same cloudQueue slot this task itself
// occupies and wait for its own completion, deadlocking forever.
async function runCloudSyncFromQueuedTask() {
  try {
    const result = await syncCloud();
    syncAlarmUpkeep().catch(() => {});
    return result;
  } catch (error) {
    syncAlarmUpkeep().catch(() => {});
    throw error;
  }
}

// -- AI classification (lib/ai-runner.ts) ---------------------------------
//
// A second, independent tick alongside the cloud one. Deliberately not
// serialized with it: a 25-bookmark classify batch takes seconds, and letting
// it head-of-line block the 1-minute cloud sync (or the reverse) would let one
// slow subsystem stall the other. The two only ever meet in the same
// IndexedDB, which already serializes its own transactions.
const AI_ALARM_PERIODIC = "nook-ai-classify-periodic";
// Mirror of lib/db.ts's "nook-cloud-sync-soon": a bookmark saved just after a
// tick should not wait out the rest of the period.
const AI_ALARM_SOON = "nook-ai-classify-soon";
const AI_ALARM_PERIOD_MINUTES = 5;

// Both AI routes are session-guarded and the feature ships off by default, so
// the alarm is only worth waking a service worker for while a session exists
// and the toggle is on. Re-checked after every tick (same reasoning as
// syncAlarmUpkeep) so a sign-out or a toggle-off tears the alarm down instead
// of leaving it firing into a 401.
async function aiIsArmable(): Promise<boolean> {
  const [settings, session] = await Promise.all([loadAiSettings(), cloudSession()]);
  return settings.autoClassify && Boolean(session);
}

async function ensureAiAlarm(): Promise<void> {
  await chrome.alarms.create(AI_ALARM_PERIODIC, { periodInMinutes: AI_ALARM_PERIOD_MINUTES });
}

async function clearAiAlarm(): Promise<void> {
  await chrome.alarms.clear(AI_ALARM_PERIODIC);
  await chrome.alarms.clear(AI_ALARM_SOON);
}

async function armAiAlarmSoon(): Promise<void> {
  if (!(await aiIsArmable())) return;
  await chrome.alarms.create(AI_ALARM_SOON, { delayInMinutes: 0.1 });
}

async function aiAlarmUpkeep(): Promise<void> {
  if (!(await aiIsArmable())) await clearAiAlarm();
}

// Mirrors runCloudSync(): report, then re-check whether the alarm still has a
// reason to exist. runClassification() never rejects, but a throwing dep
// shouldn't be allowed to take down the listener either.
function runAiClassification(): void {
  runClassification().then(
    (result) => {
      aiAlarmUpkeep().catch(() => {});
      if (result.error) {
        console.log("[Nook Background] AI classification stopped:", result.error);
      } else if (result.processed > 0) {
        console.log(
          "[Nook Background] AI classification:",
          `${result.assigned} filed, ${result.tagged} tagged, ${result.skipped} skipped of ${result.processed}`,
        );
      }
    },
    (error) => {
      aiAlarmUpkeep().catch(() => {});
      console.error("[Nook Background] AI classification failed:", error);
    },
  );
}

// -- extension <-> web bridge (chrome.runtime.onMessageExternal) -----------
//
// See lib/bridge-protocol.ts / lib/extension-bridge.ts. handleBridgeMessage
// holds the actual origin-check/HELLO/CONNECT/DISCONNECT logic and is unit
// tested there; this just wires it to the real cloud-sync + alarm APIs and
// routes every call through the same serial queue as everything else that
// mutates cloud state.
const BRIDGE_API_URL = cloudApiUrl();
const bridgeDeps: ExtensionBridgeDeps = {
  apiUrl: BRIDGE_API_URL,
  version: chrome.runtime.getManifest().version,
  fetchSession: (token) => fetchBridgeSessionProfile(BRIDGE_API_URL, token),
  currentSession: () => cloudSession(),
  saveSession: (token, ownerId, profile) => saveCloudSession(token, ownerId, profile),
  replaceAccount: () => resetCloudSync(),
  // Clears this device's token only (owner + sync state are left so a later
  // reconnect with the same owner stays incremental) — the web app already
  // signed itself out, so this is best-effort and never blocks on it.
  disconnect: () => signOutCloud(),
  startAlarm: () => ensureCloudAlarm(),
  stopAlarm: () => clearCloudAlarm(),
  // handleBridgeMessage's own call already runs inside a cloudQueue slot
  // (see the onMessageExternal listener below) — runCloudSync() would
  // enqueue a second task behind that slot and deadlock waiting on itself.
  requestSync: () => runCloudSyncFromQueuedTask(),
  status: () => cloudStatus().then((status) => ({
    apiUrl: status.apiUrl,
    signedIn: status.signedIn,
    ownerId: status.ownerId,
    lastSyncedAt: status.lastSyncedAt,
    pendingCount: status.pendingCount,
    rejectedCount: status.rejected.length,
    offline: status.offline,
  })),
};

export default defineBackground(() => {
console.log("[Nook Background] Service Worker initialized");

initBookmarkToastDelivery();

// Open the DB (and run the one-time chrome.storage.local migration) as soon
// as the service worker wakes up, so the first message handler that needs
// it doesn't pay the open+migrate cost on the critical path.
NookDB.ready().catch((err) => {
  console.error("[Nook Background] NookDB.ready() failed:", err);
});

// The periodic alarm exists only while signed in — no point waking the
// worker every minute for a browser that isn't syncing anything.
cloudSession()
  .then((session) => (session ? ensureCloudAlarm() : undefined))
  .catch(() => {});

// Same deal for the AI tick, one gate stricter: signed in *and* autoClassify
// on, because every one of these ticks is a paid, authenticated call.
aiIsArmable()
  .then((armable) => (armable ? ensureAiAlarm() : undefined))
  .catch(() => {});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CLOUD_ALARM_PERIODIC && alarm.name !== "nook-cloud-sync-soon") return;
  void runCloudSync().catch((error) => console.error("[Nook] Cloud sync failed:", error));
});

// A separate listener rather than a branch in the one above, so the cloud
// sync tick keeps exactly the alarm names it had.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== AI_ALARM_PERIODIC && alarm.name !== AI_ALARM_SOON) return;
  runAiClassification();
});

// Sync once as soon as the worker wakes up — including on browser startup,
// since defineBackground's setup runs every time the service worker spins
// up, startup included.
void runCloudSync().catch((error) => console.error("[Nook] Cloud sync failed:", error));

// Sync automatically shortly after any local write, anywhere in the
// extension (dashboard, popup, X content script). Debounced so a burst of
// writes (e.g. an import) triggers one sync, not one per record. This is
// the common case; the periodic alarm above and the "nook-cloud-sync-soon"
// wake-up alarm (lib/db.ts) are the fallback for when the service worker
// gets killed before this timer fires.
let dbWriteSyncTimer: ReturnType<typeof setTimeout> | null = null;
const dbWriteChannel = new BroadcastChannel("nook-db");
dbWriteChannel.addEventListener("message", () => {
  if (dbWriteSyncTimer !== null) clearTimeout(dbWriteSyncTimer);
  dbWriteSyncTimer = setTimeout(() => {
    dbWriteSyncTimer = null;
    void runCloudSync().catch((error) => console.error("[Nook] Cloud sync failed:", error));
  }, DB_WRITE_SYNC_DEBOUNCE_MS);
});

// -- extension <-> web bridge: messages from the web app -------------------

function isLikelyBridgeRequest(message: unknown): boolean {
  return Boolean(message) && typeof (message as { type?: unknown }).type === "string" &&
    (message as { type: string }).type.startsWith("NOOK_BRIDGE_");
}

chrome.runtime.onMessageExternal.addListener((message: unknown, sender, sendResponse) => {
  if (!isLikelyBridgeRequest(message)) return false;
  enqueue(() => handleBridgeMessage(message, sender.origin, bridgeDeps)).then(
    (response) => sendResponse(response),
    (error) => sendResponse({ ok: false, code: "ERROR", error: error instanceof Error ? error.message : String(error) }),
  );
  return true;
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
    // Armed from the save paths rather than from the "nook-db" channel above:
    // every AI write is itself a db write, so a channel listener here would
    // re-arm the alarm from its own run and burn a second tick finding
    // nothing to do.
    void armAiAlarmSoon().catch(() => {});
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

/**
 * What a handler may answer with. `AiRunResult` is here for CLASSIFY_NOW,
 * which replies with the pass itself rather than a wrapper: the panel shows what
 * the run did (filed, left alone, and why it stopped), and `runClassification()`
 * never rejects, so a delivered reply is the result and there is no separate
 * success flag to invent or check.
 */
type BackgroundReply = MessageResponse | ActivePageStateResponse | AiRunResult;

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse: (response?: BackgroundReply) => void) => {
  if (message?.type === "SYNC_CLOUD_NOW") {
    runCloudSync().then(
      (result) => sendResponse({ success: Boolean(result), ...result }),
      (error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }

  if (message?.type === "CLASSIFY_NOW") {
    // The same entry point the 5-minute alarm uses, so the click and the tick
    // cannot both bill a batch: runClassification() is single-flight-guarded and
    // a second call joins the run already in flight.
    runClassification().then(
      (run) => sendResponse(run),
      (error) =>
        sendResponse({
          processed: 0,
          assigned: 0,
          tagged: 0,
          skipped: 0,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    return true;
  }

  if (message?.type === "CLOUD_SIGN_OUT") {
    enqueue(async () => {
      await signOutCloud();
      await clearCloudAlarm();
    }).then(
      () => sendResponse({ success: true }),
      (error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }

  if (message?.type === "CLOUD_RESET") {
    enqueue(async () => {
      await resetCloudSync();
      await clearCloudAlarm();
    }).then(
      () => sendResponse({ success: true }),
      (error) => sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  }

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
        void armAiAlarmSoon().catch(() => {});
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
        void armAiAlarmSoon().catch(() => {});
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
