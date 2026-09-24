// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudStatus } from "../lib/cloud-sync";

interface FakeNookHost {
  kind: "web" | "extension";
  appVersion: string;
  apiUrl: string;
  user: { id: string; name: string; email: string } | null;
  account?: { signOut: () => Promise<void> };
  sync: { requestSync: () => Promise<void> };
  openWebApp?: (path?: string) => void;
}

let mockedHost: FakeNookHost;
let mockedStatus: CloudStatus | null;

vi.mock("../src/app/host/NookHost", () => ({
  useNookHost: () => mockedHost,
}));
vi.mock("../src/app/host/useCloudStatus", () => ({
  useCloudStatus: () => mockedStatus,
}));

// Imported after the mocks so the component picks up the mocked hooks.
import { UserMenu } from "../src/app/components/UserMenu";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  mockedStatus = null;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderMenu(host: FakeNookHost, onOpenProfile = vi.fn(), onOpenSettings = vi.fn()) {
  mockedHost = host;
  act(() => {
    root.render(<UserMenu onOpenProfile={onOpenProfile} onOpenSettings={onOpenSettings} />);
  });
  return { onOpenProfile, onOpenSettings };
}

function openMenu() {
  act(() => {
    container.querySelector("button")!.click();
  });
}

function menuItem(label: string): HTMLElement {
  const match = [...document.body.querySelectorAll('[role="menuitem"]')].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!match) throw new Error(`No "${label}" menu item. Body: ${document.body.textContent}`);
  return match as HTMLElement;
}

function hasMenuItem(label: string): boolean {
  return [...document.body.querySelectorAll('[role="menuitem"]')].some(
    (el) => el.textContent?.trim() === label,
  );
}

const webHost = (overrides: Partial<FakeNookHost> = {}): FakeNookHost => ({
  kind: "web",
  appVersion: "1.0.0",
  apiUrl: "https://nook.beyler.co",
  user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" },
  account: { signOut: vi.fn().mockResolvedValue(undefined) },
  sync: { requestSync: vi.fn().mockResolvedValue(undefined) },
  ...overrides,
});

const extensionHost = (overrides: Partial<FakeNookHost> = {}): FakeNookHost => ({
  kind: "extension",
  appVersion: "1.0.0",
  apiUrl: "https://nook.beyler.co",
  user: null,
  sync: { requestSync: vi.fn().mockResolvedValue(undefined) },
  openWebApp: vi.fn(),
  ...overrides,
});

describe("UserMenu — web", () => {
  it("shows the name/email header, Profile, Settings, and Sign out", () => {
    renderMenu(webHost());
    openMenu();
    expect(document.body.textContent).toContain("Ada Lovelace");
    expect(document.body.textContent).toContain("ada@example.com");
    expect(hasMenuItem("Profile")).toBe(true);
    expect(hasMenuItem("Settings")).toBe(true);
    expect(hasMenuItem("Sign out")).toBe(true);
    expect(hasMenuItem("Open web app")).toBe(false);
    expect(hasMenuItem("Sign in to sync")).toBe(false);
  });

  it("calls onOpenProfile / onOpenSettings from their items", () => {
    const { onOpenProfile, onOpenSettings } = renderMenu(webHost());
    openMenu();
    act(() => menuItem("Profile").click());
    expect(onOpenProfile).toHaveBeenCalledTimes(1);

    openMenu();
    act(() => menuItem("Settings").click());
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("signs out immediately when nothing is pending", () => {
    const host = webHost();
    mockedStatus = { apiUrl: "x", signedIn: true, offline: false, syncing: false, pendingCount: 0, rejected: [] };
    renderMenu(host);
    openMenu();
    act(() => menuItem("Sign out").click());
    expect(host.account!.signOut).toHaveBeenCalledTimes(1);
  });

  it("confirms before signing out when changes are still pending", () => {
    const host = webHost();
    mockedStatus = { apiUrl: "x", signedIn: true, offline: false, syncing: false, pendingCount: 2, rejected: [] };
    renderMenu(host);
    openMenu();
    act(() => menuItem("Sign out").click());
    // Not signed out yet — an AlertDialog should be asking for confirmation.
    expect(host.account!.signOut).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/pending|sync/i);

    const confirmButton = [...document.body.querySelectorAll("button")].find(
      (el) => el.textContent?.trim() === "Sign out",
    )!;
    act(() => confirmButton.click());
    expect(host.account!.signOut).toHaveBeenCalledTimes(1);
  });
});

describe("UserMenu — extension, signed out (local-only)", () => {
  it("shows Profile, Settings, and Sign in to sync, with no header", () => {
    renderMenu(extensionHost());
    openMenu();
    expect(hasMenuItem("Profile")).toBe(true);
    expect(hasMenuItem("Settings")).toBe(true);
    expect(hasMenuItem("Sign in to sync")).toBe(true);
    expect(hasMenuItem("Open web app")).toBe(false);
    expect(hasMenuItem("Sign out")).toBe(false);
  });

  it("opens the web app's connect flow", () => {
    const host = extensionHost();
    renderMenu(host);
    openMenu();
    act(() => menuItem("Sign in to sync").click());
    expect(host.openWebApp).toHaveBeenCalledWith("/?connect=extension");
  });
});

describe("UserMenu — extension, signed in", () => {
  it("shows the name/email header, Profile, Settings, and Open web app", () => {
    renderMenu(extensionHost({ user: { id: "u1", name: "Grace Hopper", email: "grace@example.com" } }));
    openMenu();
    expect(document.body.textContent).toContain("Grace Hopper");
    expect(hasMenuItem("Open web app")).toBe(true);
    expect(hasMenuItem("Sign in to sync")).toBe(false);
    expect(hasMenuItem("Sign out")).toBe(false);
  });

  it("links out to the web app root", () => {
    const host = extensionHost({ user: { id: "u1", name: "Grace Hopper", email: "grace@example.com" } });
    renderMenu(host);
    openMenu();
    act(() => menuItem("Open web app").click());
    expect(host.openWebApp).toHaveBeenCalledWith("/");
  });
});
