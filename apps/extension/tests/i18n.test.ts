// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "../src/i18n/locales/en";
import { tr } from "../src/i18n/locales/tr";
import { DEFAULT_LOCALE, LOCALES, isLocale, resolveLocale, translate } from "../src/i18n/core";
import {
  LOCALE_STORAGE_KEY,
  loadLocaleSetting,
  readCachedLocaleSetting,
  saveLocaleSetting,
  subscribeToLocaleSetting,
  toLocaleSetting,
} from "../lib/locale";

type ChangeListener = (changes: Record<string, { newValue?: unknown }>, areaName: string) => void;

function stubChromeStorage(initial: Record<string, unknown> = {}) {
  const data = { ...initial };
  const listeners: ChangeListener[] = [];
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async (key: string) => (key in data ? { [key]: data[key] } : {})),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(data, items);
          const changes = Object.fromEntries(Object.entries(items).map(([k, v]) => [k, { newValue: v }]));
          listeners.forEach((fn) => fn(changes, "local"));
        }),
      },
      onChanged: {
        addListener: (fn: ChangeListener) => listeners.push(fn),
        removeListener: (fn: ChangeListener) => listeners.splice(listeners.indexOf(fn), 1),
      },
    },
  });
  return data;
}

// Node ships its own global localStorage that shadows happy-dom's, so use a plain in-memory one.
function stubLocalStorage() {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  });
}

function setOrigin(url: string) {
  vi.spyOn(window, "location", "get").mockReturnValue(new URL(url) as unknown as Location);
}

/** Every leaf dot-path in a locale catalog — a plural entry (all its own keys are plural categories) counts as one leaf. */
const PLURAL_CATEGORY_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);
function collectKeys(node: unknown, prefix = ""): string[] {
  if (typeof node !== "object" || node === null) return [prefix];
  const keys = Object.keys(node as Record<string, unknown>);
  const isPluralLeaf = keys.length > 0 && keys.every((key) => PLURAL_CATEGORY_KEYS.has(key));
  if (isPluralLeaf) return [prefix];
  return keys.flatMap((key) => collectKeys((node as Record<string, unknown>)[key], prefix ? `${prefix}.${key}` : key));
}

describe("i18n key lookup, interpolation and plurals", () => {
  it("looks up a plain string key", () => {
    expect(translate("en", "common.system")).toBe("System");
    expect(translate("tr", "common.system")).toBe("Sistem");
  });

  it("interpolates {name}-style placeholders", () => {
    expect(translate("en", "common.greeting", { name: "Ada" })).toBe("Hello, Ada");
    expect(translate("tr", "common.greeting", { name: "Ada" })).toBe("Merhaba, Ada");
  });

  it("leaves an unmatched placeholder untouched", () => {
    expect(translate("en", "common.greeting", {})).toBe("Hello, {name}");
  });

  it("a key with no params still returns its literal text", () => {
    expect(translate("en", "settings.appearance.modeLight")).toBe(en.settings.appearance.modeLight);
  });

  it("picks the English plural category (one vs other)", () => {
    expect(translate("en", "dashboard.itemCount", { count: 1 })).toBe("1 saved item");
    expect(translate("en", "dashboard.itemCount", { count: 0 })).toBe("0 saved items");
    expect(translate("en", "dashboard.itemCount", { count: 2 })).toBe("2 saved items");
  });

  it("picks the Turkish plural category (one vs other)", () => {
    expect(translate("tr", "dashboard.itemCount", { count: 1 })).toBe("1 kayıtlı öğe");
    expect(translate("tr", "dashboard.itemCount", { count: 5 })).toBe("5 kayıtlı öğe");
  });

  it("falls back to en for a key missing from another locale at runtime", async () => {
    vi.resetModules();
    vi.doMock("../src/i18n/locales/tr", () => ({
      tr: { common: { system: "Sistem" } }, // missing everything else on purpose
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const core = await import("../src/i18n/core");
      // Present in en, absent from this mocked tr -> falls back to the en string.
      expect(core.translate("tr", "settings.appearance.modeLight")).toBe("Light");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.doUnmock("../src/i18n/locales/tr");
      vi.resetModules();
    }
  });

  it("returns the key itself and warns when a key exists in neither locale", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // @ts-expect-error deliberately invalid key to exercise the missing-key path
    expect(translate("en", "nope.not.a.real.key")).toBe("nope.not.a.real.key");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("tr has exactly the same key set as en", () => {
    expect(collectKeys(tr).sort()).toEqual(collectKeys(en).sort());
  });
});

describe("locale resolution", () => {
  it("returns an explicit setting as-is", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(resolveLocale("tr")).toBe("tr");
  });

  it("resolves 'system' from the browser language: tr-TR -> tr", () => {
    expect(resolveLocale("system", "tr-TR")).toBe("tr");
  });

  it("resolves 'system' from the browser language: de -> en (default)", () => {
    expect(resolveLocale("system", "de")).toBe("en");
  });

  it("treats an undefined/invalid setting the same as 'system'", () => {
    expect(resolveLocale(undefined, "tr")).toBe("tr");
    expect(resolveLocale("bogus", "de-DE")).toBe("en");
  });

  it("isLocale / LOCALES / DEFAULT_LOCALE are internally consistent", () => {
    expect(LOCALES).toContain(DEFAULT_LOCALE);
    for (const locale of LOCALES) expect(isLocale(locale)).toBe(true);
    expect(isLocale("system")).toBe(false);
    expect(isLocale("fr")).toBe(false);
  });
});

describe("locale setting persistence (lib/locale.ts)", () => {
  beforeEach(() => stubLocalStorage());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("toLocaleSetting falls back to 'system' for anything unrecognized", () => {
    expect(toLocaleSetting("tr")).toBe("tr");
    expect(toLocaleSetting("en")).toBe("en");
    expect(toLocaleSetting("fr")).toBe("system");
    expect(toLocaleSetting(undefined)).toBe("system");
  });

  it("saves and loads the setting through chrome.storage (extension page)", async () => {
    setOrigin("chrome-extension://nook/dashboard.html");
    stubChromeStorage();

    await saveLocaleSetting("tr");

    await expect(loadLocaleSetting()).resolves.toBe("tr");
  });

  it("reads the shared preference from chrome.storage (content script on a host page)", async () => {
    setOrigin("https://x.com/home");
    stubChromeStorage({ [LOCALE_STORAGE_KEY]: "tr" });

    await expect(loadLocaleSetting()).resolves.toBe("tr");
    // Content scripts never get a synchronous cache — always "system" until loadLocaleSetting resolves.
    expect(readCachedLocaleSetting()).toBe("system");
  });

  it("migrates a setting that only exists in extension-page localStorage", async () => {
    setOrigin("chrome-extension://nook/popup.html");
    localStorage.setItem(LOCALE_STORAGE_KEY, "tr");
    const data = stubChromeStorage();

    await expect(loadLocaleSetting()).resolves.toBe("tr");
    expect(data[LOCALE_STORAGE_KEY]).toBe("tr");
  });

  it("notifies subscribers when another surface changes the setting", async () => {
    setOrigin("chrome-extension://nook/popup.html");
    stubChromeStorage();
    const listener = vi.fn();
    const unsubscribe = subscribeToLocaleSetting(listener);

    await saveLocaleSetting("tr");
    unsubscribe();
    await saveLocaleSetting("en");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("tr");
  });
});
