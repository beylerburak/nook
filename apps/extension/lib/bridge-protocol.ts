/**
 * Shared wire contract for the extension <-> web app bridge
 * (chrome.runtime.sendMessage(NOOK_EXTENSION_ID, ...) / externally_connectable).
 * Verbatim per the product contract (Extension <-> web bridge, §2) — the web
 * app imports these same types, so this file must not diverge from them
 * without updating both sides.
 */

export const NOOK_EXTENSION_ID = "gldaimigcbcmgadpknjhpnhopfiedgno";

export type BridgeRequest =
  | { type: "NOOK_BRIDGE_HELLO" }
  | { type: "NOOK_BRIDGE_CONNECT"; token: string; ownerId: string; replaceExisting?: boolean }
  | { type: "NOOK_BRIDGE_DISCONNECT"; ownerId: string };

export interface BridgeExtensionStatus {
  version: string;
  apiUrl: string;
  signedIn: boolean;
  ownerId?: string;
  lastSyncedAt?: string;
  pendingCount: number;
  rejectedCount: number;
  offline: boolean;
}

export type BridgeResponse =
  | ({ ok: true } & BridgeExtensionStatus)
  | { ok: false; code: "WRONG_ORIGIN" | "INVALID_TOKEN" | "OWNER_MISMATCH" | "ERROR"; error: string };
