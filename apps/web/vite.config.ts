import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { swPrecachePlugin } from "./vite-plugins/sw-precache.ts";
import { appHistoryFallbackPlugin } from "./vite-plugins/app-history-fallback.ts";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react(), swPrecachePlugin(), appHistoryFallbackPlugin()],
  server: { proxy: { "/api": "http://localhost:18482" } },
  // "mpa" (not the default "spa"): serves each html file's own dev/preview
  // route with no *global* history fallback — appType "spa" would rewrite
  // every unmatched navigation to the root index.html, which here is the
  // landing page, not the app. appHistoryFallbackPlugin above adds that
  // fallback back for the /app/* subtree only.
  appType: "mpa",
  build: {
    rollupOptions: {
      // Two independent HTML entries — see docs/cloud.md's URL layout note:
      // "/" is the static landing placeholder, "/app" is the real app shell.
      // Rollup preserves each input's path relative to `root` under outDir,
      // so this produces dist/index.html and dist/app/index.html.
      input: {
        landing: resolve(root, "index.html"),
        app: resolve(root, "app/index.html"),
      },
    },
  },
});
