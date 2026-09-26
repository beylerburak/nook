/**
 * The Nook language preference (system / English / Türkçe), shared by every
 * surface: dashboard, popup and the in-page toast — same storage strategy
 * as `lib/appearance.ts`, see that file for why.
 *
 * chrome.storage.local is the source of truth because content scripts run on
 * the host site's origin (e.g. x.com) and can't see the extension's own
 * localStorage. Extension pages additionally keep a synchronous localStorage
 * copy so their first paint already uses the right language.
 *
 * This module only stores the *setting* ("system" | "en" | "tr"). Resolving
 * "system" to an actual locale (from `navigator.language`) is
 * `resolveLocale()` in `src/i18n/core.ts` — kept there so this module has no
 * dependency on the message catalogs.
 */

export type LocaleSetting = "system" | "en" | "tr";

export const LOCALE_STORAGE_KEY = "nook.locale";
const LOCALE_SETTINGS: readonly LocaleSetting[] = ["system", "en", "tr"];

export function toLocaleSetting(value: unknown): LocaleSetting {
  return LOCALE_SETTINGS.includes(value as LocaleSetting) ? (value as LocaleSetting) : "system";
}

function isExtensionPage(): boolean {
  return location.protocol === "chrome-extension:";
}

function hasExtensionStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

function writeCachedLocaleSetting(setting: LocaleSetting): void {
  if (!isExtensionPage() && hasExtensionStorage()) return;
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, setting);
  } catch {
    // Storage blocked; chrome.storage still holds the preference.
  }
}

/** Synchronous best guess for the first render. Content scripts always get "system". */
export function readCachedLocaleSetting(): LocaleSetting {
  if (!isExtensionPage() && hasExtensionStorage()) return "system";
  try {
    return toLocaleSetting(localStorage.getItem(LOCALE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export async function loadLocaleSetting(): Promise<LocaleSetting> {
  if (!hasExtensionStorage()) return readCachedLocaleSetting();
  const stored: unknown = (await chrome.storage.local.get(LOCALE_STORAGE_KEY))[LOCALE_STORAGE_KEY];
  if (stored !== undefined) return toLocaleSetting(stored);

  // One-time migration: the preference used to live only in extension-page localStorage.
  const cached = readCachedLocaleSetting();
  if (cached !== "system") await chrome.storage.local.set({ [LOCALE_STORAGE_KEY]: cached });
  return cached;
}

export async function saveLocaleSetting(setting: LocaleSetting): Promise<void> {
  writeCachedLocaleSetting(setting);
  if (!hasExtensionStorage()) return;
  await chrome.storage.local.set({ [LOCALE_STORAGE_KEY]: setting });
}

/** Fires when any surface changes the preference. Returns an unsubscribe function. */
export function subscribeToLocaleSetting(listener: (setting: LocaleSetting) => void): () => void {
  if (!hasExtensionStorage()) {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === LOCALE_STORAGE_KEY) listener(toLocaleSetting(event.newValue));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }
  const handleChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== "local" || !(LOCALE_STORAGE_KEY in changes)) return;
    const setting = toLocaleSetting(changes[LOCALE_STORAGE_KEY].newValue);
    writeCachedLocaleSetting(setting);
    listener(setting);
  };
  chrome.storage.onChanged.addListener(handleChange);
  return () => chrome.storage.onChanged.removeListener(handleChange);
}
