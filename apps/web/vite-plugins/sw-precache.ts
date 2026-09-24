import type { Plugin } from "vite";

/**
 * Builds the service worker source. Kept as a plain template string (rather
 * than a compiled .ts file) since it runs in the SW's own worker context,
 * outside the app's module graph, and has no need for TypeScript types of
 * its own — it's a handful of straightforward Cache Storage calls.
 *
 * Caching rules (docs/cloud.md "PWA / offline" + product-contract.md #5):
 *  - navigations: network-first, falling back to the cached shell (index.html)
 *  - /assets/*: cache-first (hashed filenames — safe to cache forever)
 *  - /api/* and /health: never intercepted, always network
 *  - old cache versions are dropped on activate
 */
function buildServiceWorkerSource(cacheVersion: string, precacheUrls: string[]): string {
  return `// Generated at build time by vite-plugins/sw-precache.ts — do not edit by hand.
const CACHE_NAME = "nook-precache-${cacheVersion}";
const PRECACHE_URLS = ${JSON.stringify(precacheUrls)};
const SHELL_URL = "/index.html";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
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
 * asset Rollup produced plus the built index.html. No extra dependency
 * (workbox et al.) — the caching rules above are simple enough to hand-write
 * and keep fully under our control.
 */
export function swPrecachePlugin(): Plugin {
  return {
    name: "nook-sw-precache",
    apply: "build",
    generateBundle(_options, bundle) {
      const urls = new Set<string>(["/index.html"]);
      for (const fileName of Object.keys(bundle)) {
        if (fileName.endsWith(".map")) continue;
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
