import type { BridgeExtensionStatus, BridgeRequest, BridgeResponse } from "./bridge-protocol";
import type { CloudUserProfile } from "./cloud-sync";

/** The bits of CloudStatus the bridge reply needs — kept narrow so deps.status() is trivial to fake in tests. */
export interface BridgeStatusSnapshot {
  apiUrl: string;
  signedIn: boolean;
  ownerId?: string;
  lastSyncedAt?: string;
  pendingCount: number;
  rejectedCount: number;
  offline: boolean;
}

/**
 * Everything handleBridgeMessage needs from the outside world, injected so
 * the origin check plus HELLO/CONNECT/DISCONNECT logic is unit-testable
 * without chrome.* or a real network. entrypoints/background/index.ts wires
 * the real implementations (lib/cloud-sync.ts + chrome.alarms + syncCloud).
 */
export interface ExtensionBridgeDeps {
  /** This build's configured cloud API origin (cloudApiUrl()). */
  apiUrl: string;
  /** The extension's version (chrome.runtime.getManifest().version). */
  version: string;
  /** GET {apiUrl}/api/auth/get-session with `Authorization: Bearer <token>`; null on any failure. */
  fetchSession(token: string): Promise<CloudUserProfile | null>;
  /** The session currently bound on this device, if any (cloudSession()). */
  currentSession(): Promise<{ token: string; ownerId: string } | null>;
  /** Binds token + ownerId (+ cached profile) to this device (saveCloudSession()). */
  saveSession(token: string, ownerId: string, profile?: CloudUserProfile): Promise<void>;
  /** Clears the previously-bound account's token/owner/sync state before switching accounts (resetCloudSync()). */
  replaceAccount(): Promise<void>;
  /** Clears this device's token; owner + sync state are left alone so a later reconnect with the same owner stays incremental. */
  disconnect(): Promise<void>;
  startAlarm(): Promise<void>;
  stopAlarm(): Promise<void>;
  /** Kicks a sync. Errors are swallowed by the caller — the reply's status reflects the outcome either way. */
  requestSync(): Promise<unknown>;
  /** Current cloud status, used to build the BridgeExtensionStatus reply. */
  status(): Promise<BridgeStatusSnapshot>;
}

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

async function buildStatus(deps: ExtensionBridgeDeps): Promise<BridgeExtensionStatus> {
  const status = await deps.status();
  return {
    version: deps.version,
    apiUrl: status.apiUrl,
    signedIn: status.signedIn,
    ownerId: status.ownerId,
    lastSyncedAt: status.lastSyncedAt,
    pendingCount: status.pendingCount,
    rejectedCount: status.rejectedCount,
    offline: status.offline,
  };
}

function isBridgeRequest(value: unknown): value is BridgeRequest {
  return (
    Boolean(value) &&
    typeof (value as { type?: unknown }).type === "string" &&
    (value as { type: string }).type.startsWith("NOOK_BRIDGE_")
  );
}

/**
 * Handler for externally_connectable messages from the web app — see
 * lib/bridge-protocol.ts and the product contract's "Extension <-> web
 * bridge" section. Every effectful call goes through `deps`, so the origin
 * check, HELLO, CONNECT and DISCONNECT are all testable without chrome.* or
 * a real network. The caller (background/index.ts) is responsible for
 * routing calls through the serial cloud task queue.
 */
export async function handleBridgeMessage(
  request: unknown,
  senderOrigin: string | undefined,
  deps: ExtensionBridgeDeps,
): Promise<BridgeResponse> {
  const expectedOrigin = originOf(deps.apiUrl);
  if (senderOrigin !== expectedOrigin) {
    return {
      ok: false,
      code: "WRONG_ORIGIN",
      error: `This page (${senderOrigin ?? "unknown origin"}) is not the configured Nook web app (${expectedOrigin}).`,
    };
  }
  if (!isBridgeRequest(request)) {
    return { ok: false, code: "ERROR", error: "Unrecognized bridge message." };
  }

  try {
    if (request.type === "NOOK_BRIDGE_HELLO") {
      return { ok: true, ...(await buildStatus(deps)) };
    }

    if (request.type === "NOOK_BRIDGE_CONNECT") {
      const profile = await deps.fetchSession(request.token);
      if (!profile || profile.id !== request.ownerId) {
        return { ok: false, code: "INVALID_TOKEN", error: "Could not verify this session with the server." };
      }

      const existing = await deps.currentSession();
      if (existing && existing.ownerId !== request.ownerId) {
        if (!request.replaceExisting) {
          return {
            ok: false,
            code: "OWNER_MISMATCH",
            error: "This browser's Nook library is linked to a different account.",
          };
        }
        // Local library stays; it uploads to the new account on the sync below.
        await deps.replaceAccount();
      }

      try {
        await deps.saveSession(request.token, request.ownerId, profile);
      } catch (error) {
        // Safety net for a race against another CONNECT — saveSession
        // (saveCloudSession) itself throws OwnerMismatchError in this case.
        return {
          ok: false,
          code: "OWNER_MISMATCH",
          error: error instanceof Error ? error.message : String(error),
        };
      }

      await deps.startAlarm();
      await deps.requestSync().catch(() => {});
      return { ok: true, ...(await buildStatus(deps)) };
    }

    if (request.type === "NOOK_BRIDGE_DISCONNECT") {
      const existing = await deps.currentSession();
      if (existing && existing.ownerId === request.ownerId) {
        await deps.disconnect();
        await deps.stopAlarm();
      }
      return { ok: true, ...(await buildStatus(deps)) };
    }

    return { ok: false, code: "ERROR", error: "Unrecognized bridge message." };
  } catch (error) {
    return { ok: false, code: "ERROR", error: error instanceof Error ? error.message : String(error) };
  }
}

/** Real GET {apiUrl}/api/auth/get-session — Better Auth's bearer plugin accepts the raw session token. */
export async function fetchBridgeSessionProfile(apiUrl: string, token: string): Promise<CloudUserProfile | null> {
  try {
    const response = await fetch(`${apiUrl}/api/auth/get-session`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { user?: CloudUserProfile } | null;
    if (!body?.user?.id) return null;
    return body.user;
  } catch {
    return null;
  }
}
