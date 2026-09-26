import type { Plugin } from "vite";

/**
 * Builds the service worker source. Kept as a plain template string (rather
 * than a compiled .ts file) since it runs in the SW's own worker context,
 * outside the app's module graph, and has no need for TypeScript types of
 * its own — it's a handful of straightforward Cache Storage calls.
 *
 * Caching rules (docs/cloud.md "PWA / offline" + product-contract.md #5):
 *  - navigations *under /app*: network-first, falling back to the cached
 *    app shell (/app/index.html)
 *  - navigations to "/" (the landing page) or anything else outside /app:
 *    never intercepted — this worker has nothing to say about them, even
 *    though it may technically be in control of them (see the scope note
 *    below), so they always just hit the network like an uncontrolled page
 *  - /assets/*: cache-first (hashed filenames, shared by both landing and
 *    app pages — safe to cache forever regardless of which page loaded them)
 *  - /api/* and /health: never intercepted, always network
 *  - old cache versions are dropped on activate
 *
 * Scope migration note: this script is registered by registerServiceWorker.ts
 * with `scope: "/app/"` (allowed without a Service-Worker-Allowed header
 * since it's narrower than the script's own default max scope of "/", see
 * https://w3c.github.io/ServiceWorker/#dom-serviceworkercontainer-register).
 * A build from before the /app split may still have a *registration* at the
 * origin root ("/") on returning devices — same script URL (/sw.js), old
 * scope. Once that registration's script content updates to this one, it
 * activates *at scope "/"*, which would otherwise mean it's in control of
 * fetches for the landing page too. Two things make that harmless: (1) the
 * fetch handler below only ever answers for /app/* navigations, so a "/"
 * navigation just passes through to the network as if uncontrolled, and
 * (2) activate() below notices it's running at the root scope and
 * unregisters itself outright, since a root-scope registration serves no
 * purpose going forward — every client will get a fresh, correctly-scoped
 * "/app/" registration the next time it opens the app.
 */
function buildServiceWorkerSource(cacheVersion: string, precacheUrls: string[]): string {
  return `// Generated at build time by vite-plugins/sw-precache.ts — do not edit by hand.
const CACHE_NAME = "nook-precache-${cacheVersion}";
const PRECACHE_URLS = ${JSON.stringify(precacheUrls)};
const SHELL_URL = "/app/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
      // Legacy root-scope registration from before the /app split — see the
      // "Scope migration note" above. Drop it; a correctly-scoped "/app/"
      // registration takes over next time a client opens the app.
      if (new URL(self.registration.scope).pathname === "/") {
        await self.registration.unregister();
        return;
      }
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Never cache API calls or the health check — always hit the network so
  // sync, auth and status stay live.
  if (url.pathname.startsWith("/api/") || url.pathname === "/health") return;

  if (request.mode === "navigate") {
    // Only /app/* is this worker's shell to manage. "/" is the separate
    // landing page — even if this worker is (still, or again — see the
    // scope note above) in control of it, leave it alone: no respondWith
    // means the browser just does a normal network fetch.
    if (url.pathname !== "/app" && !url.pathname.startsWith("/app/")) return;
    event.respondWith(
      fetch(request).catch(() => caches.match(SHELL_URL).then((cached) => cached || caches.match(request)))
    );
    return;
  }

  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(
      caches.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        });
      })
    );
  }
});
`;
}

/**
 * Emits dist/sw.js with a build-time-generated precache list: every hashed
 * asset Rollup produced (shared by both pages) plus the built app/index.html
 * — but never the landing index.html, which isn't part of this worker's
 * /app/* shell (see the caching rules above). No extra dependency (workbox
 * et al.) — the caching rules above are simple enough to hand-write and keep
 * fully under our control.
 *
 * `enforce: "post"` matters here, not just for style: with two HTML entries
 * (this plugin's landing/app split, vite.config.ts), Rollup's `bundle` map
 * can — while default-phase plugins are still running — contain an
 * entry-chunk placeholder for the landing page (which has no `<script>` of
 * its own to produce real output), which only Vite's own core html plugin
 * (a "post"-phase plugin) prunes back out before anything is written to
 * disk. Reading `Object.keys(bundle)` any earlier than "post" would catch
 * that placeholder mid-flight and put a URL in PRECACHE_URLS that never
 * actually exists in dist/ — which fails `cache.addAll` for the *whole*
 * precache at install time, silently breaking offline support entirely.
 * Running after that pruning is what makes plain key-listing safe again.
 */
export function swPrecachePlugin(): Plugin {
  return {
    name: "nook-sw-precache",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const urls = new Set<string>(["/app/index.html"]);
      for (const fileName of Object.keys(bundle)) {
        if (fileName.endsWith(".map")) continue;
        if (fileName === "index.html") continue; // the landing shell — not ours to precache
        if (fileName === "sw.js") continue; // this file itself — emitted below, not something to self-cache
        urls.add(`/${fileName}`);
      }
      const version = String(Date.now());
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: buildServiceWorkerSource(version, [...urls]),
      });
    },
  };
}
