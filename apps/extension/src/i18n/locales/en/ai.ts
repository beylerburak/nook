/**
 * English messages for the `ai` namespace (Settings → AI panel).
 * Composed into the catalog by ../en.ts — see docs/i18n.md.
 *
 * Sub-namespaced by section of the panel (see
 * `apps/extension/src/app/settings-dialog/AiPanel.tsx` and the files beside it
 * under `settings-dialog/ai/`): `intro`, `organize`, `suggest`, `autoFile`,
 * `summaries`, `search`, `advanced`, `signIn`, plus shared `errors` and
 * `status` (dot labels) reused across more than one of those.
 */
export const ai = {
  loadingSettings: "Loading AI settings…",

  intro: {
    text: "Nook can sort your bookmarks into collections, summarise long pages and search by meaning. It runs on Nook's server, even when your browser is closed.",
    refresh: "Refresh",
    unavailableTitle: "AI isn't set up on this server yet",
    unavailableDescription: "These features can't run until it is.",
  },

  signIn: {
    title: "Sign in to use AI features",
    description: "These features run on Nook's server, so they need your account.",
    button: "Sign in",
  },

  organize: {
    title: "Organize your library",
    step1Label: "Create collections",
    step1Description: "Nook suggests collections and tags from your unfiled bookmarks.",
    step2Label: "File bookmarks automatically",
    step2Description: "Files bookmarks into the collections and tags above.",
  },

  suggest: {
    button: "Suggest collections",
    buttonTooltip: "Nook looks at your unfiled bookmarks and suggests names for them.",
    signedOutTooltip: "Sign in to ask for suggestions.",
    reading: "Reading your library",
    readingBody: "Looking through your library…",
    newCollections: "New collections",
    newTags: "New tags",
    newTagsDescription: "New bookmarks can start using these tags once Nook is confident about them.",
    alreadyCovered: "A collection above already covers this.",

    notAskedYet: "You haven't asked for suggestions yet.",
    acceptedNoneActive: "You've accepted suggestions before, but none are active now.",
    acceptedSummary: "You've accepted {parts} so far.",

    sampleRead: {
      one: "Nook looked at {count} bookmark.",
      other: "Nook looked at {count} bookmarks.",
    },
    reviewHintNoExisting: "Untick anything you don't want.",
    reviewHintExisting: "You already have {names} — matching names are left as they are.",

    collectionsCount: { one: "{count} collection", other: "{count} collections" },
    tagsCount: { one: "{count} tag", other: "{count} tags" },
    and: "and",
    addLabel: "Add {parts}",
    addedToast: "{parts} added.",
    nothingAdded: "Nothing was added — you already had all of it.",
    keptExisting: {
      one: "{count} already existed and was left alone.",
      other: "{count} already existed and were left alone.",
    },
    collectionsAreReal: "You can rename or delete these anytime.",

    nothingNew: "Nothing new to suggest right now.",
    nothingToRead: "Nothing unfiled to look at yet. Save a few bookmarks and try again.",
  },

  autoFile: {
    description: "Works through your whole library, not just new bookmarks — anything it isn't sure about stays as you saved it.",
    organizeButton: "Organize unfiled bookmarks now",
    tooltipNeitherOn: "Turn on filing or summaries first.",
    tooltipBusy: "Nook's server is starting this now.",
    tooltipOn: "Starts right away with up to 25 bookmarks; the rest follow within a few minutes.",
    nothingToOrganize: "Nothing to organize right now.",
    working: {
      one: "Working on {count} bookmark…",
      other: "Working on {count} bookmarks…",
    },
    filedResult: "Filed {assigned}, left {skipped} alone because Nook wasn't sure.",
    neverRun: "Nook hasn't organized anything yet.",
    startedToast: "Now working on {parts}.",
    bookmarksToOrganize: { one: "{count} bookmark to organize", other: "{count} bookmarks to organize" },
    pagesToSummarise: { one: "{count} page to summarise", other: "{count} pages to summarise" },
  },

  summaries: {
    title: "Summaries",
    switchLabel: "Summarise long pages",
    description: "Writes a short summary for long pages, in their own language.",
    privacyTrigger: "What gets sent",
    privacyNote:
      "This sends up to 4,000 characters of the page, plus its title and note, to Nook's AI provider (OpenAI or Google). Filing and suggestions only send titles and short previews.",
    countsRowTitle: "In your library",
    counts: {
      one: "{count} page has a summary, {pending} waiting.",
      other: "{count} pages have a summary, {pending} waiting.",
    },
    off: "Nothing is summarised while this is off.",
    unknown: "—",
    lastRunLabel: "Last run:",
  },

  search: {
    title: "Search",
    rowTitle: "Search by meaning",
    description: "Works automatically once you're signed in, if Nook's server supports it.",
  },

  advanced: {
    trigger: "Advanced",
    collectionLabel: "Collection confidence",
    collectionDescription: "Higher means fewer, more accurate matches.",
    tagLabel: "Tag confidence",
    tagDescription: "Same idea, for tags.",
    maxTagsLabel: "Max tags",
    maxTagsDescription: "Most tags a bookmark can get.",
    languageLabel: "Language for new names",
    languageDescription: "Which language new collections and tags are written in.",
    languageAuto: "Match my library",
    reset: "Reset to defaults",
  },

  // Shared across more than one section — a fact worth saying the same way
  // everywhere it applies, rather than once per row it happens to touch.
  errors: {
    notAvailable: "Not available on this server yet.",
    signedOut: "Your session has expired. Sign in again.",
    throttled: "Nook's server is busy. Try again in a minute.",
    failed: "Something went wrong.",
    couldNotStart: "Could not start this.",
    couldNotSaveSettings: "Could not save your settings.",
    couldNotAccept: "Could not create those collections or tags.",
    couldNotAsk: "Could not look at your library for suggestions.",
  },

  // StatusDot accessible labels — short state words, reused wherever a dot
  // needs one rather than each row inventing its own.
  status: {
    failed: "Failed",
    unavailable: "Not available",
    done: "Done",
    nothingToDo: "Nothing to do",
    working: "Working",
  },
} as const;
