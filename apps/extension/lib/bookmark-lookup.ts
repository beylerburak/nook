/**
 * Shared "is this URL already saved?" lookup, used by both the popup's
 * GET_ACTIVE_PAGE_STATE handler and the toolbar badge. X posts are looked up
 * by the `x:<statusId>` id the X content script's parseTweet() assigns
 * (see entrypoints/content/tweet-dom.ts) — a generic normalized-URL lookup
 * would miss them since the X content script, not this file, owns tweet ids.
 */

import * as NookDB from "./db";
import { xBookmarkIdForUrl } from "./url";
import type { Bookmark } from "./types";

export async function findBookmarkForUrl(url: string): Promise<Bookmark | null> {
  const xId = xBookmarkIdForUrl(url);
  if (xId) {
    const item = await NookDB.getBookmark(xId);
    return item && !item.deletedAt ? item : null;
  }
  return NookDB.findBookmarkByUrl(url);
}
