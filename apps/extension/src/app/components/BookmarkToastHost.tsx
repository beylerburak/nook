import { useEffect, useState } from "react";
import { Theme, type ThemeMode } from "@astryxdesign/core/theme";
import { ToastViewport, useToast } from "@astryxdesign/core/Toast";
import { nookTheme } from "../theme/nook.js";
import type { MessageResponse, ShowBookmarkToastMessage } from "../../../lib/types";
import { notifyBookmarkToastReady, type BookmarkToastAck } from "../../../lib/toast";
import { detectSiteColorScheme, watchSiteColorScheme, type SiteColorScheme } from "../../../lib/site-color-scheme";
import { BookmarkSavedToast } from "./BookmarkSavedToast";
import { useAppearance } from "./useAppearance";

function isBookmarkToastMessage(message: unknown): message is ShowBookmarkToastMessage {
  return Boolean(
    message &&
    typeof message === "object" &&
    "type" in message &&
    message.type === "SHOW_BOOKMARK_TOAST" &&
    "message" in message &&
    typeof message.message === "string",
  );
}

async function saveBookmarkNote(id: string, note: string) {
  const response = (await chrome.runtime.sendMessage({
    type: "UPDATE_BOOKMARK_NOTE",
    id,
    note,
  })) as MessageResponse | undefined;

  if (!response?.success) {
    throw new Error(response?.error || "Could not save this note.");
  }
}

function BookmarkToastListener() {
  const showToast = useToast();

  useEffect(() => {
    const onMessage = (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (ack: BookmarkToastAck) => void) => {
      if (!isBookmarkToastMessage(message)) return;

      const bookmarkId = message.bookmarkId;
      const type = message.toastType || "info";
      showToast({
        body: message.message,
        type,
        // Saved-bookmark pills run their own timer (it must hold while a note is being written).
        isAutoHide: !bookmarkId && type !== "error",
        autoHideDuration: 4000,
        uniqueID: bookmarkId ? `saved-bookmark:${bookmarkId}` : undefined,
        collisionBehavior: "overwrite",
        renderContent: bookmarkId
          ? ({ dismiss }) => (
              <BookmarkSavedToast
                message={message.message}
                onSaveNote={(note) => saveBookmarkNote(bookmarkId, note)}
                onDismiss={dismiss}
              />
            )
          : undefined,
      });
      sendResponse({ toastShown: true });
    };

    chrome.runtime.onMessage.addListener(onMessage);
    // Only now is SHOW_BOOKMARK_TOAST actually handled, so signal readiness here
    // rather than right after ui.mount() (React registers this effect later).
    notifyBookmarkToastReady();
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [showToast]);

  return null;
}

function useSiteColorScheme(): SiteColorScheme | null {
  const [scheme, setScheme] = useState(() => detectSiteColorScheme());
  useEffect(() => watchSiteColorScheme(setScheme), []);
  return scheme;
}

interface BookmarkToastAppProps {
  initialAppearance: ThemeMode;
}

type ColorScheme = "light" | "dark";

function osColorScheme(): ColorScheme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function BookmarkToastApp({ initialAppearance }: BookmarkToastAppProps) {
  const appearance = useAppearance(initialAppearance);
  const siteScheme = useSiteColorScheme();
  // "System" blends in with the page the toast sits on; if the page's colors
  // can't be read, fall back to the OS setting.
  const mode: ColorScheme = appearance.mode === "system" ? siteScheme ?? osColorScheme() : appearance.mode;
  return (
    <Theme theme={nookTheme} mode={mode}>
      <ToastViewport position="bottomEnd">
        <BookmarkToastListener />
      </ToastViewport>
    </Theme>
  );
}
