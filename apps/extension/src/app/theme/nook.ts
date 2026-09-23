import { defineTheme } from "@astryxdesign/core/theme";
import { neutralTheme } from "@astryxdesign/theme-neutral";

/**
 * The Nook product theme: Astryx neutral plus Nook-specific component overrides.
 * Every surface (dashboard, popup, in-page toast) uses this, so they share tokens.
 *
 * Built with `npm run theme:build` into nook.css / nook.js — import those, not this file.
 */
export const nookTheme = defineTheme({
  name: "nook",
  extends: neutralTheme,
  components: {
    toast: {
      // Astryx paints info toasts on the inverted surface (a near-black card in
      // light mode, white in dark). Nook's toast floats over web pages like the
      // dashboard's menus and popovers do, so it uses the same popover surface.
      base: {
        backgroundColor: "var(--color-background-popover)",
        color: "var(--color-text-primary)",
        borderWidth: "var(--border-width)",
        borderStyle: "solid",
        borderColor: "var(--color-border)",
        boxShadow: "var(--shadow-high)",
      },
    },
  },
});
