import { useMemo } from "react";
import type { NookHost, NookSessionInfo, NookUser } from "../../../extension/src/app/host/NookHost";
import packageJson from "../../package.json";
import { authClient } from "../auth/authClient";
import { useExtensionLink } from "./useExtensionLink";

interface BetterFetchResult<T> {
  data: T | null;
  error: { message?: string } | null;
}

async function unwrap<T>(call: Promise<BetterFetchResult<T>>): Promise<T> {
  const { data, error } = await call;
  if (error) throw new Error(error.message || "The request failed.");
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
}

/** Builds the "web" NookHost (contract section 3) from the signed-in Better Auth session. */
export function useWebHost({ user, requestSync, signOut, cleanupAfterAccountDeleted }: UseWebHostParams): NookHost {
  const extensionLink = useExtensionLink(user.id);

  return useMemo<NookHost>(
    () => ({
      kind: "web",
      appVersion: packageJson.version,
      apiUrl: window.location.origin,
      user,
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
    [user, requestSync, signOut, cleanupAfterAccountDeleted, extensionLink],
  );
}
