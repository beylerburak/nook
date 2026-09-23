import type { SendNookMessage } from "./messaging";

export type Notify = (message: string, bookmarkId?: string, toastType?: "info" | "error") => void;

/**
 * Asks the background page to render a toast. Failures are swallowed (with a
 * console warning) since a missed notification shouldn't break the save/sync
 * flow that triggered it.
 */
export function showNotification(
  sendMessage: SendNookMessage,
  message: string,
  bookmarkId?: string,
  toastType: "info" | "error" = "info"
): void {
  try {
    void sendMessage({ type: "SHOW_BOOKMARK_TOAST", message, bookmarkId, toastType }).catch((error) => {
      console.warn("[Nook] Could not show notification:", error);
    });
  } catch (error) {
    console.warn("[Nook] Could not show notification:", error);
  }
}
