/**
 * Nook's i18n module. See `docs/i18n.md` for the full guide.
 *
 * React: wrap a tree in `<I18nProvider>` and call `useI18n()` for
 * `{ t, locale, setLocale, formatDate, formatNumber, formatRelativeTime }`.
 *
 * Outside React (content scripts, background handlers, plain utilities):
 * `translate(locale, key, params)` plus `resolveLocale()` / `getActiveLocale()`.
 */
export { DEFAULT_LOCALE, LOCALES, isLocale, resolveLocale, translate, type Locale } from "./core";
export { getActiveLocale, I18nProvider, useI18n, type I18nContextValue } from "./react";
export type { InterpolationParams, MessageKey, MessageLeaf, Messages, MessageTree, ParamsFor, PluralForms } from "./types";
export {
  LOCALE_STORAGE_KEY,
  loadLocaleSetting,
  readCachedLocaleSetting,
  saveLocaleSetting,
  subscribeToLocaleSetting,
  toLocaleSetting,
  type LocaleSetting,
} from "../../lib/locale";
