/**
 * English messages for the `settings` namespace (settings dialog and every panel except AI).
 * Composed into the catalog by ../en.ts — see docs/i18n.md.
 */
export const settings = {
  appearance: {
    themeSectionTitle: "Theme",
    appearanceRowTitle: "Appearance",
    appearanceRowDescription: "Match your system, or pick light or dark.",
    modeLight: "Light",
    modeDark: "Dark",

    languageSectionTitle: "Language",
    languageRowTitle: "Language",
    languageRowDescription: "Choose the language Nook displays in.",
    // Each language is named in itself, in every locale, so a user who can't
    // read the current language can still find their own.
    languageEnglish: "English",
    languageTurkish: "Türkçe",
  },

  // The Settings dialog's side nav / tab strip — one label+description pair
  // per section in SETTINGS_SECTIONS (settings-shared.tsx).
  sections: {
    profile: { label: "Profile", description: "Your name, photo and account basics." },
    account: { label: "Account & security", description: "Password, sessions and account deletion." },
    appearance: { label: "Appearance", description: "Choose how Nook looks on this device." },
    sync: { label: "Sync", description: "Cloud sync status and the browser extension link." },
    ai: { label: "AI", description: "Organize, summarise and search your library with AI." },
    data: { label: "Data", description: "Import, export and clear your library." },
    about: { label: "About", description: "Version and app information." },
  },

  dialog: {
    title: "Settings",
    sectionsLabel: "Settings sections",
  },

  account: {
    passwordSectionTitle: "Password",
    currentPasswordLabel: "Current password",
    newPasswordLabel: "New password",
    newPasswordHint: "At least 8 characters.",
    confirmPasswordLabel: "Confirm new password",
    passwordMismatch: "Passwords don't match.",

    signOutOtherSessions: "Sign out other sessions",
    signOutOtherSessionsHint: "Everywhere else you're signed in.",
    signOutOtherSessionsConfirmTitle: "Sign out other sessions?",
    signOutOtherSessionsConfirmDescription: "Every other device signed in to your account will be signed out.",
    otherSessionsSignedOutToast: "Other sessions signed out.",
    otherSessionsSignOutError: "Could not sign out other sessions.",

    updatePasswordButton: "Update password",
    passwordUpdatedToast: "Password updated.",
    passwordUpdateError: "Could not update your password. Check your current password.",

    activeSessionsTitle: "Active sessions",
    loadSessionsError: "Could not load active sessions.",
    loadingSessions: "Loading sessions…",
    noSessionsFound: "No sessions found.",
    activeLabel: "Active",
    signedInLabel: "Signed in",
    thisDeviceLabel: "This device",

    signOut: "Sign out",
    signOutOfNookDescription: "Sign out of Nook on this device.",
    signOutConfirmTitle: "Sign out?",
    signOutAnyway: "Sign out anyway",
    signOutError: "Could not sign out.",
    unsyncedChangesWarning: {
      one: "You have 1 change that hasn't synced yet. Signing out now may lose it on this device.",
      other: "You have {count} changes that haven't synced yet. Signing out now may lose them on this device.",
    },

    signOutSessionAria: 'Sign out "{title}"',
    signOutSessionConfirmTitle: "Sign out this session?",
    signOutSessionConfirmDescription: 'This will sign "{title}" out of your account.',
    sessionSignedOutToast: "Session signed out.",
    sessionSignOutError: "Could not sign out that session.",

    dangerZoneTitle: "Danger zone",
    deleteAccount: "Delete account",
    deleteAccountDescription: "Permanently deletes your account and everything synced to it.",
    deleteAccountConfirmTitle: "Delete your account?",
    deleteAccountConfirmSubtitle: "This can't be undone. Enter your password to confirm.",
    passwordLabel: "Password",
    deleteAccountError: "Could not delete your account. Check your password.",
  },

  sync: {
    stateSynced: "Synced",
    stateSyncing: "Syncing…",
    stateOffline: "Offline",
    stateError: "Sync error",
    stateLocal: "Local only",

    signInBannerTitle: "Sign in to sync across devices",
    signInBannerDescription: "Connect Nook to your account from the web app to sync your library everywhere.",
    signIn: "Sign in",

    checkingStatus: "Checking sync status…",
    pendingChangesDescription: {
      one: "1 change waiting to sync.",
      other: "{count} changes waiting to sync.",
    },

    statusSectionTitle: "Status",
    syncNow: "Sync now",
    lastSyncedLabel: "Last synced",
    never: "Never",
    pendingChangesLabel: "Pending changes",
    syncRequestedToast: "Sync requested.",
    syncRequestError: "Could not start a sync.",

    rejectedSectionTitle: "Couldn't upload",
    untitledItem: "Untitled",

    extensionSectionTitle: "Browser extension",
    extensionChecking: "Checking…",
    extensionNotInstalled: "Not installed",
    extensionNotInstalledDescription: "Install the Nook browser extension to save from any page.",
    extensionConnected: "Connected",
    extensionSignedOut: "Signed out",
    extensionSignedOutDescription: "The browser extension is installed but not connected to this account.",
    extensionOtherAccount: "Different account",
    extensionOtherAccountDescription: "The browser extension is connected to a different account.",
    extensionUnavailable: "Unavailable",
    extensionUnavailableDescription: "Extension status isn't available right now.",
    connect: "Connect",
    extensionConnectedToast: "Browser extension connected.",
    extensionConnectError: "Could not connect the browser extension.",
  },

  data: {
    libraryTitle: "Library",
    bookmarksLabel: "Bookmarks",
    collectionsLabel: "Collections",

    importExportTitle: "Import & export",
    importLabel: "Import bookmarks",
    importDescription: "A Nook JSON export.",
    exportButton: "Export as JSON",
    importedToast: "Bookmarks imported.",
    importError: "Could not import that file.",
    exportedToast: "Bookmarks exported.",

    dangerZoneTitle: "Danger zone",
    clearAllTitle: "Clear all bookmarks",
    clearAllDescription: "Moves every saved item to the deleted state. Collections stay.",
    clearAllButton: "Clear all",
    clearAllConfirmTitle: "Clear all bookmarks?",
    clearAllConfirmDescription: "Saved items will be moved to the deleted state. Collections will remain.",
    clearedToast: "Bookmarks cleared.",
    clearError: "Could not clear your library.",
  },

  profile: {
    basicsTitle: "Basics",
    nameLabel: "Name",
    nameShownDescription: "Shown across Nook.",
    emailLabel: "Email",
    emailReadOnlyDescription: "Read-only.",
    updatedToast: "Profile updated.",
    updateError: "Could not update your profile.",
    detailsTitle: "Details",
    memberSinceLabel: "Member since",
    manageOnWeb: "Manage account on the web",
  },

  about: {
    tagline: "Save what matters.",
    versionLabel: "Version",
  },

  // Non-React helpers in describe-session.ts — passed a `locale` and call
  // `translate()` directly (see docs/i18n.md, "Non-React usage").
  sessions: {
    unknownDevice: "Unknown device",
    unknownBrowserOn: "Unknown browser on {os}",
    deviceOn: "{browser} on {os}",
  },
} as const;
