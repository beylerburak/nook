import type { ContentToBackgroundMessage, MessageResponse } from "../../lib/types";

export type SendNookMessage = (message: ContentToBackgroundMessage) => Promise<MessageResponse>;

/** False once the extension has been reloaded/updated and this content script is orphaned. */
export function isExtensionValid(): boolean {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
}

export function sendNookMessage(message: ContentToBackgroundMessage): Promise<MessageResponse> {
  return chrome.runtime.sendMessage(message);
}
