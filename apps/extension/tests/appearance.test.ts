// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APPEARANCE_STORAGE_KEY, loadAppearance, saveAppearance, subscribeToAppearance } from "../lib/appearance";

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

describe("appearance preference", () => {
  beforeEach(() => stubLocalStorage());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads the shared preference from chrome.storage (content script on x.com)", async () => {
    setOrigin("https://x.com/home");
    stubChromeStorage({ [APPEARANCE_STORAGE_KEY]: "dark" });

    await expect(loadAppearance()).resolves.toBe("dark");
  });

  it("migrates a preference that only exists in extension-page localStorage", async () => {
    setOrigin("chrome-extension://nook/dashboard.html");
    localStorage.setItem(APPEARANCE_STORAGE_KEY, "light");
    const data = stubChromeStorage();

    await expect(loadAppearance()).resolves.toBe("light");
    expect(data[APPEARANCE_STORAGE_KEY]).toBe("light");
  });

  it("falls back to system for missing or invalid values", async () => {
    setOrigin("https://x.com/home");
    stubChromeStorage({ [APPEARANCE_STORAGE_KEY]: "sepia" });

    await expect(loadAppearance()).resolves.toBe("system");
  });

  it("never writes to the host site's localStorage from a content script", async () => {
    setOrigin("https://x.com/home");
    stubChromeStorage();

    await saveAppearance("dark");

    expect(localStorage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull();
  });

  it("notifies subscribers when another surface changes the preference", async () => {
    setOrigin("chrome-extension://nook/popup.html");
    stubChromeStorage();
    const listener = vi.fn();
    const unsubscribe = subscribeToAppearance(listener);

    await saveAppearance("dark");
    unsubscribe();
    await saveAppearance("light");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith("dark");
  });
});
