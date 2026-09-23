export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
  runAt: "document_start",
  world: "MAIN",
  main() {
  console.log("[Nook Inject] Interceptor running in MAIN world");

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const input = args[0];
    const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.href;

    if (url && url.includes("/i/api/graphql/") && url.includes("Bookmarks")) {
      const queryIdMatch = url.match(/\/i\/api\/graphql\/([^/?]+)\/Bookmarks/);
      if (queryIdMatch) {
        window.__nookBookmarkQueryId = queryIdMatch[1];
        window.postMessage({ type: "NOOK_QUERY_ID", queryId: queryIdMatch[1] }, "*");
        console.log("[Nook Inject] Captured queryId:", queryIdMatch[1]);
      }

      const response = await originalFetch.apply(this, args);
      try {
        const data = await response.clone().json();
        window.postMessage({ type: "NOOK_SYNC_BOOKMARKS", data }, "*");
        console.log("[Nook Inject] Intercepted Bookmarks fetch:", url);
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
      if (u && u.includes("/i/api/graphql/") && u.includes("Bookmarks")) {
        try {
          const queryIdMatch = u.match(/\/i\/api\/graphql\/([^/?]+)\/Bookmarks/);
          if (queryIdMatch) {
            window.__nookBookmarkQueryId = queryIdMatch[1];
            window.postMessage({ type: "NOOK_QUERY_ID", queryId: queryIdMatch[1] }, "*");
          }
          const data = JSON.parse(this.responseText);
          window.postMessage({ type: "NOOK_SYNC_BOOKMARKS", data }, "*");
        } catch (e) {}
      }
    });
    return originalSend.call(this, body);
  };
  }
});
import { defineContentScript } from "wxt/utils/define-content-script";
