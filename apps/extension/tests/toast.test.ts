import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShowBookmarkToastMessage } from "../lib/types";

const toast: ShowBookmarkToastMessage = { type: "SHOW_BOOKMARK_TOAST", message: "Saved to Nook ✓", bookmarkId: "x:1" };
const TAB_ID = 7;

type Listener = (message: unknown, sender: { tab?: { id: number } }) => void;

function stubChrome(options: { url: string; sendMessage: (...args: unknown[]) => Promise<unknown>; onInject?: () => void }) {
  const runtimeListeners: Listener[] = [];
  const chromeStub = {
    runtime: {
      onMessage: { addListener: (fn: Listener) => runtimeListeners.push(fn) },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
    tabs: {
      sendMessage: vi.fn(options.sendMessage),
      get: vi.fn().mockResolvedValue({ id: TAB_ID, url: options.url }),
      onRemoved: { addListener: vi.fn() },
      onUpdated: { addListener: vi.fn() },
    },
    scripting: {
      // Simulates the injected host mounting and pinging "ready".
      executeScript: vi.fn(async () => {
        options.onInject?.();
        runtimeListeners.forEach((fn) => fn({ type: "BOOKMARK_TOAST_READY" }, { tab: { id: TAB_ID } }));
        return [];
      }),
    },
  };
  vi.stubGlobal("chrome", chromeStub);
  return chromeStub;
}

async function loadToastModule() {
  vi.resetModules();
  const mod = await import("../lib/toast");
  mod.initBookmarkToastDelivery();
  return mod;
}

describe("sendBookmarkToast", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("injects the toast host when another Nook content script answers without an ack", async () => {
    let injected = false;
    const chromeStub = stubChrome({
      url: "https://x.com/home",
      // The X content script listens too and resolves with no ack until the host exists.
      sendMessage: async () => (injected ? { toastShown: true } : undefined),
      onInject: () => {
        injected = true;
      },
    });
    const { sendBookmarkToast } = await loadToastModule();

    await sendBookmarkToast(TAB_ID, toast);

    expect(chromeStub.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(chromeStub.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("does not re-inject when the mounted host acknowledges", async () => {
    const chromeStub = stubChrome({ url: "https://example.com", sendMessage: async () => ({ toastShown: true }) });
    const { sendBookmarkToast } = await loadToastModule();

    await sendBookmarkToast(TAB_ID, toast);

    expect(chromeStub.scripting.executeScript).not.toHaveBeenCalled();
    expect(chromeStub.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("gives up quietly on pages that can't be scripted", async () => {
    const chromeStub = stubChrome({
      url: "chrome://extensions/",
      sendMessage: () => Promise.reject(new Error("Receiving end does not exist")),
    });
    const { sendBookmarkToast } = await loadToastModule();

    await expect(sendBookmarkToast(TAB_ID, toast)).resolves.toBeUndefined();
    expect(chromeStub.scripting.executeScript).not.toHaveBeenCalled();
  });
});
