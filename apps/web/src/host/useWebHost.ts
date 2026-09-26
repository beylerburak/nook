import { useMemo } from "react";
import type { NookHost, NookSessionInfo, NookUser } from "../../../extension/src/app/host/NookHost";
import { getActiveLocale, translate } from "../../../extension/src/i18n";
import packageJson from "../../package.json";
import { authClient } from "../auth/authClient";
import { navigate, type Route } from "../router";
import { useExtensionLink } from "./useExtensionLink";

const ORGANIZE_PATH = "/app/dashboard/organize";
const DASHBOARD_PATH = "/app/dashboard";

interface BetterFetchResult<T> {
  data: T | null;
  error: { message?: string } | null;
}

async function unwrap<T>(call: Promise<BetterFetchResult<T>>): Promise<T> {
  const { data, error } = await call;
  if (error) throw new Error(error.message || translate(getActiveLocale(), "web.auth.requestFailed"));
  return data as T;
}

function toIso(value: string | Date | undefined | null): string {
  if (!value) return new Date().toISOString();
  return typeof value === "string" ? value : value.toISOString();
}

interface RawSession {
  token: string;
  createdAt: string | Date;
  updatedAt?: string | Date | null;
  expiresAt: string | Date;
  userAgent?: string | null;
  ipAddress?: string | null;
}

function toSessionInfo(session: RawSession, currentToken: string | undefined): NookSessionInfo {
  return {
    token: session.token,
    current: session.token === currentToken,
    userAgent: session.userAgent ?? null,
    ipAddress: session.ipAddress ?? null,
    createdAt: toIso(session.createdAt),
    updatedAt: session.updatedAt ? toIso(session.updatedAt) : undefined,
    expiresAt: toIso(session.expiresAt),
  };
}

export interface UseWebHostParams {
  user: NookUser;
  /** Asks the running sync loop (lib/cloud-runner.ts) to sync now. */
  requestSync: () => Promise<void>;
  /** Full sign-out sequence (final sync, server sign-out, bridge disconnect, local wipe). */
  signOut: () => Promise<void>;
  /** Same local/bridge cleanup as signOut, but skipped the (now pointless) final sync + server sign-out — the account is already gone server-side. */
  cleanupAfterAccountDeleted: () => Promise<void>;
  /** The app's current route (App.tsx's own `useRoute()`) — read only to
   *  derive `navigation.isOrganizeOpen` below; this hook never reads the URL
   *  itself, so a test can hand in whatever `Route` it likes. */
  route: Route;
}

/** Builds the "web" NookHost (contract section 3) from the signed-in Better Auth session. */
export function useWebHost({ user, requestSync, signOut, cleanupAfterAccountDeleted, route }: UseWebHostParams): NookHost {
  const extensionLink = useExtensionLink(user.id);
  const isOrganizeOpen = route.pathname === ORGANIZE_PATH;

  return useMemo<NookHost>(
    () => ({
      kind: "web",
      appVersion: packageJson.version,
      apiUrl: window.location.origin,
      user,
      navigation: {
        isOrganizeOpen,
        onOrganizeOpenChange(open) {
          const target = open ? ORGANIZE_PATH : DASHBOARD_PATH;
          // Idempotent: DashboardApp.tsx calls this on every view selection,
          // not only ones that actually cross the organize/non-organize
          // line, so a no-op here is what keeps every other view switch
          // (e.g. "all" -> a tag) from pushing a pointless history entry.
          if (window.location.pathname !== target) navigate(target);
        },
      },
      account: {
        async updateProfile({ name }) {
          await unwrap(authClient.updateUser({ name }));
        },
        async changePassword({ currentPassword, newPassword, revokeOtherSessions }) {
          await unwrap(authClient.changePassword({ currentPassword, newPassword, revokeOtherSessions }));
        },
        async listSessions() {
          const [sessions, session] = await Promise.all([
            unwrap(authClient.listSessions()),
            authClient.getSession(),
          ]);
          const currentToken = session.data?.session?.token;
          return sessions.map((entry) => toSessionInfo(entry, currentToken));
        },
        async revokeSession(token) {
          await unwrap(authClient.revokeSession({ token }));
        },
        async revokeOtherSessions() {
          await unwrap(authClient.revokeOtherSessions());
        },
        async deleteAccount({ password }) {
          await unwrap(authClient.deleteUser({ password }));
          await cleanupAfterAccountDeleted();
        },
        signOut,
      },
      sync: { requestSync },
      extensionLink,
    }),
    [user, requestSync, signOut, cleanupAfterAccountDeleted, extensionLink, isOrganizeOpen],
  );
}
