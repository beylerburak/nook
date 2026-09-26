/**
 * Registers the service worker generated at build time by
 * vite-plugins/sw-precache.ts (see vite.config.ts). Dev builds skip this —
 * the plugin only emits dist/sw.js during `vite build`, and precaching the
 * Vite dev server's ever-changing module graph would fight HMR.
 *
 * Only called from the app entry (src/main.tsx, loaded by app/index.html) —
 * the landing page has no script of its own at all, so it never reaches
 * this. Scope is explicitly "/app/", not the default (the script URL's own
 * directory, "/"): this worker only ever answers for /app/* navigations
 * (see the generated fetch handler), and scoping the registration to match
 * means it's never even asked about "/" or anything outside /app. A scope
 * narrower than "/sw.js"'s own directory is allowed without a
 * Service-Worker-Allowed response header — see the scope migration note in
 * vite-plugins/sw-precache.ts for what happens to a pre-existing "/"-scoped
 * registration from before this split.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js", { scope: "/app/" }).catch((error: unknown) => {
      console.error("[Nook] Service worker registration failed:", error);
    });
  });
}
