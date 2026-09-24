import { createAuthClient } from "better-auth/react";

/**
 * Single Better Auth client for the whole web app. Cookie-based sessions —
 * the browser sends the session cookie on every same-origin request, so the
 * client just needs its own origin as the base URL.
 */
export const authClient = createAuthClient({ baseURL: window.location.origin });

export type NookAuthClient = typeof authClient;

/** The subset of Better Auth's `user` shape every screen actually reads. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  image?: string | null;
  createdAt?: string | Date;
}
