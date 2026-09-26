import type { Connect, Plugin, PreviewServer, ViteDevServer } from "vite";

/**
 * `/app/*` is a client-routed SPA shell (src/router.ts + the dispatch table
 * in src/App.tsx) built from the single file app/index.html (see
 * vite.config.ts's `appType: "mpa"` + `build.rollupOptions.input`). Vite's
 * dev/preview servers only know about that one real file on disk, not about
 * deep links the app's own router owns (e.g. /app/dashboard) — so any GET
 * navigation under /app that isn't a request for an actual file needs to be
 * rewritten to /app/index.html *before* Vite's html/static middleware sees
 * it. This mirrors, for one subtree only, what a plain SPA's history-API
 * fallback (`appType: "spa"`) would do for the whole site — we can't use
 * that here because "/" is a *different*, separate page (the landing
 * placeholder), and it must never fall back to the app shell.
 */
function rewriteAppDeepLinks(): Connect.NextHandleFunction {
  return (req, res, next) => {
    const rawUrl = req.url || "";
    const pathname = rawUrl.split("?")[0].split("#")[0];
    const isAppPath = pathname === "/app" || pathname.startsWith("/app/");
    const isAppShellItself = pathname === "/app/index.html";
    // A dot after the last "/" means a real file request (main.tsx, a hashed
    // asset, a source map, ...) — let those fall through untouched so Vite
    // (or the preview server's static file handler) can serve them.
    const looksLikeFileRequest = /\.[^/]+$/.test(pathname);
    if (req.method === "GET" && isAppPath && !isAppShellItself && !looksLikeFileRequest) {
      const query = rawUrl.includes("?") ? rawUrl.slice(rawUrl.indexOf("?")) : "";
      req.url = `/app/index.html${query}`;
    }
    next();
  };
}

export function appHistoryFallbackPlugin(): Plugin {
  return {
    name: "nook-app-history-fallback",
    configureServer(server: ViteDevServer) {
      server.middlewares.use(rewriteAppDeepLinks());
    },
    configurePreviewServer(server: PreviewServer) {
      server.middlewares.use(rewriteAppDeepLinks());
    },
  };
}
