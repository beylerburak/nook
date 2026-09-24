/**
 * The one generic (non-X) "save this page" path, used by every entry point:
 * chrome.bookmarks.onCreated, the context menu, the keyboard shortcut and
 * the popup's SAVE_ACTIVE_PAGE. Each caller only needs to say which tab (if
 * any) to pull live metadata from and which tab (if any) to toast in — the
 * capture, dedupe-by-URL, persist, toast and badge steps are identical.
 */

import * as NookDB from "../../lib/db";
import { buildPageBookmarkItem, extractPageMetadataInTab, fetchPageMetadata, mergeCapturedContent, type PageMetadata } from "../../lib/page-capture";
import { sendBookmarkToast } from "../../lib/toast";
import type { Bookmark, Media } from "../../lib/types";
import { classifyUnsavableUrl } from "./page-access";
import { refreshBadgeForTab } from "./badge";

export interface SavePageOptions {
  url: string;
  /** Pull live metadata from this open tab — must actually be showing `url` (skip for a link/image target that isn't open). */
  metadataTabId?: number;
  /** Tab to show the "Saved ✓" toast in and refresh the badge for, if any. */
  toastTabId?: number;
  /** Id/source for a brand-new bookmark; ignored when a matching URL is already saved. */
  id?: string;
  source?: string;
  fallbackTitle?: string;
  favIconUrl?: string;
  tags?: string[];
  createdAt?: string;
  /** Overrides the derived media (e.g. "Save image to Nook" pins the right-clicked image). */
  mediaOverride?: Media[];
}

export interface SavePageResult {
  bookmark: Bookmark;
  isNew: boolean;
}

async function capturePageMetadata(url: string, metadataTabId?: number): Promise<PageMetadata | null> {
  if (metadataTabId !== undefined) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: metadataTabId },
        func: extractPageMetadataInTab,
      });
      const metadata = results?.[0]?.result as PageMetadata | null | undefined;
      if (metadata) return metadata;
    } catch {
      // Restricted page or the tab closed mid-flight — fall back to fetching it.
    }
  }
  return fetchPageMetadata(url).catch(() => null);
}

/** Saves (or refreshes) a generic web page bookmark. The single path every non-X entry point goes through. */
export async function savePage(options: SavePageOptions): Promise<SavePageResult> {
  const metadata = await capturePageMetadata(options.url, options.metadataTabId);
  // Dedupe is by normalized URL inside the lookup; the stored URL stays exactly as saved.
  const existing = await NookDB.findBookmarkByUrl(options.url, { includeDeleted: true });

  const item = buildPageBookmarkItem({
    id: existing?.id ?? options.id ?? `web:${crypto.randomUUID()}`,
    source: existing?.source ?? options.source ?? "web",
    url: options.url,
    metadata,
    fallbackTitle: options.fallbackTitle,
    favIconUrl: options.favIconUrl,
    tags: options.tags,
    createdAt: existing?.createdAt ?? options.createdAt,
    mediaOverride: options.mediaOverride,
  });

  const bookmark = existing
    ? await NookDB.putBookmark(mergeCapturedContent(existing, item))
    : await NookDB.putBookmark(item);

  if (options.toastTabId !== undefined) {
    const siteName = bookmark.creator?.name || bookmark.title;
    const toastMessage =
      bookmark.media && bookmark.media.length > 0
        ? `Nook: Saved "${siteName}" with image ✓`
        : `Nook: Saved "${siteName}" to bookmarks ✓`;
    sendBookmarkToast(options.toastTabId, {
      type: "SHOW_BOOKMARK_TOAST",
      message: toastMessage,
      bookmarkId: bookmark.id,
    }).catch(() => {});
    refreshBadgeForTab(options.toastTabId, options.url).catch(() => {});
  }

  return { bookmark, isNew: !existing || Boolean(existing.deletedAt) };
}

/** Context menu / keyboard shortcut: save the page currently open in `tab`. */
export async function saveCurrentTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || !tab.url) return;
  if (await classifyUnsavableUrl(tab.url)) return;
  await savePage({
    url: tab.url,
    metadataTabId: tab.id,
    toastTabId: tab.id,
    fallbackTitle: tab.title,
    favIconUrl: tab.favIconUrl,
  });
}

/** Context menu: "Save link to Nook" — the link's page isn't open, so metadata is always fetched. */
export async function saveLinkTarget(linkUrl: string, toastTab: chrome.tabs.Tab): Promise<void> {
  if (toastTab.id === undefined) return;
  if (await classifyUnsavableUrl(linkUrl)) return;
  await savePage({ url: linkUrl, toastTabId: toastTab.id });
}

/** Context menu: "Save image to Nook" — bookmarks the page the image is on, with that image as its media. */
export async function saveImageTarget(imageUrl: string, tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined || !tab.url) return;
  if (await classifyUnsavableUrl(tab.url)) return;
  await savePage({
    url: tab.url,
    metadataTabId: tab.id,
    toastTabId: tab.id,
    fallbackTitle: tab.title,
    favIconUrl: tab.favIconUrl,
    mediaOverride: [{ type: "image", url: imageUrl, alt: tab.title || "" }],
  });
}
