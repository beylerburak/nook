/**
 * Web-side client for the extension <-> web bridge (contract section 2,
 * `apps/extension/lib/bridge-protocol.ts`, owned by W4). The extension
 * declares `externally_connectable` for this origin and listens on
 * `chrome.runtime.onMessageExternal`; we talk to it the same way any other
 * web page would talk to an installed extension: `chrome.runtime.sendMessage`
 * with an explicit extension id.
 */
import { NOOK_EXTENSION_ID, type BridgeRequest, type BridgeResponse } from "../../../extension/lib/bridge-protocol";
import type { ExtensionLinkStatus } from "../../../extension/src/app/host/NookHost";
import type { NookAuthClient } from "../auth/authClient";

// Overridable per build so a dev build can point at an unpacked/dev extension
// id instead of the published one baked into bridge-protocol.ts.
const EXTENSION_ID = (import.meta.env.VITE_NOOK_EXTENSION_ID as string | undefined) || NOOK_EXTENSION_ID;

function runtime(): typeof chrome.runtime | undefined {
  return typeof chrome !== "undefined" ? chrome.runtime : undefined;
}

/** Rejects with a generic error whenever the extension isn't installed/reachable — callers treat any rejection as "not-installed". */
function sendToExtension(request: BridgeRequest): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const rt = runtime();
    if (!rt?.sendMessage) {
      reject(new Error("Nook extension not installed"));
      return;
    }
    try {
      rt.sendMessage(EXTENSION_ID, request, (response?: BridgeResponse) => {
        // A missing extension (or one that hasn't allowlisted this origin)
        // surfaces as chrome.runtime.lastError ("Could not establish
        // connection...") rather than a thrown exception.
        if (rt.lastError || !response) {
          reject(new Error(rt.lastError?.message || "Nook extension not reachable"));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function probeExtensionLink(currentUserId: string | undefined): Promise<{ status: ExtensionLinkStatus }> {
  try {
    const response = await sendToExtension({ type: "NOOK_BRIDGE_HELLO" });
    if (!response.ok) return { status: "unavailable" };
    if (!response.signedIn) return { status: "signed-out" };
    if (currentUserId && response.ownerId && response.ownerId !== currentUserId) return { status: "other-account" };
    return { status: "connected" };
  } catch {
    return { status: "not-installed" };
  }
}

/** Sends the current session token to the extension so it can bind to this account. Throws with a user-facing message on failure. */
export async function connectExtension(authClient: NookAuthClient, options?: { replaceExisting?: boolean }): Promise<void> {
  const { data } = await authClient.getSession();
  const token = data?.session?.token;
  const ownerId = data?.user?.id;
  if (!token || !ownerId) throw new Error("Sign in before connecting the extension.");
  const response = await sendToExtension({
    type: "NOOK_BRIDGE_CONNECT",
    token,
    ownerId,
    replaceExisting: options?.replaceExisting,
  });
  if (!response.ok) {
    throw new Error(
      response.code === "OWNER_MISMATCH"
        ? "The extension is signed in to a different Nook account."
        : response.error || "Could not connect the extension.",
    );
  }
}

/** Best-effort: tells the extension to forget this session. Never throws — the extension may not be installed. */
export async function disconnectExtension(ownerId: string): Promise<void> {
  try {
    await sendToExtension({ type: "NOOK_BRIDGE_DISCONNECT", ownerId });
  } catch {
    // Not installed, or already signed out there — nothing to clean up.
  }
}
