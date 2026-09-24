// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CloudStatus } from "../lib/cloud-sync";

let mockedStatus: CloudStatus | null = null;
vi.mock("../src/app/host/useCloudStatus", () => ({
  useCloudStatus: () => mockedStatus,
}));

// Imported after the mock so the component picks up the mocked hook.
import { SyncStatusIndicator, describeSyncStatus } from "../src/app/components/SyncStatusIndicator";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SYNCED: CloudStatus = {
  apiUrl: "https://nook.beyler.co",
  signedIn: true,
  offline: false,
  syncing: false,
  pendingCount: 0,
  rejected: [],
};

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderIndicator(status: CloudStatus | null, onOpenSync = vi.fn()) {
  mockedStatus = status;
  act(() => {
    root.render(<SyncStatusIndicator onOpenSync={onOpenSync} />);
  });
  return onOpenSync;
}

describe("describeSyncStatus", () => {
  it("is Local only when the status is unknown or signed out", () => {
    expect(describeSyncStatus(null).label).toBe("Local only");
    expect(describeSyncStatus({ ...SYNCED, signedIn: false }).label).toBe("Local only");
  });

  it("is Offline with the pending count when offline", () => {
    expect(describeSyncStatus({ ...SYNCED, offline: true, pendingCount: 3 }).label).toBe("Offline (3 waiting)");
    expect(describeSyncStatus({ ...SYNCED, offline: true, pendingCount: 0 }).label).toBe("Offline (0 waiting)");
  });

  it("is Syncing… (pulsing) while a run is in progress", () => {
    const info = describeSyncStatus({ ...SYNCED, syncing: true });
    expect(info.label).toBe("Syncing…");
    expect(info.isPulsing).toBe(true);
  });

  it("is Sync error on a last error or on rejected items", () => {
    expect(describeSyncStatus({ ...SYNCED, lastError: "Could not reach the server" }).label).toBe("Sync error");
    expect(
      describeSyncStatus({ ...SYNCED, rejected: [{ kind: "bookmark", id: "1", error: "too large" }] }).label,
    ).toBe("Sync error");
  });

  it("is Synced once signed in, online, idle, and error-free", () => {
    expect(describeSyncStatus(SYNCED).label).toBe("Synced");
  });

  it("prioritizes offline over a stale syncing flag", () => {
    expect(describeSyncStatus({ ...SYNCED, offline: true, syncing: true, pendingCount: 1 }).label).toBe(
      "Offline (1 waiting)",
    );
  });
});

describe("SyncStatusIndicator", () => {
  it("renders the label for every status", () => {
    renderIndicator(null);
    expect(container.textContent).toContain("Local only");

    renderIndicator({ ...SYNCED, offline: true, pendingCount: 2 });
    expect(container.textContent).toContain("Offline (2 waiting)");

    renderIndicator({ ...SYNCED, syncing: true });
    expect(container.textContent).toContain("Syncing…");

    renderIndicator({ ...SYNCED, lastError: "Could not reach the server" });
    expect(container.textContent).toContain("Sync error");

    renderIndicator(SYNCED);
    expect(container.textContent).toContain("Synced");
  });

  it("opens Settings at the sync section when clicked", () => {
    const onOpenSync = renderIndicator(SYNCED);
    act(() => {
      container.querySelector("button")!.click();
    });
    expect(onOpenSync).toHaveBeenCalledTimes(1);
  });
});
