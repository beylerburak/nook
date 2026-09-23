import { createRoot } from "react-dom/client";
import { defineContentScript } from "wxt/utils/define-content-script";
import { createShadowRootUi } from "wxt/utils/content-script-ui/shadow-root";
import { BookmarkToastApp } from "../src/app/components/BookmarkToastHost";
import { loadAppearance } from "../lib/appearance";
import "./bookmark-toast-ui.css";

declare global {
  interface Window {
    // Isolated-world globals are shared by every content script this
    // extension injects into a given frame, so this flags a tab that
    // already has the toast host mounted and guards against mounting a
    // second one if the background script injects again (e.g. two
    // bookmark saves racing before the first injection reports ready).
    __nookBookmarkToastMounted?: boolean;
  }
}

export default defineContentScript({
  matches: ["<all_urls>"],
  cssInjectionMode: "ui",
  // Injected on demand by the background script instead of loading on every
  // page — see lib/toast.ts — so it stays out of the manifest's
  // content_scripts and only ships to tabs that actually show a toast.
  registration: "runtime",
  async main(ctx) {
    if (window.__nookBookmarkToastMounted) return;
    window.__nookBookmarkToastMounted = true;

    // Resolve the saved preference before the first render so the toast never flashes the wrong theme.
    const initialAppearance = await loadAppearance().catch(() => "system" as const);

    const ui = await createShadowRootUi(ctx, {
      name: "nook-bookmark-toast",
      position: "overlay",
      alignment: "bottom-right",
      zIndex: 2147483647,
      anchor: "body",
      onMount(container) {
        const root = createRoot(container);
        root.render(<BookmarkToastApp initialAppearance={initialAppearance} />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });

    ui.mount();
  },
});
