import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { swPrecachePlugin } from "./vite-plugins/sw-precache.ts";

export default defineConfig({
  plugins: [react(), swPrecachePlugin()],
  server: { proxy: { "/api": "http://localhost:18482" } },
});
