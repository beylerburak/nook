import { defineContentScript } from "wxt/utils/define-content-script";
import { extractVideoMediaEntries } from "../../lib/x-parser";

export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
  console.log("[Nook Inject] Interceptor running in MAIN world");

  // Scans any X GraphQL response (HomeTimeline, TweetDetail, UserTweets,
  // SearchTimeline, Bookmarks, …) for video/GIF media and forwards the
  // poster->MP4 mappings to the isolated-world content script, which caches
  // them for DOM saves (see entrypoints/content/video-media-registry.ts).
  // Posts nothing when the response has no video media.
  function postVideoMedia(data: unknown): void {
    const entries = extractVideoMediaEntries(data);
    if (entries.length > 0) {
      window.postMessage({ type: "NOOK_VIDEO_MEDIA", entries }, "*");
    }
  }

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const input = args[0];
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;

    if (url && url.includes("/i/api/graphql/")) {
      const isBookmarks = url.includes("Bookmarks");
      if (isBookmarks) {
        const queryIdMatch = url.match(/\/i\/api\/graphql\/([^/?]+)\/Bookmarks/);
        if (queryIdMatch) {
          window.__nookBookmarkQueryId = queryIdMatch[1];
          window.postMessage({ type: "NOOK_QUERY_ID", queryId: queryIdMatch[1] }, "*");
          console.log("[Nook Inject] Captured queryId:", queryIdMatch[1]);
        }
      }

      const response = await originalFetch.apply(this, args);
      if (!isBookmarks) {
        // Don't hold X's own request back: scan the clone in the background.
        response.clone().json().then(postVideoMedia, () => {});
        return response;
      }
      try {
        const data = await response.clone().json();
        window.postMessage({ type: "NOOK_SYNC_BOOKMARKS", data }, "*");
        console.log("[Nook Inject] Intercepted Bookmarks fetch:", url);
        postVideoMedia(data);
      } catch (err) {
        console.error("[Nook Inject] Error reading intercepted fetch:", err);
      }
      return response;
    }
    return originalFetch.apply(this, args);
  };

  // XHR fallback
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method: string, url: string | URL, async: boolean = true, username?: string | null, password?: string | null) {
    this._nookUrl = String(url);
    return originalOpen.call(this, method, url, async, username, password);
  };

  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null) {
    this.addEventListener("load", function () {
      const u = this._nookUrl;
      if (u && u.includes("/i/api/graphql/")) {
        try {
          const isBookmarks = u.includes("Bookmarks");
          if (isBookmarks) {
            const queryIdMatch = u.match(/\/i\/api\/graphql\/([^/?]+)\/Bookmarks/);
            if (queryIdMatch) {
              window.__nookBookmarkQueryId = queryIdMatch[1];
              window.postMessage({ type: "NOOK_QUERY_ID", queryId: queryIdMatch[1] }, "*");
            }
          }
          const data = JSON.parse(this.responseText);
          if (isBookmarks) {
            window.postMessage({ type: "NOOK_SYNC_BOOKMARKS", data }, "*");
          }
          postVideoMedia(data);
        } catch (e) {}
      }
    });
    return originalSend.call(this, body);
  };
  }
});
