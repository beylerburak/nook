/**
 * English messages for the `dashboard` namespace (dashboard, shared components, data table).
 * Composed into the catalog by ../en.ts — see docs/i18n.md.
 */
export const dashboard = {
  /** Demo/reference key (see docs/i18n.md) — also the "N saved items" line with no active search query. */
  itemCount: {
    one: "{count} saved item",
    other: "{count} saved items",
  },

  /** Shared view names — reused by the side nav, the page heading and any "Unorganized" option elsewhere. */
  views: {
    all: "All bookmarks",
    x: "X bookmarks",
    web: "Web pages",
    unorganized: "Unorganized",
    collectionFallback: "Collection",
  },

  topNav: {
    ariaLabel: "Nook primary navigation",
    subheading: "Your visual library",
  },

  sideNav: {
    ariaLabel: "Library navigation",
    libraryTitle: "Library",
    collectionsTitle: "Collections",
    createCollection: "Create collection",
    noCollections: "Create a collection to organize saved items.",
    deleteCollection: "Delete {name}",
    tagsTitle: "Tags",
    noTags: "Tags you add will appear here.",
  },

  toolbar: {
    ariaLabel: "Bookmark search and view",
    bookmarkViewLabel: "Bookmark view",
  },

  search: {
    label: "Search bookmarks",
    placeholder: "Search bookmarks, @authors, #tags…",
    semanticLabel: "Semantic",
    semanticDetail: "Ranked by meaning, not just by matching words.",
    keywordLabel: "Keyword match",
    signedOutDetail: "Sign in to search your library by meaning as well as by word.",
    offlineDetail: "You're offline — searching what is saved on this device.",
    unsearchableDetail: "Nothing else in your library matches, by word or by meaning.",
    countWithQuery: {
      one: "{count} saved item matching “{query}”",
      other: "{count} saved items matching “{query}”",
    },
    countWithQueryTotal: {
      one: "{shown} of {total} saved item matching “{query}”",
      other: "{shown} of {total} saved items matching “{query}”",
    },
  },

  viewMode: {
    cards: "Cards",
    table: "Table",
  },

  mediaFilter: {
    all: "All",
    media: "With media",
    text: "Text only",
    notesOnly: "With notes",
  },

  sort: {
    ariaLabel: "Sort bookmarks",
    newest: "Newest first",
    oldest: "Oldest first",
  },

  states: {
    loading: "Loading your library…",
  },

  badge: {
    saved: "{count} saved",
  },

  pagination: {
    cardPages: "Bookmark card pages",
    tablePages: "Bookmark table pages",
  },

  lightbox: {
    savedMediaAlt: "Saved media",
  },

  emptyState: {
    libraryReadyTitle: "Your library is ready",
    libraryReadyDescription: "Save a post on X or a web page. Nook keeps it here for later.",
    noResultsForQuery: "No results for “{query}”",
    noMatchingBookmarks: "No matching bookmarks",
    stillLookingDescription: "Nothing matches by word — still looking by meaning.",
    nothingMatchesDescription: "Nothing in your library matches, by word or by meaning.",
    tryAnotherSearchDescription: "Try another search or clear the current filter.",
    showAllBookmarks: "Show all bookmarks",
  },

  viewOptions: {
    label: "View options",
    columns: {
      title: "Columns",
      displayed: "Displayed columns",
      available: "Available columns",
      restore: "Restore",
      selectAll: "Select all",
      emptyDisplayed: "No columns are displayed.",
      emptyAvailable: "All columns are displayed.",
      required: "This column is required",
      reorder: "Reorder {column}",
      reorderHint: "Use the up and down arrow keys or drag to reorder.",
      remove: "Remove {column}",
      add: "Add {column}",
    },
    density: "Density",
    densityOptions: {
      compact: "Compact",
      balanced: "Comfortable",
      spacious: "Spacious",
    },
    sticky: "Sticky columns",
    stickyStart: "Pin from start",
    stickyEnd: "Pin from end",
    stickyNone: "None",
    stickyOne: "One column",
    stickyTwo: "Two columns",
    grouping: "Group by",
    groupingNone: "No grouping",
  },

  /** Short bits of copy identical across more than one dashboard surface. */
  shared: {
    quotedPost: "Quoted post",
    delete: "Delete",
    saveNote: "Save note",
  },

  card: {
    /** Prefixes accessible text with a "Video" hint (see MediaThumbnail's withVideoHint). */
    videoHint: "Video — {text}",
    unknownAuthor: "Unknown author",
    yourNote: "Your note",
    openQuotedPost: "Open quoted post",
    quotedPostMedia: "Quoted post media {index}",
    mediaPreview: "{type} preview {index}",
    openSource: "Open source",
    details: "Details",
    copy: "Copy",
  },

  detail: {
    closeDetails: "Close details",
    mediaAlt: "{title} media {index}",
    mediaLabel: "Media {index}",
    personalNoteLabel: "Personal note",
    notePlaceholder: "Add a thought or reminder…",
    addTagLabel: "Add a tag",
    tagPlaceholder: "e.g. inspiration",
    addTag: "Add tag",
    removeTag: "Remove #{tag}",
    suggestedTags: "Suggested tags",
    collectionLabel: "Collection",
    openPage: "Open page",
    openOnX: "Open on X",
    copyUrl: "Copy URL",
    panelLabel: "{title} details",
    webBookmarkFallback: "Web bookmark",
    xPostFallback: "X post",
  },

  dialogs: {
    createCollectionTitle: "Create a collection",
    createCollectionSubtitle: "Keep related bookmarks together.",
    collectionNameLabel: "Collection name",
    collectionNamePlaceholder: "e.g. Design references",
    collectionIconLabel: "Collection icon",
    createCollection: "Create collection",
    deleteCollectionTitle: "Delete {name}?",
    deleteCollectionFallbackName: "collection",
    deleteCollectionSubtitle: "Bookmarks in this collection will become unorganized.",
    deleteCollection: "Delete collection",
  },

  toast: {
    noteSaved: "Note saved.",
    couldNotOpenLink: "Could not open this link.",
    copiedToClipboard: "Copied to clipboard.",
    couldNotCopyToClipboard: "Could not copy to clipboard.",
    urlCopied: "URL copied.",
    couldNotCopyUrl: "Could not copy the URL.",
    bookmarksExported: "Bookmarks exported.",
    couldNotLoadBookmarks: "Could not load bookmarks.",
    importedCount: {
      one: "Imported {count} bookmark.",
      other: "Imported {count} bookmarks.",
    },
    couldNotImportFile: "Could not import this JSON file.",
    couldNotSaveChanges: "Could not save changes.",
    bookmarkDeleted: "Bookmark deleted.",
    couldNotDeleteBookmark: "Could not delete this bookmark.",
    collectionCreated: "Collection created.",
    couldNotCreateCollection: "Could not create this collection.",
    collectionDeleted: "Collection deleted.",
    couldNotDeleteCollection: "Could not delete this collection.",
    bookmarksCleared: "Bookmarks cleared.",
    couldNotClearBookmarks: "Could not clear bookmarks.",
  },

  savedToast: {
    addANote: "Add a note",
    noteLabel: "Note",
    notePlaceholder: "What do you want to remember?",
    noteSaved: "Note saved",
    couldNotSaveNote: "Could not save this note.",
  },

  syncStatus: {
    localOnly: "Local only",
    localOnlyDetail: "Sign in from the web app to sync your library across devices.",
    offline: "Offline ({count} waiting)",
    offlineDetailPending: {
      one: "{count} change will sync once you're back online.",
      other: "{count} changes will sync once you're back online.",
    },
    offlineDetailNone: "You're offline. Changes will sync once you're back online.",
    syncing: "Syncing…",
    syncingDetail: "Syncing your library now.",
    syncError: "Sync error",
    syncErrorDetail: {
      one: "{count} item could not be synced.",
      other: "{count} items could not be synced.",
    },
    synced: "Synced",
    syncedDetailWithDate: "Last synced {date}.",
    syncedDetailDefault: "Your library is up to date.",
  },

  userMenu: {
    accountFallback: "Account",
    profile: "Profile",
    settings: "Settings",
    signOut: "Sign out",
    openWebApp: "Open web app",
    signInToSync: "Sign in to sync",
    signOutConfirmTitle: "Sign out with unsynced changes?",
    signOutConfirmDescription: {
      one: "{count} change hasn't finished syncing yet. Signing out now may leave it unsynced.",
      other: "{count} changes haven't finished syncing yet. Signing out now may leave them unsynced.",
    },
  },

  appearanceMenu: {
    label: "Appearance",
    light: "Light",
    dark: "Dark",
  },

  table: {
    ariaLabel: "Saved bookmarks",
    bookmarkHeader: "Bookmark",
    sourceHeader: "Source",
    savedHeader: "Saved",
    collectionHeader: "Collection",
    tagsHeader: "Tags",
    noteHeader: "Note",
    actionsHeader: "Actions",
    sourceWeb: "Web",
    open: "Open",
    empty: "No bookmarks to show.",
  },

  canvasEditor: {
    resizeHandleLabel: "Resize bookmark details panel",
    defaultInspectorLabel: "Bookmark details",
  },
} as const;
