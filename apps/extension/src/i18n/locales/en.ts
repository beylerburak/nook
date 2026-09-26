import { dashboard } from "./en/dashboard";
import { settings } from "./en/settings";
import { ai } from "./en/ai";
import { popup } from "./en/popup";
import { extension } from "./en/extension";
import { web } from "./en/web";

/**
 * English message catalog — the source of truth for Nook's own i18n.
 *
 * This is NOT Astryx's catalog (that ships built-in and covers component
 * strings like "Close" on a Dialog). This file is Nook's product copy:
 * everything a component in `src/app` renders as user-facing text.
 *
 * Shape:
 *  - Nested object, namespaced by area (`common`, `dashboard`,
 *    `settings.appearance`, …). Add new namespaces as new areas get
 *    converted — don't cram unrelated strings into an existing one.
 *  - A leaf is either a plain string (interpolated with `{name}` style
 *    placeholders) or a plural table (`{ one: "...", other: "..." }`,
 *    picked by `Intl.PluralRules` — see `t("dashboard.itemCount", { count })`
 *    below for the shape).
 *  - `as const` so `src/i18n/types.ts` can derive the exact key union and
 *    catch typos in `t()` calls at compile time.
 *
 * See `docs/i18n.md` for the full guide (naming, plurals, interpolation,
 * Turkish style guide) before adding keys here.
 */
export const en = {
  common: {
    system: "System",
    close: "Close",
    save: "Save",
    cancel: "Cancel",
    /** Interpolation example — `{name}` is replaced from the `params` object passed to `t()`. */
    greeting: "Hello, {name}",
  },

  // One file per area under ./en/ (and ./tr/), so areas can be translated
  // independently without every change landing in this one file.
  dashboard,
  settings,
  ai,
  popup,
  extension,
  web,
} as const;
