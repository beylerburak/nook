/**
 * Builds the extension's NookHost (see src/app/host/NookHost.tsx) — the
 * object the dashboard entry wraps DashboardApp in via NookHostProvider.
 * Lives next to dashboardLinks.ts (rather than under entrypoints/dashboard)
 * so the popup can reach the same small chrome.* helpers without reaching
 * into another surface's entrypoint folder.
 */
import type { NookHost } from "../host/NookHost";
import { getActiveLocale, translate } from "../../i18n";
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
        const notRespondingMessage = translate(getActiveLocale(), "extension.errors.backgroundNotResponding");
        if (lastError) {
          reject(new Error(lastError.message || notRespondingMessage));
          return;
        }
        if (response === undefined) {
          reject(new Error(notRespondingMessage));
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
  if (!response.success) throw new Error(response.error || translate(getActiveLocale(), "extension.errors.syncFailed"));
}

/**
 * Maps a caller-supplied, web-app-root-relative path (e.g. "/" or
 * "/?connect=extension" — see UserMenu.tsx/ProfilePanel.tsx/AiPanel.tsx/
 * SyncPanel.tsx) onto the app's /app subtree (docs/cloud.md's URL layout:
 * the product lives at /app/*, "/" is a static landing page that can't
 * handle any of this). "/app" itself redirects client-side to /app/login or
 * /app/dashboard as appropriate, so every caller here can keep asking for
 * the bare root — this just relocates that root under /app while preserving
 * whatever query string it carried (e.g. "/?connect=extension" ->
 * "/app?connect=extension", never "/app/?connect=extension").
 */
function resolveAppPath(path: string): string {
  if (path.startsWith("http") || path.startsWith("/app")) return path;
  if (path.startsWith("/?")) return `/app${path.slice(1)}`;
  if (path.startsWith("/")) return `/app${path}`;
  return `/app/${path}`;
}

/** Opens `path` (default the web app root) in a new tab against the configured cloud API origin. */
export function openWebApp(path = "/"): void {
  const base = cloudApiUrl().replace(/\/$/, "");
  const appPath = resolveAppPath(path);
  const url = appPath.startsWith("http") ? appPath : `${base}${appPath}`;
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
