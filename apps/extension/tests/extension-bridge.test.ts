import { describe, expect, it, vi } from "vitest";
import { handleBridgeMessage, type ExtensionBridgeDeps } from "../lib/extension-bridge";
import type { CloudUserProfile } from "../lib/cloud-sync";

const API_URL = "https://nook.example.com";
const PROFILE: CloudUserProfile = { id: "user-1", name: "Ada Lovelace", email: "ada@example.com" };

function makeDeps(overrides: Partial<ExtensionBridgeDeps> = {}): ExtensionBridgeDeps {
  return {
    apiUrl: API_URL,
    version: "1.2.3",
    fetchSession: vi.fn(async () => PROFILE),
    currentSession: vi.fn(async () => null),
    saveSession: vi.fn(async () => {}),
    replaceAccount: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    startAlarm: vi.fn(async () => {}),
    stopAlarm: vi.fn(async () => {}),
    requestSync: vi.fn(async () => {}),
    status: vi.fn(async () => ({
      apiUrl: API_URL,
      signedIn: true,
      ownerId: PROFILE.id,
      pendingCount: 0,
      rejectedCount: 0,
      offline: false,
    })),
    ...overrides,
  };
}

describe("handleBridgeMessage — origin check", () => {
  it("rejects a message from any origin other than the configured web app", async () => {
    const deps = makeDeps();
    const result = await handleBridgeMessage({ type: "NOOK_BRIDGE_HELLO" }, "https://evil.example.com", deps);
    expect(result).toEqual({ ok: false, code: "WRONG_ORIGIN", error: expect.any(String) });
    expect(deps.status).not.toHaveBeenCalled();
  });

  it("rejects a missing sender origin", async () => {
    const deps = makeDeps();
    const result = await handleBridgeMessage({ type: "NOOK_BRIDGE_HELLO" }, undefined, deps);
    expect(result.ok).toBe(false);
  });
});

describe("handleBridgeMessage — HELLO", () => {
  it("answers with the current extension status", async () => {
    const deps = makeDeps({
      status: vi.fn(async () => ({
        apiUrl: API_URL,
        signedIn: false,
        pendingCount: 2,
        rejectedCount: 1,
        offline: true,
      })),
    });
    const result = await handleBridgeMessage({ type: "NOOK_BRIDGE_HELLO" }, API_URL, deps);
    expect(result).toEqual({
      ok: true,
      version: "1.2.3",
      apiUrl: API_URL,
      signedIn: false,
      ownerId: undefined,
      lastSyncedAt: undefined,
      pendingCount: 2,
      rejectedCount: 1,
      offline: true,
    });
  });
});

describe("handleBridgeMessage — CONNECT", () => {
  it("verifies the token, saves the session, starts the alarm and syncs", async () => {
    const deps = makeDeps();
    const result = await handleBridgeMessage(
      { type: "NOOK_BRIDGE_CONNECT", token: "tok", ownerId: PROFILE.id },
      API_URL,
      deps,
    );
    expect(deps.fetchSession).toHaveBeenCalledWith("tok");
    expect(deps.saveSession).toHaveBeenCalledWith("tok", PROFILE.id, PROFILE);
    expect(deps.replaceAccount).not.toHaveBeenCalled();
    expect(deps.startAlarm).toHaveBeenCalledTimes(1);
    expect(deps.requestSync).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("rejects an invalid token without touching the session", async () => {
    const deps = makeDeps({ fetchSession: vi.fn(async () => null) });
    const result = await handleBridgeMessage(
      { type: "NOOK_BRIDGE_CONNECT", token: "bad", ownerId: PROFILE.id },
      API_URL,
      deps,
    );
    expect(result).toEqual({ ok: false, code: "INVALID_TOKEN", error: expect.any(String) });
    expect(deps.saveSession).not.toHaveBeenCalled();
    expect(deps.startAlarm).not.toHaveBeenCalled();
  });

  it("rejects a token whose user id doesn't match the requested ownerId", async () => {
    const deps = makeDeps({ fetchSession: vi.fn(async () => ({ ...PROFILE, id: "someone-else" })) });
    const result = await handleBridgeMessage(
      { type: "NOOK_BRIDGE_CONNECT", token: "tok", ownerId: PROFILE.id },
      API_URL,
      deps,
    );
    expect(result).toEqual({ ok: false, code: "INVALID_TOKEN", error: expect.any(String) });
    expect(deps.saveSession).not.toHaveBeenCalled();
  });

  it("rejects a mismatched bound owner unless replaceExisting is set", async () => {
    const deps = makeDeps({ currentSession: vi.fn(async () => ({ token: "old", ownerId: "someone-else" })) });
    const result = await handleBridgeMessage(
      { type: "NOOK_BRIDGE_CONNECT", token: "tok", ownerId: PROFILE.id },
      API_URL,
      deps,
    );
    expect(result).toEqual({ ok: false, code: "OWNER_MISMATCH", error: expect.any(String) });
    expect(deps.replaceAccount).not.toHaveBeenCalled();
    expect(deps.saveSession).not.toHaveBeenCalled();
  });

  it("replaces the bound account first when replaceExisting is set", async () => {
    const deps = makeDeps({ currentSession: vi.fn(async () => ({ token: "old", ownerId: "someone-else" })) });
    const result = await handleBridgeMessage(
      { type: "NOOK_BRIDGE_CONNECT", token: "tok", ownerId: PROFILE.id, replaceExisting: true },
      API_URL,
      deps,
    );
    expect(deps.replaceAccount).toHaveBeenCalledTimes(1);
    expect(deps.saveSession).toHaveBeenCalledWith("tok", PROFILE.id, PROFILE);
    expect(result.ok).toBe(true);
  });

  it("reconnecting the same already-bound owner does not reset the account", async () => {
    const deps = makeDeps({ currentSession: vi.fn(async () => ({ token: "old", ownerId: PROFILE.id })) });
    const result = await handleBridgeMessage(
      { type: "NOOK_BRIDGE_CONNECT", token: "tok", ownerId: PROFILE.id },
      API_URL,
      deps,
    );
    expect(deps.replaceAccount).not.toHaveBeenCalled();
    expect(deps.saveSession).toHaveBeenCalledWith("tok", PROFILE.id, PROFILE);
    expect(result.ok).toBe(true);
  });

  it("reports an error result if saveSession itself rejects with an owner mismatch", async () => {
    const deps = makeDeps({ saveSession: vi.fn(async () => { throw new Error("owner mismatch"); }) });
    const result = await handleBridgeMessage(
      { type: "NOOK_BRIDGE_CONNECT", token: "tok", ownerId: PROFILE.id },
      API_URL,
      deps,
    );
    expect(result).toEqual({ ok: false, code: "OWNER_MISMATCH", error: "owner mismatch" });
    expect(deps.startAlarm).not.toHaveBeenCalled();
  });
});

describe("handleBridgeMessage — DISCONNECT", () => {
  it("clears the session and stops the alarm when the bound owner matches", async () => {
    const deps = makeDeps({ currentSession: vi.fn(async () => ({ token: "tok", ownerId: PROFILE.id })) });
    const result = await handleBridgeMessage({ type: "NOOK_BRIDGE_DISCONNECT", ownerId: PROFILE.id }, API_URL, deps);
    expect(deps.disconnect).toHaveBeenCalledTimes(1);
    expect(deps.stopAlarm).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("does nothing when the bound owner does not match", async () => {
    const deps = makeDeps({ currentSession: vi.fn(async () => ({ token: "tok", ownerId: "someone-else" })) });
    const result = await handleBridgeMessage({ type: "NOOK_BRIDGE_DISCONNECT", ownerId: PROFILE.id }, API_URL, deps);
    expect(deps.disconnect).not.toHaveBeenCalled();
    expect(deps.stopAlarm).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it("does nothing when no session is bound at all", async () => {
    const deps = makeDeps({ currentSession: vi.fn(async () => null) });
    const result = await handleBridgeMessage({ type: "NOOK_BRIDGE_DISCONNECT", ownerId: PROFILE.id }, API_URL, deps);
    expect(deps.disconnect).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });
});
