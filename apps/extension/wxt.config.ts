import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  entrypointsDir: "entrypoints",
  modules: ["@wxt-dev/module-react"],
  vite: () => ({
    build: {
      // Astryx themes switch light/dark with native CSS light-dark() driven by
      // color-scheme. Vite's default "baseline-widely-available" target predates
      // light-dark() (Chrome 123), so Lightning CSS rewrites it into a polyfill
      // keyed off prefers-color-scheme — which ignores the theme mode we pick
      // (e.g. the toast following the site, or Light/Dark in Appearance).
      // This is a Chrome-only MV3 build, so target a Chrome that has it natively.
      cssTarget: "chrome123",
      // Two chunks legitimately sit above Vite's default 500kB warning, and
      // neither benefits from further splitting:
      // - content-scripts/bookmark-toast.js bundles React + the Astryx
      //   toast stack, but it's registered with `registration: "runtime"`
      //   (see entrypoints/bookmark-toast.content.tsx) and only ever
      //   injected into a tab on demand, right before it shows a toast — it
      //   never ships to pages that don't need it.
      // - chunks/styles-*.js is the shared Astryx UI bundle for the
      //   dashboard/popup extension pages, not something injected into
      //   arbitrary web pages, so its size doesn't affect page weight.
      chunkSizeWarningLimit: 600,
    },
  }),
  manifest: {
    name: "Nook",
    description: "Save what matters.",
    permissions: ["storage", "tabs", "bookmarks", "scripting", "unlimitedStorage"],
    host_permissions: ["<all_urls>"],
    options_ui: { page: "dashboard.html", open_in_tab: true },
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAthwrbxrlICm5xchfjfpW6r7Z9IgewRJSVB6aBx3tKFh3F0xy5wRBttmYVnAkuzMZ0AepAPQh1Yw4n62xMfi8qZtoimN6YjTnyAF++5DEQj2nnmKUS19gQcB3juY99Ln9sI8FiWcY3LGmFjqfY89Icj/BZzBlW/XadtJcoiooO1InoK6i0v9cM4IYnBDsrx+LXG0fWaVQXLrCdxP0jrT9SKjX/AU2s/AeZiPZd3Pp/ggWcsSgRunx/drPeA5NfvLVV3+ndybeWyQL4UIyjvRpY1IA/psJUzsn5b9WTsOi3H1ZvvyXJaUm4+G+9/WeF/PVoOAaVbolfhBcC02AtCN4SwIDAQAB"
  }
});
