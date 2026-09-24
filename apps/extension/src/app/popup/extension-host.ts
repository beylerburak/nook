/**
 * Builds the extension's NookHost (see src/app/host/NookHost.tsx) — the
 * object the dashboard entry wraps DashboardApp in via NookHostProvider.
 * Lives next to dashboardLinks.ts (rather than under entrypoints/dashboard)
 * so the popup can reach the same small chrome.* helpers without reaching
 * into another surface's entrypoint folder.
 */
import type { NookHost } from "../host/NookHost";
import { cloudApiUrl, type CloudUserProfile } from "../../../lib/cloud-sync";
import type { MessageResponse, PopupToBackgroundMessage } from "../../../lib/types";

/**
 * Wraps chrome.runtime.sendMessage in a promise, treating both ways a
 * background handler can fail to answer (chrome.runtime.lastError, or a
 * response that never arrives) as an ordinary rejection.
 */
function sendToBackground(message: PopupToBackgroundMessage): Promise<MessageResponse> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response: MessageResponse) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || "Nook's background service did not respond."));
          return;
        }
        if (response === undefined) {
          reject(new Error("Nook's background service did not respond."));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function requestSync(): Promise<void> {
  const response = await sendToBackground({ type: "SYNC_CLOUD_NOW" });
  if (!response.success) throw new Error(response.error || "Sync failed");
}

/** Opens `path` (default the web app root) in a new tab against the configured cloud API origin. */
export function openWebApp(path = "/"): void {
  const base = cloudApiUrl().replace(/\/$/, "");
  const url = path.startsWith("http") ? path : `${base}${path.startsWith("/") ? "" : "/"}${path}`;
  chrome.tabs.create({ url }).catch((error) => {
    console.error("[Nook] Failed to open the web app:", error);
  });
}

/** Builds the extension's NookHost. `user` is the cached cloud profile (null when signed out). */
export function createExtensionHost(user: CloudUserProfile | null): NookHost {
  return {
    kind: "extension",
    appVersion: chrome.runtime.getManifest().version,
    apiUrl: cloudApiUrl(),
    user,
    sync: { requestSync },
    openWebApp,
  };
}
