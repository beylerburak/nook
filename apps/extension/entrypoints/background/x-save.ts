/**
 * Saving an X post from outside X's own action bar (i.e. from the popup).
 * Delegates parsing to the X content script via PARSE_FOCAL_TWEET so the
 * saved record is the exact same `x:<statusId>` bookmark the in-page Nook
 * button on that tweet uses — never a second, duplicate record.
 */

import * as NookDB from "../../lib/db";
import { sendBookmarkToast } from "../../lib/toast";
import type { BackgroundToContentMessage, Bookmark, ParseFocalTweetResponse } from "../../lib/types";
import { refreshBadgeForTab } from "./badge";

const FOCAL_TWEET_TIMEOUT_MS = 2000;

/** Asks the X content script to parse the focal tweet on the status page open in `tabId`. Null if it doesn't answer in time (not an X tab, or not done loading yet). */
export async function requestFocalTweet(tabId: number): Promise<ParseFocalTweetResponse | null> {
  const message: BackgroundToContentMessage = { type: "PARSE_FOCAL_TWEET" };
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, message) as Promise<ParseFocalTweetResponse>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("PARSE_FOCAL_TWEET timed out")), FOCAL_TWEET_TIMEOUT_MS)
      ),
    ]);
    return response ?? null;
  } catch {
    return null;
  }
}

/**
 * Saves the focal tweet on the status page open in `tabId`. Returns null
 * (without saving anything) when the content script couldn't parse it, so
 * the caller can fall back to generic page capture instead.
 */
export async function saveXPostFromTab(tabId: number): Promise<Bookmark | null> {
  const parsed = await requestFocalTweet(tabId);
  if (!parsed?.success || !parsed.item) return null;

  const bookmark = await NookDB.saveOrRestoreBookmark(parsed.item);

  sendBookmarkToast(tabId, {
    type: "SHOW_BOOKMARK_TOAST",
    message: "Saved to Nook ✓",
    bookmarkId: bookmark.id,
  }).catch(() => {});
  refreshBadgeForTab(tabId, bookmark.url ?? undefined).catch(() => {});

  // Lets the tweet's own in-page Nook button (entrypoints/content/nook-button.ts)
  // pick up the state change made from the popup.
  const stateMessage: BackgroundToContentMessage = {
    type: "NOOK_BOOKMARK_STATE_CHANGED",
    id: bookmark.id,
    saved: true,
  };
  chrome.tabs.sendMessage(tabId, stateMessage).catch(() => {});

  return bookmark;
}
