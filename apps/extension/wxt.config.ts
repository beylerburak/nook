import { defineConfig } from "wxt";

export default defineConfig({
  srcDir: ".",
  entrypointsDir: "entrypoints",
  manifest: {
    name: "Nook",
    description: "Save what matters.",
    permissions: ["storage", "tabs", "bookmarks", "scripting", "unlimitedStorage"],
    host_permissions: ["<all_urls>"],
    options_ui: { page: "dashboard.html", open_in_tab: true },
    key: "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAthwrbxrlICm5xchfjfpW6r7Z9IgewRJSVB6aBx3tKFh3F0xy5wRBttmYVnAkuzMZ0AepAPQh1Yw4n62xMfi8qZtoimN6YjTnyAF++5DEQj2nnmKUS19gQcB3juY99Ln9sI8FiWcY3LGmFjqfY89Icj/BZzBlW/XadtJcoiooO1InoK6i0v9cM4IYnBDsrx+LXG0fWaVQXLrCdxP0jrT9SKjX/AU2s/AeZiPZd3Pp/ggWcsSgRunx/drPeA5NfvLVV3+ndybeWyQL4UIyjvRpY1IA/psJUzsn5b9WTsOi3H1ZvvyXJaUm4+G+9/WeF/PVoOAaVbolfhBcC02AtCN4SwIDAQAB"
  }
});
