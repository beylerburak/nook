import { createContext, useContext, type ReactNode } from "react";

/**
 * The host context: everything a shared UI surface (the Settings dialog, the
 * dashboard shell) needs to talk to whichever app it's running inside —
 * the extension's own pages, or the web app — without knowing which one it
 * is. See `product-contract.md` section 3 for the full shape agreed across
 * agents; W2 (web) and W4 (extension) each provide a `NookHost` value.
 */

export interface NookUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  createdAt?: string;
}

export interface NookSessionInfo {
  token: string;
  current: boolean;
  userAgent?: string | null;
  ipAddress?: string | null;
  createdAt: string;
  expiresAt: string;
  /** Better Auth's session `updatedAt` — last activity. Falls back to `createdAt` when absent. */
  updatedAt?: string;
}

/**
 * The extension's link to the signed-in web account, as seen from the web
 * app (Settings → Sync shows this so a signed-in web user can connect the
 * browser extension without leaving the page).
 */
export type ExtensionLinkStatus =
  | "checking"
  | "not-installed"
  | "connected"
  | "signed-out"
  | "other-account"
  | "unavailable";

export interface NookHost {
  kind: "web" | "extension";
  appVersion: string;
  apiUrl: string;
  /** Extension: cached profile when signed in, null in local-only mode. */
  user: NookUser | null;
  /** Web only — account management backed by Better Auth. */
  account?: {
    updateProfile(input: { name: string }): Promise<void>;
    changePassword(input: {
      currentPassword: string;
      newPassword: string;
      revokeOtherSessions: boolean;
    }): Promise<void>;
    listSessions(): Promise<NookSessionInfo[]>;
    revokeSession(token: string): Promise<void>;
    revokeOtherSessions(): Promise<void>;
    deleteAccount(input: { password: string }): Promise<void>;
    /** Host handles the final sync, the bridge DISCONNECT, and the local wipe. */
    signOut(): Promise<void>;
  };
  sync: { requestSync(): Promise<void> };
  /** Web only — the browser extension's connection to this account. */
  extensionLink?: {
    status: ExtensionLinkStatus;
    connect(options?: { replaceExisting?: boolean }): Promise<void>;
  };
  /** Extension only, e.g. `openWebApp("/?connect=extension")` to sign in. */
  openWebApp?(path?: string): void;
  /**
   * Web only — lets the Organize page (dashboard/organize/OrganizePage.tsx)
   * keep the URL in step with the dashboard's view state, so a direct link to
   * `/app/dashboard/organize`, a browser back/forward, and picking "Organize"
   * from the side nav all agree with each other. `isOrganizeOpen` reflects
   * the current URL and changes identity (via the host's own memo) whenever
   * the route does, so a component that reads it in a `useEffect` dependency
   * list re-syncs on back/forward without polling. The extension has no
   * notion of a URL for this — its dashboard keeps the same view in plain
   * React state and never sets this field, which is deliberate: don't build
   * other dashboard routes off this hook, it exists only for Organize.
   */
  navigation?: {
    isOrganizeOpen: boolean;
    onOrganizeOpenChange(open: boolean): void;
  };
}

const NookHostContext = createContext<NookHost | null>(null);

export function NookHostProvider({ host, children }: { host: NookHost; children: ReactNode }) {
  return <NookHostContext.Provider value={host}>{children}</NookHostContext.Provider>;
}

export function useNookHost(): NookHost {
  const host = useContext(NookHostContext);
  if (!host) throw new Error("useNookHost must be used within a NookHostProvider");
  return host;
}
