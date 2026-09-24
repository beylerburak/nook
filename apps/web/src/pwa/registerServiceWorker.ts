/**
 * Registers the service worker generated at build time by
 * vite-plugins/sw-precache.ts (see vite.config.ts). Dev builds skip this —
 * the plugin only emits dist/sw.js during `vite build`, and precaching the
 * Vite dev server's ever-changing module graph would fight HMR.
 */
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.error("[Nook] Service worker registration failed:", error);
    });
  });
}
