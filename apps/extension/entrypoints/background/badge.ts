/**
 * Toolbar badge reflecting whether the active tab's current page is saved
 * in Nook. Per-tab (chrome.action.setBadgeText accepts a tabId), so Chrome
 * shows the right badge automatically as the user switches tabs — we only
 * need to (re)compute it on tab activation/navigation and after a
 * save/remove. Same green used for the old post-save flash.
 */

import { findBookmarkForUrl } from "../../lib/bookmark-lookup";
import { isFileUrl, isRestrictedUrl } from "../../lib/page-capture";

export const SAVED_BADGE_COLOR = "#10b981";
const SAVED_BADGE_TEXT = "✓";

// Guards against a slow lookup for a tab the user has since navigated away
// from (or closed) clobbering a newer, faster one for the same tabId.
let requestSeq = 0;
const latestSeqByTab = new Map<number, number>();

async function isUrlSaved(url: string | undefined): Promise<boolean> {
  if (!url) return false;

  if (isFileUrl(url)) {
    const allowed = await chrome.extension.isAllowedFileSchemeAccess().catch(() => false);
    if (!allowed) return false;
  } else if (isRestrictedUrl(url)) {
    return false;
  }

  const bookmark = await findBookmarkForUrl(url).catch(() => null);
  return Boolean(bookmark);
}

export async function refreshBadgeForTab(tabId: number, url: string | undefined): Promise<void> {
  const seq = ++requestSeq;
  latestSeqByTab.set(tabId, seq);

  const saved = await isUrlSaved(url);
  if (latestSeqByTab.get(tabId) !== seq) return; // A newer refresh for this tab has since started.

  await chrome.action.setBadgeText({ tabId, text: saved ? SAVED_BADGE_TEXT : "" }).catch(() => {});
  if (saved) {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: SAVED_BADGE_COLOR }).catch(() => {});
  }
}

export async function refreshBadgeForActiveTab(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [] as chrome.tabs.Tab[]);
  if (tab?.id !== undefined) await refreshBadgeForTab(tab.id, tab.url);
}
