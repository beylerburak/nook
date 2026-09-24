/**
 * The Nook appearance preference (system / light / dark), shared by every
 * surface: dashboard, popup and the in-page toast.
 *
 * chrome.storage.local is the source of truth because content scripts run on
 * the host site's origin (e.g. x.com) and can't see the extension's own
 * localStorage. Extension pages additionally keep a synchronous localStorage
 * copy so their first paint already uses the right theme.
 */

import type { ThemeMode } from "@astryxdesign/core/theme";

export const APPEARANCE_STORAGE_KEY = "nook.appearance";
const APPEARANCE_MODES: readonly ThemeMode[] = ["system", "light", "dark"];

export function toThemeMode(value: unknown): ThemeMode {
  return APPEARANCE_MODES.includes(value as ThemeMode) ? (value as ThemeMode) : "system";
}

function isExtensionPage(): boolean {
  return location.protocol === "chrome-extension:";
}

function hasExtensionStorage(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.storage?.local);
}

function writeCachedAppearance(mode: ThemeMode): void {
  if (!isExtensionPage() && hasExtensionStorage()) return;
  try {
    localStorage.setItem(APPEARANCE_STORAGE_KEY, mode);
  } catch {
    // Storage blocked; chrome.storage still holds the preference.
  }
}

/** Synchronous best guess for the first render. Content scripts always get "system". */
export function readCachedAppearance(): ThemeMode {
  if (!isExtensionPage() && hasExtensionStorage()) return "system";
  try {
    return toThemeMode(localStorage.getItem(APPEARANCE_STORAGE_KEY));
  } catch {
    return "system";
  }
}

export async function loadAppearance(): Promise<ThemeMode> {
  if (!hasExtensionStorage()) return readCachedAppearance();
  const stored: unknown = (await chrome.storage.local.get(APPEARANCE_STORAGE_KEY))[APPEARANCE_STORAGE_KEY];
  if (stored !== undefined) return toThemeMode(stored);

  // One-time migration: the preference used to live only in extension-page localStorage.
  const cached = readCachedAppearance();
  if (cached !== "system") await chrome.storage.local.set({ [APPEARANCE_STORAGE_KEY]: cached });
  return cached;
}

export async function saveAppearance(mode: ThemeMode): Promise<void> {
  writeCachedAppearance(mode);
  if (!hasExtensionStorage()) return;
  await chrome.storage.local.set({ [APPEARANCE_STORAGE_KEY]: mode });
}

/** Fires when any surface changes the preference. Returns an unsubscribe function. */
export function subscribeToAppearance(listener: (mode: ThemeMode) => void): () => void {
  if (!hasExtensionStorage()) {
    const handleStorage = (event: StorageEvent) => {
      if (event.key === APPEARANCE_STORAGE_KEY) listener(toThemeMode(event.newValue));
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }
  const handleChange = (changes: Record<string, chrome.storage.StorageChange>, areaName: string) => {
    if (areaName !== "local" || !(APPEARANCE_STORAGE_KEY in changes)) return;
    const mode = toThemeMode(changes[APPEARANCE_STORAGE_KEY].newValue);
    writeCachedAppearance(mode);
    listener(mode);
  };
  chrome.storage.onChanged.addListener(handleChange);
  return () => chrome.storage.onChanged.removeListener(handleChange);
}
