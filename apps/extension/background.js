// Nook Background Service Worker
// Listens for Chrome bookmark creation and captures web pages automatically

importScripts("shared.js", "db.js");

console.log("[Nook Background] Service Worker initialized");

// Open the DB (and run the one-time chrome.storage.local migration) as soon
// as the service worker wakes up, so the first message handler that needs
// it doesn't pay the open+migrate cost on the critical path.
self.NookDB.ready().catch((err) => {
  console.error("[Nook Background] NookDB.ready() failed:", err);
});

// Cached X Bookmarks GraphQL queryId (captured from network by inject.js)
let _cachedBookmarkQueryId = null;


chrome.bookmarks.onCreated.addListener(async (id, bookmark) => {
  try {
    // 1. Validate bookmark
    if (!bookmark.url) return; // Skip folders

    const urlStr = bookmark.url;
    if (
      urlStr.startsWith("javascript:") ||
      urlStr.startsWith("chrome://") ||
      urlStr.startsWith("chrome-extension://") ||
      urlStr.startsWith("about:") ||
      urlStr.startsWith("edge://") ||
      urlStr.startsWith("brave://")
    ) {
      return; // Skip browser-internal URLs
    }

    console.log("[Nook Background] New Chrome bookmark detected:", bookmark.title, urlStr);

    let urlObj;
    try {
      urlObj = new URL(urlStr);
    } catch (e) {
      return;
    }

    const hostname = urlObj.hostname.replace(/^www\./, "");

    // 2. Try to extract metadata from the active tab or matching tab
    let metadata = null;
    let targetTab = null;

    try {
      const activeTabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (activeTabs[0] && activeTabs[0].url && activeTabs[0].url.split("#")[0] === urlStr.split("#")[0]) {
        targetTab = activeTabs[0];
      } else {
        const matchingTabs = await chrome.tabs.query({ url: urlStr.split("#")[0] + "*" });
        if (matchingTabs.length > 0) {
          targetTab = matchingTabs[0];
        }
      }

      if (targetTab && targetTab.id && !targetTab.url.startsWith("chrome://")) {
        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: extractPageMetadataInTab
        });
        if (results && results[0] && results[0].result) {
          metadata = results[0].result;
        }
      }
    } catch (tabErr) {
      console.log("[Nook Background] Could not extract from tab, will use fallback:", tabErr.message);
    }

    // 3. Fallback: If no metadata extracted from tab, fetch the page HTML
    if (!metadata) {
      metadata = await fetchPageMetadata(urlStr);
    }

    // 4. Construct Nook Bookmark Item
    const title = (metadata?.title || bookmark.title || hostname).trim();
    const description = (metadata?.description || "").trim();
    const ogImage = metadata?.image || null;
    const siteName = metadata?.siteName || hostname;
    const avatar =
      metadata?.iconHref ||
      targetTab?.favIconUrl ||
      `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;

    const media = ogImage
      ? [{ type: "image", url: ogImage, alt: title }]
      : [];

    const newItem = {
      id: `chrome:${bookmark.id || crypto.randomUUID()}`,
      source: "chrome",
      title,
      shortDescription: description ? description.slice(0, 180) : "",
      description,
      category: null,
      tags: ["web"],
      listId: null,
      listName: null,
      media,
      attachments: media,
      urls: [urlStr],
      url: urlStr,
      creator: {
        name: siteName,
        handle: hostname,
        avatar
      },
      createdAt: new Date(bookmark.dateAdded || Date.now()).toISOString(),
      savedAt: new Date().toISOString()
    };

    // 5. Save to IndexedDB (deduplicate by URL, ignoring soft-deleted rows)
    const existing = await self.NookDB.findBookmarkByUrl(urlStr);
    if (existing) {
      // Update existing item with new metadata/saved time, keep its id
      await self.NookDB.putBookmark({ ...existing, ...newItem, id: existing.id });
    } else {
      await self.NookDB.putBookmark(newItem);
    }
    console.log("[Nook Background] Bookmark successfully saved to Nook:", newItem);

    // 6. Visual Feedback: Action badge on extension icon
    chrome.action.setBadgeText({ text: "✓" });
    chrome.action.setBadgeBackgroundColor({ color: "#10b981" });
    setTimeout(() => {
      chrome.action.setBadgeText({ text: "" });
    }, 2400);

    // 7. In-page Toast notification on the tab
    if (targetTab && targetTab.id && !targetTab.url.startsWith("chrome://")) {
      const toastMsg = ogImage
        ? `Nook: Saved "${siteName}" with image ✓`
        : `Nook: Saved "${siteName}" to bookmarks ✓`;

      chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        func: showNookToastInPage,
        args: [toastMsg]
      }).catch(() => {});
    }
  } catch (err) {
    console.error("[Nook Background] Error capturing bookmark:", err);
  }
});

// Function executed inside the web page tab to extract OpenGraph & Meta info
function extractPageMetadataInTab() {
  try {
    const getMeta = (selectors) => {
      for (const sel of selectors) {
        const el = document.querySelector(`meta[property="${sel}"], meta[name="${sel}"]`);
        if (el && el.content) {
          const val = el.content.trim();
          if (val) return val;
        }
      }
      return null;
    };

    const title =
      getMeta(["og:title", "twitter:title"]) ||
      document.title ||
      "";

    const description =
      getMeta(["og:description", "twitter:description", "description"]) ||
      "";

    const siteName =
      getMeta(["og:site_name"]) ||
      window.location.hostname.replace(/^www\./, "");

    let image = getMeta(["og:image", "twitter:image", "twitter:image:src"]);
    if (image) {
      try {
        image = new URL(image, window.location.href).href;
      } catch (e) {}
    }

    // High resolution favicon
    let iconHref = null;
    const iconEl =
      document.querySelector('link[rel*="apple-touch-icon"]') ||
      document.querySelector('link[rel*="icon"][sizes="192x192"]') ||
      document.querySelector('link[rel*="icon"][sizes="32x32"]') ||
      document.querySelector('link[rel*="icon"]');

    if (iconEl && iconEl.href) {
      try {
        iconHref = new URL(iconEl.href, window.location.href).href;
      } catch (e) {}
    }

    return { title, description, siteName, image, iconHref };
  } catch (e) {
    return null;
  }
}

// Fallback: Fetch page HTML and extract OpenGraph tags via regex
async function fetchPageMetadata(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      }
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const html = await res.text();

    const getTagContent = (pattern) => {
      const match = html.match(pattern);
      return match ? match[1].trim() : null;
    };

    const title =
      getTagContent(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      getTagContent(/<title[^>]*>([^<]+)<\/title>/i) ||
      "";

    const description =
      getTagContent(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
      getTagContent(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
      "";

    let image =
      getTagContent(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      getTagContent(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);

    if (image) {
      try {
        image = new URL(image, url).href;
      } catch (e) {}
    }

    const siteName =
      getTagContent(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);

    return { title, description, siteName, image, iconHref: null };
  } catch (e) {
    return null;
  }
}

// In-page toast notification injected into web pages when bookmarked
function showNookToastInPage(message) {
  const id = "nook-toast-feedback";
  let toast = document.getElementById(id);
  if (!toast) {
    toast = document.createElement("div");
    toast.id = id;
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      background: #18181b;
      color: #f4f4f5;
      padding: 11px 20px;
      border-radius: 9999px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13.5px;
      font-weight: 500;
      box-shadow: 0 12px 30px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.12);
      z-index: 2147483647;
      pointer-events: none;
      transition: opacity 0.25s ease, transform 0.25s ease;
      transform: translateY(12px);
      opacity: 0;
    `;
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";

  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transform = "translateY(12px)";
  }, 2600);
}

// Message listener from content script
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "SAVE_ITEM") {
    (async () => {
      try {
        const item = message.item;
        if (!item || !item.id) {
          sendResponse({ success: false, error: "Invalid item" });
          return;
        }

        const existing = await self.NookDB.getBookmark(item.id);
        if (existing && !existing.deletedAt) {
          // Already saved and not deleted: nothing to do.
        } else if (existing && existing.deletedAt) {
          // A deliberate re-click of X's bookmark button on a post the user
          // had removed from Nook should restore it, with fresh content.
          await self.NookDB.putBookmark({ ...existing, ...item, deletedAt: null });
        } else {
          await self.NookDB.putBookmark(item);
        }

        const count = (await self.NookDB.getAllBookmarks()).length;
        sendResponse({ success: true, count });
      } catch (err) {
        console.error("[Nook Background] Error in SAVE_ITEM:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open for async response
  }

  if (message && message.type === "SYNC_ITEMS_BATCH") {
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
        const { added, updated } = await self.NookDB.mergeBatch(incoming, self.NookDB.mergeTweetContent);
        sendResponse({ success: true, count: added.length, updated: updated.length });
      } catch (err) {
        console.error("[Nook Background] Error in SYNC_ITEMS_BATCH:", err);
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true; // Keep channel open
  }

  if (message && message.type === "STORE_QUERY_ID") {
    // Content script reports a captured queryId from inject.js interception
    if (message.queryId) {
      _cachedBookmarkQueryId = message.queryId;
      console.log("[Nook Background] Cached queryId:", _cachedBookmarkQueryId);
    }
    sendResponse({ success: true });
    return true;
  }

  if (message && message.type === "GET_QUERY_ID") {
    sendResponse({ queryId: _cachedBookmarkQueryId });
    return true;
  }

  if (message && message.type === "START_AUTO_SYNC_X") {
    chrome.tabs.create({ url: "https://x.com/i/bookmarks", active: true }, (tab) => {
      const syncTabId = tab.id;
      let tabComplete = false;
      let queryIdReady = !!_cachedBookmarkQueryId;

      function maybeSendSync() {
        if (!tabComplete || !queryIdReady) return;

        // Verify tab is actually on x.com (not some redirect)
        chrome.tabs.get(syncTabId, (t) => {
          if (chrome.runtime.lastError || !t) return;
          console.log("[Nook Background] Tab URL when sending sync:", t.url);

          chrome.tabs.sendMessage(syncTabId, {
            type: "BEGIN_AUTO_SYNC",
            queryId: _cachedBookmarkQueryId
          }, () => {
            if (chrome.runtime.lastError) {
              console.warn("[Nook Background] sendMessage failed, retrying in 1.5s...");
              setTimeout(() => {
                chrome.tabs.sendMessage(syncTabId, {
                  type: "BEGIN_AUTO_SYNC",
                  queryId: _cachedBookmarkQueryId
                }).catch(() => {});
              }, 1500);
            }
          });
        });
      }

      // Wait for tab to finish loading
      function onTabUpdated(tabId, changeInfo) {
        if (tabId !== syncTabId || changeInfo.status !== "complete") return;
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
        const origListener = arguments.callee; // not ideal but functional here
        const queryIdWatcher = (msg, _sender, resp) => {
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

  if (message && message.type === "CLOSE_CURRENT_TAB") {
    if (sender.tab && sender.tab.id) {
      chrome.tabs.remove(sender.tab.id).catch(() => {});
    }
    sendResponse({ success: true });
    return true;
  }
});


// Auto-reload x.com tabs when extension is updated to prevent invalidated context errors
chrome.runtime.onInstalled.addListener(() => {
  self.NookDB.ready().catch((err) => {
    console.error("[Nook Background] NookDB.ready() failed:", err);
  });

  chrome.tabs.query({ url: ["*://x.com/*", "*://twitter.com/*"] }, (tabs) => {
    for (const tab of tabs) {
      chrome.tabs.reload(tab.id);
    }
  });
});
