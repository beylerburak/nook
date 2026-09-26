/**
 * Live-updating locale for the x.com content scripts.
 *
 * These run on x.com's own origin — a different JS context/page than the
 * extension's own pages, so they can't see the mirror `<I18nProvider>` keeps
 * in `src/i18n/react.tsx` (`getActiveLocale()`). They resolve the locale
 * themselves from `chrome.storage.local` instead, per docs/i18n.md's
 * "Non-React usage" section.
 *
 * `readCachedLocaleSetting()` always answers "system" for a content script
 * (no synchronous cache there — see lib/locale.ts), so `currentLocale` starts
 * as whatever that resolves to from `navigator.language`, then gets refined
 * once the real, persisted setting loads, and kept in sync afterwards.
 */
import { loadLocaleSetting, readCachedLocaleSetting, subscribeToLocaleSetting } from "../../lib/locale";
import { resolveLocale, type Locale } from "../../src/i18n/core";

let currentLocale: Locale = resolveLocale(readCachedLocaleSetting());

void loadLocaleSetting()
  .then((setting) => {
    currentLocale = resolveLocale(setting);
  })
  .catch(() => {
    // Keep the navigator.language-derived guess above; nothing else to fall back to here.
  });

subscribeToLocaleSetting((setting) => {
  currentLocale = resolveLocale(setting);
});

/** The best-known locale right now — synchronous, for call sites (e.g. rendering a button label) that can't await. */
export function getContentLocale(): Locale {
  return currentLocale;
}
