(function () {
  console.log("[Nook Inject] Interceptor running in MAIN world");

  const originalFetch = window.fetch;

  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : args[0]?.url;

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

  XMLHttpRequest.prototype.open = function (method, url) {
    this._nookUrl = url;
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
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
    return originalSend.apply(this, arguments);
  };
})();
