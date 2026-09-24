// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastViewport } from "@astryxdesign/core/Toast";
import { NookHostProvider, useNookHost, type NookHost, type NookSessionInfo } from "../src/app/host/NookHost";
import { SettingsDialog } from "../src/app/settings-dialog/SettingsDialog";
import type { CloudStatus } from "../lib/cloud-sync";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// SettingsDialog reads live sync status through this hook; stub it so tests
// control the value directly instead of exercising the real IndexedDB-backed
// subscription (see lib/cloud-sync.ts, owned by another agent this round).
let cloudStatus: CloudStatus | null = null;
vi.mock("../src/app/host/useCloudStatus", () => ({
  useCloudStatus: () => cloudStatus,
}));

function fakeStatus(overrides: Partial<CloudStatus> = {}): CloudStatus {
  return {
    apiUrl: "https://nook.beyler.co",
    signedIn: true,
    offline: false,
    syncing: false,
    pendingCount: 0,
    rejected: [],
    lastSyncedAt: "2026-09-20T10:00:00.000Z",
    ...overrides,
  };
}

function webHost(overrides: Partial<NookHost> = {}): NookHost {
  return {
    kind: "web",
    appVersion: "1.2.3",
    apiUrl: "https://nook.beyler.co",
    user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com", createdAt: "2024-01-01T00:00:00.000Z" },
    account: {
      updateProfile: vi.fn().mockResolvedValue(undefined),
      changePassword: vi.fn().mockResolvedValue(undefined),
      listSessions: vi.fn().mockResolvedValue([]),
      revokeSession: vi.fn().mockResolvedValue(undefined),
      revokeOtherSessions: vi.fn().mockResolvedValue(undefined),
      deleteAccount: vi.fn().mockResolvedValue(undefined),
      signOut: vi.fn().mockResolvedValue(undefined),
    },
    sync: { requestSync: vi.fn().mockResolvedValue(undefined) },
    extensionLink: { status: "connected", connect: vi.fn().mockResolvedValue(undefined) },
    ...overrides,
  };
}

function extensionHost(overrides: Partial<NookHost> = {}): NookHost {
  return {
    kind: "extension",
    appVersion: "1.2.3",
    apiUrl: "https://nook.beyler.co",
    user: null,
    sync: { requestSync: vi.fn().mockResolvedValue(undefined) },
    openWebApp: vi.fn(),
    ...overrides,
  };
}

function fakeLibrary(overrides: Partial<Parameters<typeof SettingsDialog>[0]["library"]> = {}) {
  return {
    bookmarkCount: 12,
    collectionCount: 3,
    isImporting: false,
    importBookmarks: vi.fn().mockResolvedValue(true),
    exportBookmarks: vi.fn(),
    clearAllBookmarks: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  cloudStatus = fakeStatus();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderDialog(host: NookHost, overrides: Partial<Parameters<typeof SettingsDialog>[0]> = {}) {
  const onOpenChange = vi.fn();
  const onAppearanceChange = vi.fn();
  const library = fakeLibrary();
  act(() => {
    root.render(
      <NookHostProvider host={host}>
        <ToastViewport>
          <SettingsDialog
            isOpen
            onOpenChange={onOpenChange}
            appearance="system"
            onAppearanceChange={onAppearanceChange}
            library={library}
            {...overrides}
          />
        </ToastViewport>
      </NookHostProvider>,
    );
  });
  return { onOpenChange, onAppearanceChange, library };
}

/** Every element the dialog could plausibly treat as clickable, matched by its visible text or aria-label. */
function clickText(text: string) {
  const candidates = [
    ...container.querySelectorAll<HTMLElement>("button, a, [role='radio'], [role='tab'], [role='menuitem'], [role='option']"),
  ];
  const match = candidates.find((el) => el.textContent?.trim() === text || el.getAttribute("aria-label") === text);
  if (!match) {
    throw new Error(`No clickable element for "${text}". Saw: ${candidates.map((el) => el.textContent?.trim()).join(" | ")}`);
  }
  act(() => match.click());
}

function hasText(text: string): boolean {
  return container.textContent?.includes(text) ?? false;
}

describe("NookHostProvider / useNookHost", () => {
  it("throws a clear error when used outside a provider", () => {
    function Probe() {
      useNookHost();
      return null;
    }
    expect(() => {
      act(() => {
        root.render(<Probe />);
      });
    }).toThrow(/NookHostProvider/);
  });
});

describe("SettingsDialog — web host", () => {
  it("shows all six sections and defaults to Profile", () => {
    renderDialog(webHost());
    for (const label of ["Profile", "Account & security", "Appearance", "Sync", "Data", "About"]) {
      expect(hasText(label)).toBe(true);
    }
    expect(hasText("Ada Lovelace")).toBe(true);
    expect(hasText("ada@example.com")).toBe(true);
  });

  it("picking a new appearance calls onAppearanceChange", () => {
    const { onAppearanceChange } = renderDialog(webHost());
    clickText("Appearance");
    clickText("Dark");
    expect(onAppearanceChange).toHaveBeenCalledWith("dark");
  });

  it("Sync now calls host.sync.requestSync", async () => {
    const host = webHost();
    renderDialog(host);
    clickText("Sync");
    await act(async () => {
      clickText("Sync now");
      await Promise.resolve();
    });
    expect(host.sync.requestSync).toHaveBeenCalledTimes(1);
  });

  it("Export as JSON calls library.exportBookmarks", () => {
    const { library } = renderDialog(webHost());
    clickText("Data");
    clickText("Export as JSON");
    expect(library.exportBookmarks).toHaveBeenCalledTimes(1);
  });
});

describe("SettingsDialog — extension, local-only (signed out)", () => {
  it("hides Profile and Account & security, and offers a sign-in card", () => {
    const host = extensionHost();
    renderDialog(host);
    expect(hasText("Profile")).toBe(false);
    expect(hasText("Account & security")).toBe(false);
    expect(hasText("Appearance")).toBe(true);
    expect(hasText("Sync")).toBe(true);

    clickText("Sync");
    expect(hasText("Sign in to sync across devices")).toBe(true);
    clickText("Sign in");
    expect(host.openWebApp).toHaveBeenCalledWith("/?connect=extension");
  });
});

describe("SettingsDialog — extension, signed in", () => {
  it("shows a read-only Profile and hides Account & security", () => {
    const host = extensionHost({
      user: { id: "u2", name: "Grace Hopper", email: "grace@example.com" },
    });
    renderDialog(host);
    expect(hasText("Profile")).toBe(true);
    expect(hasText("Account & security")).toBe(false);
    expect(hasText("Grace Hopper")).toBe(true);

    clickText("Manage account on the web");
    expect(host.openWebApp).toHaveBeenCalledWith("/");
  });
});

describe("SettingsDialog — About panel", () => {
  it("shows the version and tagline, and drops the raw server URL / host kind", () => {
    renderDialog(webHost());
    clickText("About");
    expect(hasText("Nook")).toBe(true);
    expect(hasText("Save what matters.")).toBe(true);
    expect(hasText("1.2.3")).toBe(true);
    expect(hasText("https://nook.beyler.co")).toBe(false);
    expect(hasText("Running as")).toBe(false);
    expect(hasText("Web app")).toBe(false);
  });
});

describe("SettingsDialog — Active sessions", () => {
  function sessionsHost(sessions: NookSessionInfo[]) {
    const host = webHost();
    host.account = { ...host.account!, listSessions: vi.fn().mockResolvedValue(sessions) };
    return host;
  }

  it("shows a friendly device title, hides private/docker IPs, and shows public ones", async () => {
    const host = sessionsHost([
      {
        token: "current-token",
        current: true,
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        ipAddress: "172.29.0.1",
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-25T09:00:00.000Z",
        expiresAt: "2026-10-01T10:00:00.000Z",
      },
      {
        token: "other-token",
        current: false,
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
        ipAddress: "8.8.8.8",
        createdAt: "2026-08-01T10:00:00.000Z",
        updatedAt: "2026-09-20T09:00:00.000Z",
        expiresAt: "2026-10-01T10:00:00.000Z",
      },
    ]);
    renderDialog(host);
    clickText("Account & security");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(hasText("Chrome on macOS")).toBe(true);
    expect(hasText("Safari on iOS")).toBe(true);
    expect(hasText("This device")).toBe(true);
    expect(hasText("172.29.0.1")).toBe(false);
    expect(hasText("8.8.8.8")).toBe(true);
    expect(container.querySelector('[aria-label=\'Sign out "Safari on iOS"\']')).not.toBeNull();
  });
});
