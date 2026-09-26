/**
 * English messages for the `extension` namespace (content scripts, background, lib/ user-facing messages).
 * Composed into the catalog by ../en.ts — see docs/i18n.md.
 */
export const extension = {
  meta: {
    dashboardTitle: "Nook — Your quiet corner of the web",
  },
  contextMenu: {
    savePage: "Save page to Nook",
    saveLink: "Save link to Nook",
    saveImage: "Save image to Nook",
  },
  toast: {
    pageSavedWithImage: 'Nook: Saved "{site}" with image ✓',
    pageSavedToBookmarks: 'Nook: Saved "{site}" to bookmarks ✓',
    tweetSaved: "Saved to Nook ✓",
    bookmarkSavedWithMedia: { one: "Nook: Saved with {count} media ✓", other: "Nook: Saved with {count} media ✓" },
    bookmarkSaved: "Nook: Saved to bookmarks ✓",
  },
  xButton: {
    save: "Save to Nook",
    saved: "Saved to Nook",
    removed: "Removed from Nook",
    toggleFailed: "Could not update Nook bookmark",
    extensionUpdated: "Nook was updated. Please refresh the page (F5) 🔄",
  },
  media: {
    videoThumbnail: "Video thumbnail",
    linkPreview: "Link preview",
  },
  sync: {
    title: "🔄 Nook Sync",
    fetchingAll: "Fetching all your bookmarks…",
    starting: "Starting…",
    fetchingQueryId: "Fetching query ID…",
    fetchingPage: "Fetching page {page}… ({count} new)",
    pageProgress: "Page {page} — {newCount} new, {updatedCount} updated",
    newBookmarksAdded: { one: "{count} new bookmark added to Nook.", other: "{count} new bookmarks added to Nook." },
    bookmarksUpdated: {
      one: "{count} bookmark updated (quotes / media).",
      other: "{count} bookmarks updated (quotes / media).",
    },
    syncedCount: { one: "Nook: {count} bookmark synced ✓", other: "Nook: {count} bookmarks synced ✓" },
    done: "Done",
    closingTab: "Closing tab…",
    error: "Error",
    csrfMissing: "CSRF token (ct0) not found. Are you logged in to X?",
    queryIdMissing:
      "Could not find the X Bookmarks API query ID. Please open x.com/i/bookmarks manually first, then try again.",
  },
  errors: {
    backgroundNotResponding: "Nook's background service did not respond.",
    syncFailed: "Sync failed",
    noActiveTab: "No active tab to save",
    pageNotSavable: "This page can't be saved",
    invalidItem: "Invalid item",
  },
} as const;
