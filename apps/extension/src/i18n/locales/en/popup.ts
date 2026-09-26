/**
 * English messages for the `popup` namespace (extension popup).
 * Composed into the catalog by ../en.ts — see docs/i18n.md.
 */
export const popup = {
  header: {
    moreOptions: "More options",
    appearance: "Appearance",
    openDashboard: "Open dashboard",
  },
  page: {
    unsavableTitle: "Can't save this page",
    restrictedMessage: "Nook can't save browser-internal pages.",
    noPageMessage: "No page is open in this tab.",
    loadError: "Could not load this page.",
    retry: "Retry",
    saveButton: "Save to Nook",
    saveWithShortcut: "Save to Nook ({shortcut})",
    savedBadge: "Saved",
    savedToNook: "Saved to Nook",
    openInNook: "Open in Nook",
    remove: "Remove",
    savedAsPostHint: "Saved as a post, like the Nook button on X.",
  },
  footer: {
    searchLabel: "Search your Nook",
    searchPlaceholder: "Search your Nook…",
    syncButton: "Sync X bookmarks",
    openDashboard: "Open dashboard",
    saveShortcutHint: "Save: {shortcut}",
  },
  organize: {
    title: "Organize",
    noteLabel: "Personal note",
    notePlaceholder: "Add a note…",
    addTagLabel: "Add a tag",
    addTagPlaceholder: "Add a tag…",
    addTagButton: "Add tag",
    collectionLabel: "Collection",
    unorganized: "Unorganized",
  },
  sync: {
    notSignedIn: "Not signed in",
    syncing: "Syncing…",
    offlineWaiting: { one: "Offline · {count} waiting", other: "Offline · {count} waiting" },
    error: "Sync error",
    synced: "Synced",
    signInButton: "Sign in to sync",
  },
  errors: {
    openLinkFailed: "Could not open this link.",
    saveFailed: "Could not save this page.",
    removeFailed: "Could not remove this bookmark.",
    syncStartFailed: "Could not start syncing.",
    readError: "Could not read this page.",
    saveChangesFailed: "Could not save changes.",
  },
  toast: {
    removed: "Removed from Nook.",
    undo: "Undo",
  },
} as const;
