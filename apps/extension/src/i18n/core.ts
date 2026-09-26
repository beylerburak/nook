import { en } from "./locales/en";
import { tr } from "./locales/tr";
import type { InterpolationParams, MessageKey, MessageLeaf, MessageTree, ParamsFor, PluralForms } from "./types";

/** A supported, concrete locale — never "system", see `LocaleSetting` in `lib/locale.ts` for the user-facing setting. */
export type Locale = "en" | "tr";

/** Every locale Nook ships a catalog for, in the order they should be offered in a picker. */
export const LOCALES: readonly Locale[] = ["en", "tr"];

/** The fallback locale: used for a missing key in any other locale, and when resolution can't determine one. */
export const DEFAULT_LOCALE: Locale = "en";

const CATALOGS: Record<Locale, MessageTree> = { en, tr };

export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Saved setting → browser language → default. A setting of "system" (or any
 * other non-locale value) falls through to `navigatorLanguage` and picks
 * "tr" for any Turkish variant (`tr`, `tr-TR`, …), else "en".
 */
export function resolveLocale(setting: string | undefined, navigatorLanguage?: string): Locale {
  if (isLocale(setting)) return setting;
  const lang = (navigatorLanguage ?? (typeof navigator !== "undefined" ? navigator.language : "") ?? "").toLowerCase();
  return lang.startsWith("tr") ? "tr" : DEFAULT_LOCALE;
}

function readLeaf(tree: MessageTree, key: string): MessageLeaf | undefined {
  let node: MessageLeaf | MessageTree = tree;
  for (const part of key.split(".")) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
    const next: MessageLeaf | MessageTree | undefined = (node as MessageTree)[part];
    if (next === undefined) return undefined;
    node = next;
  }
  return node as MessageLeaf;
}

function isPluralForms(leaf: MessageLeaf): leaf is PluralForms {
  return typeof leaf === "object" && leaf !== null;
}

function interpolate(template: string, params: InterpolationParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

function resolvePlural(leaf: PluralForms, locale: Locale, count: number): string {
  const category = new Intl.PluralRules(locale).select(count);
  return leaf[category] ?? leaf.other;
}

/**
 * Non-React entry point: resolves `key` against `locale`'s catalog, falling
 * back to `en` at runtime for a key that locale hasn't caught up on yet
 * (this is a safety net — `tr satisfies Messages` should make that
 * unreachable for keys that exist in `en`, but a stale build or a locale
 * added later without full coverage still degrades gracefully instead of
 * throwing). Missing from `en` too → the key itself, plus a console warning.
 *
 * Use this from code that isn't inside `<I18nProvider>` — content scripts,
 * background handlers, non-React utilities. Get `locale` from
 * `lib/locale.ts` (`readCachedLocaleSetting()` + `resolveLocale()`), or from
 * `useI18n().locale` if you do have React.
 */
export function translate<K extends MessageKey>(locale: Locale, key: K, params?: ParamsFor<K>): string {
  let leaf = readLeaf(CATALOGS[locale], key);
  if (leaf === undefined && locale !== DEFAULT_LOCALE) {
    leaf = readLeaf(CATALOGS[DEFAULT_LOCALE], key);
  }
  if (leaf === undefined) {
    console.warn(`[i18n] Missing message key "${key}"`);
    return key;
  }
  if (isPluralForms(leaf)) {
    const count = typeof (params as { count?: unknown } | undefined)?.count === "number"
      ? (params as { count: number }).count
      : 0;
    return interpolate(resolvePlural(leaf, locale, count), params as InterpolationParams);
  }
  return interpolate(leaf, params as InterpolationParams);
}

export type { MessageKey, ParamsFor, PluralForms, InterpolationParams };
