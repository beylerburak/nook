import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { InternationalizationProvider } from "@astryxdesign/core/i18n";
import astryxTr from "@astryxdesign/core/locales/tr-TR.json";
import {
  loadLocaleSetting,
  readCachedLocaleSetting,
  saveLocaleSetting,
  subscribeToLocaleSetting,
  type LocaleSetting,
} from "../../lib/locale";
import { DEFAULT_LOCALE, LOCALES, resolveLocale, translate, type Locale } from "./core";
import type { MessageKey, ParamsFor } from "./types";

export interface I18nContextValue {
  /** The concrete locale in effect right now ("en" | "tr") — "system" already resolved. */
  locale: Locale;
  /** The raw user setting ("system" | "en" | "tr"), for driving the picker's selected value. */
  localeSetting: LocaleSetting;
  setLocale: (setting: LocaleSetting) => void;
  t: <K extends MessageKey>(key: K, params?: ParamsFor<K>) => string;
  formatDate: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  formatNumber: (value: number, options?: Intl.NumberFormatOptions) => string;
  formatRelativeTime: (value: number, unit: Intl.RelativeTimeFormatUnit) => string;
}

const ASTRYX_MESSAGES = { tr: astryxTr };

const I18nContext = createContext<I18nContextValue | null>(null);

/**
 * Module-level mirror of the active locale, updated by `<I18nProvider>`.
 * Lets same-bundle, non-React code (a plain utility function, a toast
 * builder) read the current locale without threading it through props —
 * `getActiveLocale()` + `translate()` from `./core`. This is a same-JS-context
 * mirror only: a content script is a *different* bundle/context, so it can't
 * see this variable — it should read the setting itself via
 * `readCachedLocaleSetting()` from `lib/locale.ts` (backed by
 * chrome.storage.local, which every context can see) and resolve+translate
 * from that. See `docs/i18n.md` for the full non-React usage notes.
 */
let activeLocale: Locale = resolveLocale(readCachedLocaleSetting());

export function getActiveLocale(): Locale {
  return activeLocale;
}

/**
 * Idempotent: a provider already above this one owns the locale, so a nested
 * one (DashboardApp mounts its own for the extension page, and the web app
 * mounts one above it for the sign-in screen) just passes through — two
 * independent states would drift, because a same-window `storage` event never
 * reaches the outer one.
 */
export function I18nProvider({ children }: { children: ReactNode }) {
  const parent = useContext(I18nContext);
  if (parent) return <>{children}</>;
  return <RootI18nProvider>{children}</RootI18nProvider>;
}

function RootI18nProvider({ children }: { children: ReactNode }) {
  const [setting, setSetting] = useState<LocaleSetting>(() => readCachedLocaleSetting());

  useEffect(() => {
    let isActive = true;
    loadLocaleSetting()
      .then((stored) => {
        if (isActive) setSetting(stored);
      })
      .catch((error) => console.warn("[Nook] Could not load locale:", error));
    const unsubscribe = subscribeToLocaleSetting(setSetting);
    return () => {
      isActive = false;
      unsubscribe();
    };
  }, []);

  const locale = useMemo(() => resolveLocale(setting), [setting]);

  useEffect(() => {
    activeLocale = locale;
    if (typeof document !== "undefined") document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: LocaleSetting) => {
    setSetting(next);
    saveLocaleSetting(next).catch((error) => console.warn("[Nook] Could not save locale:", error));
  }, []);

  const t = useCallback(
    <K extends MessageKey>(key: K, params?: ParamsFor<K>) => translate(locale, key, params),
    [locale],
  );

  const formatDate = useCallback(
    (date: Date | number, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(date),
    [locale],
  );
  const formatNumber = useCallback(
    (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value),
    [locale],
  );
  const formatRelativeTime = useCallback(
    (value: number, unit: Intl.RelativeTimeFormatUnit) =>
      new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit),
    [locale],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ locale, localeSetting: setting, setLocale, t, formatDate, formatNumber, formatRelativeTime }),
    [locale, setting, setLocale, t, formatDate, formatNumber, formatRelativeTime],
  );

  return (
    <I18nContext.Provider value={value}>
      {/*
       * Wires Astryx's own locale support (AGENTS.md: `astryx docs internationalization`)
       * so built-in component strings (Dialog's "Close", Pagination, Timestamp's
       * relative times, …) follow the same locale. Astryx bundles only `en`; its
       * Turkish catalog ships as a JSON file and is keyed by our bare "tr" tag here,
       * because the provider resolves `tr` → `tr` and would never look up "tr-TR".
       */}
      <InternationalizationProvider locale={locale} messages={ASTRYX_MESSAGES}>
        {children}
      </InternationalizationProvider>
    </I18nContext.Provider>
  );
}

let warnedNoProvider = false;

/**
 * A non-reactive fallback used when `useI18n()` is called outside
 * `<I18nProvider>` — e.g. a component rendered directly in isolation (unit
 * tests for `SettingsDialog`/`AiPanel` etc. do this; they weren't written
 * expecting to also stand up the i18n provider). It resolves the locale
 * once from the cached setting and translates against that; `setLocale`
 * still persists the choice (so it takes effect once a real provider is
 * mounted) but can't re-render this tree, since there's no state here to
 * update. Real app surfaces always go through the mounted provider in
 * `DashboardApp`/`PopupApp` and never hit this path.
 */
function fallbackContextValue(): I18nContextValue {
  const setting = readCachedLocaleSetting();
  const locale = resolveLocale(setting);
  const setLocale = (next: LocaleSetting) => {
    if (!warnedNoProvider) {
      warnedNoProvider = true;
      console.warn(
        "[Nook] useI18n() is being used outside <I18nProvider> — the language choice will be saved but won't update this render live.",
      );
    }
    saveLocaleSetting(next).catch((error) => console.warn("[Nook] Could not save locale:", error));
  };
  return {
    locale,
    localeSetting: setting,
    setLocale,
    t: (key, params) => translate(locale, key, params),
    formatDate: (date, options) => new Intl.DateTimeFormat(locale, options).format(date),
    formatNumber: (value, options) => new Intl.NumberFormat(locale, options).format(value),
    formatRelativeTime: (value, unit) => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit),
  };
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  return ctx ?? fallbackContextValue();
}

export { LOCALES, DEFAULT_LOCALE };
export type { Locale, LocaleSetting };
