import { useCallback, useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Center } from "@astryxdesign/core/Center";
import { Section } from "@astryxdesign/core/Section";
import { Text } from "@astryxdesign/core/Text";
import { Theme } from "@astryxdesign/core/theme";
import { DashboardApp } from "../../extension/src/app/dashboard/DashboardApp";
import { NookHostProvider, type NookUser } from "../../extension/src/app/host/NookHost";
import { useI18n } from "../../extension/src/i18n";
import {
  bindCloudAccount,
  configureCloud,
  subscribeCloudStatus,
  unbindCloudAccount,
  type CloudStatus,
  type CloudUserProfile,
} from "../../extension/lib/cloud-sync";
import { startAutoSync, type AutoSyncHandle } from "../../extension/lib/cloud-runner";
import { nookTheme } from "../../extension/src/app/theme/nook.js";
import "../../extension/src/app/styles.css";
import { AuthScreen } from "./auth/AuthScreen";
import { authClient, type AuthUser } from "./auth/authClient";
import { disconnectExtension } from "./host/extensionBridge";
import { useWebHost } from "./host/useWebHost";
import { navigate, useRoute } from "./router";

// Must run before any other cloud/NookDB call anywhere in the app —
// module-level, so it executes on import, ahead of React rendering.
configureCloud({ apiUrl: window.location.origin, auth: "cookie" });

const CACHED_USER_KEY = "nook.web.cachedUser";

function readCachedUser(): CloudUserProfile | null {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CloudUserProfile;
    return parsed && typeof parsed.id === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function writeCachedUser(profile: CloudUserProfile | null): void {
  try {
    if (profile) localStorage.setItem(CACHED_USER_KEY, JSON.stringify(profile));
    else localStorage.removeItem(CACHED_USER_KEY);
  } catch {
    // Storage unavailable (private mode, quota) — offline boot just won't
    // have a cached account next time; the rest of the app still works.
  }
}

function toProfile(user: AuthUser): CloudUserProfile {
  return { id: user.id, name: user.name, email: user.email, image: user.image ?? null };
}

function toNookUser(user: AuthUser): NookUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    image: user.image ?? null,
    createdAt: user.createdAt ? (typeof user.createdAt === "string" ? user.createdAt : user.createdAt.toISOString()) : undefined,
  };
}

/**
 * A session fetch that failed for a network reason (vs. a genuine "not
 * signed in"). Better Auth's client (better-fetch, no `catchAllError`)
 * *throws* on a real network error (fetch rejecting, e.g. offline/DNS/CORS) —
 * that's caught around the `getSession()` call below, not here. What lands
 * here is the *returned* `{ data, error }` shape: a plain "no session" reply
 * is `{ data: null, error: null }` (not a network failure — must fall
 * through to the sign-in screen), while a gateway/proxy failure can still
 * surface as a real HTTP response with no usable status or a 5xx/502-style
 * status (the origin server is unreachable, not "signed out").
 */
function isNetworkFailure(error: { status?: number } | null): boolean {
  if (!navigator.onLine) return true;
  if (!error) return false;
  return error.status === undefined || error.status === 0 || error.status >= 500;
}

type BootState =
  | { kind: "loading" }
  | { kind: "signed-out" }
  | { kind: "signed-in"; user: NookUser };

type RouteResolution =
  | { kind: "redirect"; to: string }
  | { kind: "login" }
  | { kind: "dashboard" };

/**
 * The whole /app/* route table (URL layout note in docs/cloud.md):
 *   /app             -> /app/dashboard (signed in) or /app/login (signed out)
 *   /app/login       -> AuthScreen; if already signed in, bounce onward (see below)
 *   /app/dashboard   -> DashboardApp; if signed out, bounce to /app/login?next=...
 *   anything else    -> /app/dashboard
 *
 * Pure and side-effect-free so both the render path (what to show *now*,
 * before the effect below has a chance to run) and that effect (which
 * performs the actual navigation) agree on the same decision. `pathname` is
 * always under /app — see app/index.html + the dev/build routing that only
 * ever loads this module there.
 */
function resolveAppRoute(pathname: string, search: string, signedIn: boolean): RouteResolution {
  const isRoot = pathname === "/app" || pathname === "/app/";
  const isLogin = pathname === "/app/login";
  const isDashboard = pathname === "/app/dashboard" || pathname.startsWith("/app/dashboard/");

  if (isRoot) {
    return { kind: "redirect", to: (signedIn ? "/app/dashboard" : "/app/login") + search };
  }

  if (isLogin) {
    if (!signedIn) return { kind: "login" };
    // No explicit `next` (e.g. a direct /app/login?connect=extension visit,
    // or one just signed in) -> /app/dashboard, carrying over any other
    // query params (like ?connect=extension) unchanged.
    // `next` is attacker-controllable (it's in a link), so only an in-app
    // path is honoured — never "//host", a full URL, or the landing page.
    const params = new URLSearchParams(search);
    const next = params.get("next");
    if (next !== null && next.startsWith("/app/")) return { kind: "redirect", to: next };
    params.delete("next");
    const rest = params.toString();
    return { kind: "redirect", to: `/app/dashboard${rest ? `?${rest}` : ""}` };
  }

  if (isDashboard) {
    if (!signedIn) {
      return { kind: "redirect", to: `/app/login?next=${encodeURIComponent(pathname + search)}` };
    }
    // Only /app/dashboard itself is built today. A future nested route
    // (e.g. /app/dashboard/collections/:id) still round-trips correctly
    // through /app/login above once signed out — it just lands back here
    // instead of on a page that doesn't exist yet.
    if (pathname !== "/app/dashboard") return { kind: "redirect", to: "/app/dashboard" };
    return { kind: "dashboard" };
  }

  // Unknown /app/* path.
  return { kind: "redirect", to: `/app/dashboard${search}` };
}

export function App() {
  const { t } = useI18n();
  const [state, setState] = useState<BootState>({ kind: "loading" });
  const runnerRef = useRef<AutoSyncHandle | null>(null);
  // Guards every transition that leaves the "signed-in" state (explicit
  // sign-out/delete, or the session-expiry watch below) against firing more
  // than once for the same session and against racing an in-flight sign-in:
  // it's a plain ref (shared by every closure, old or new) rather than
  // component state, set synchronously the instant a transition starts, and
  // reset only once a *new* sign-in actually lands in enterDashboard.
  const transitioningRef = useRef(false);

  const enterDashboard = useCallback(async (profile: CloudUserProfile, user: NookUser) => {
    transitioningRef.current = false;
    writeCachedUser(profile);
    await bindCloudAccount(profile);
    runnerRef.current?.stop();
    runnerRef.current = startAutoSync();
    setState({ kind: "signed-in", user });
  }, []);

  // Shared tail of both sign-out and account deletion: forget the extension
  // link, wipe the local copy of the account's library (it's just a cache —
  // see bindCloudAccount/unbindCloudAccount in lib/cloud-sync.ts), stop the
  // sync loop, and go back to the sign-in screen.
  const cleanupAndReturnToSignIn = useCallback(async () => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    if (state.kind === "signed-in") await disconnectExtension(state.user.id);
    await unbindCloudAccount({ wipe: true });
    runnerRef.current?.stop();
    runnerRef.current = null;
    writeCachedUser(null);
    setState({ kind: "signed-out" });
  }, [state]);

  // Session-expiry only: stop syncing and show the sign-in screen again,
  // WITHOUT unbinding/wiping the local library and WITHOUT disconnecting the
  // extension — the contract says an expired session just needs a re-login,
  // and re-login as the same user (enterDashboard -> bindCloudAccount) picks
  // the same local data back up (it only wipes for a *different* account —
  // see bindCloudAccount in lib/cloud-sync.ts). The cached profile is left in
  // place too, so a stale/offline reopen still boots the same local library.
  const returnToSignInAfterExpiry = useCallback(() => {
    if (transitioningRef.current) return;
    transitioningRef.current = true;
    runnerRef.current?.stop();
    runnerRef.current = null;
    setState({ kind: "signed-out" });
  }, []);

  const signOut = useCallback(async () => {
    // Best-effort final upload before we lose the session — short timeout so
    // a slow/offline network never blocks sign-out.
    try {
      await Promise.race([
        runnerRef.current?.requestSync() ?? Promise.resolve(),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    } catch {
      // Ignored — signing out proceeds regardless.
    }
    try {
      await authClient.signOut();
    } catch {
      // Ignored — local cleanup below still runs.
    }
    await cleanupAndReturnToSignIn();
  }, [cleanupAndReturnToSignIn]);

  // deleteUser already invalidated the session server-side, so there's
  // nothing left to sync or sign out of — just the shared local cleanup.
  const cleanupAfterAccountDeleted = cleanupAndReturnToSignIn;

  const requestSync = useCallback(async () => {
    await runnerRef.current?.requestSync();
  }, []);

  // Boot: resolve the session once. When the request fails for a network
  // reason, fall back to the last profile we cached so the app still opens
  // its local (offline) library instead of forcing a sign-in screen no
  // network can satisfy.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data, error } = await authClient.getSession();
        if (cancelled) return;
        if (data?.user) {
          await enterDashboard(toProfile(data.user), toNookUser(data.user));
          return;
        }
        if (isNetworkFailure(error)) {
          const cached = readCachedUser();
          if (cached) {
            await enterDashboard(cached, { ...cached });
            return;
          }
        }
        setState({ kind: "signed-out" });
      } catch {
        if (cancelled) return;
        const cached = readCachedUser();
        if (cached) await enterDashboard(cached, { ...cached });
        else setState({ kind: "signed-out" });
      }
    })();
    return () => {
      cancelled = true;
    };
    // Boot runs exactly once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Session-expiry watch: cookie mode's `signedIn` goes false once a sync
  // request gets a 401 (see cloudStatus() in lib/cloud-sync.ts). `offline`
  // stays false for that case (it's not a network error), which is what
  // tells us the session actually expired rather than the network dropping.
  // This must NOT run the full cleanup (that wipes local data) — see
  // returnToSignInAfterExpiry above. `transitioningRef` also protects against
  // subscribeCloudStatus's ~250ms-debounced listener firing again (e.g. from
  // another "nook-cloud"/"nook-db" broadcast) while the first call is still
  // being handled.
  useEffect(() => {
    if (state.kind !== "signed-in") return;
    return subscribeCloudStatus((status: CloudStatus) => {
      if (!status.signedIn && !status.offline) returnToSignInAfterExpiry();
    });
  }, [state.kind, returnToSignInAfterExpiry]);

  // Route dispatch (resolveAppRoute above): runs once the boot sequence
  // knows whether we're signed in, and again on every navigation (back/
  // forward, `navigate()` elsewhere, or a signed-in/signed-out transition
  // above changing what the *same* URL should resolve to — e.g. landing on
  // /app/dashboard just as a session expires). A "redirect" resolution is
  // acted on here; the render below mirrors the same decision so nothing
  // wrong flashes on screen while this effect is still pending.
  const route = useRoute();
  useEffect(() => {
    if (state.kind === "loading") return;
    const resolution = resolveAppRoute(route.pathname, route.search, state.kind === "signed-in");
    if (resolution.kind === "redirect") navigate(resolution.to, { replace: true });
  }, [state.kind, route.pathname, route.search]);

  // Keeps the tab title in the user's chosen language (docs/i18n.md's
  // `<I18nProvider>` already keeps `document.documentElement.lang` in sync;
  // `document.title` isn't something React itself owns, so it needs its own
  // effect here).
  useEffect(() => {
    document.title = t("web.meta.title");
  }, [t]);

  if (state.kind === "loading") {
    return (
      <Theme theme={nookTheme} mode="system">
        <Center axis="both" minHeight="100vh">
          <Text color="secondary">{t("web.boot.loading")}</Text>
        </Center>
      </Theme>
    );
  }

  const resolution = resolveAppRoute(route.pathname, route.search, state.kind === "signed-in");

  if (resolution.kind === "redirect") {
    // The effect above performs the actual navigate(); this is just the
    // brief in-between frame.
    return (
      <Theme theme={nookTheme} mode="system">
        <Center axis="both" minHeight="100vh">
          <Text color="secondary">{t("web.boot.loading")}</Text>
        </Center>
      </Theme>
    );
  }

  if (resolution.kind === "login") {
    return (
      <Theme theme={nookTheme} mode="system">
        <AuthScreen onSignedIn={(user) => enterDashboard(toProfile(user), toNookUser(user))} />
      </Theme>
    );
  }

  if (state.kind !== "signed-in") {
    // resolveAppRoute only ever returns "dashboard" when signedIn is true —
    // unreachable in practice, this just keeps state.user's type honest.
    return null;
  }

  return (
    <SignedInApp
      user={state.user}
      requestSync={requestSync}
      signOut={signOut}
      cleanupAfterAccountDeleted={cleanupAfterAccountDeleted}
    />
  );
}

function SignedInApp({
  user,
  requestSync,
  signOut,
  cleanupAfterAccountDeleted,
}: {
  user: NookUser;
  requestSync: () => Promise<void>;
  signOut: () => Promise<void>;
  cleanupAfterAccountDeleted: () => Promise<void>;
}) {
  const { t } = useI18n();
  const host = useWebHost({ user, requestSync, signOut, cleanupAfterAccountDeleted });
  const [confirmation, setConfirmation] = useState<{ status: "success" | "error"; message: string } | null>(null);

  // `?connect=extension` (contract section 6/task 2): connect the extension
  // right after landing here — whether we just signed in or were already
  // signed in when this link was opened — then confirm and continue.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("connect") !== "extension") return;
    let cancelled = false;
    void (async () => {
      try {
        await host.extensionLink?.connect();
        if (!cancelled) setConfirmation({ status: "success", message: t("web.extension.connected") });
      } catch (error) {
        if (!cancelled) {
          setConfirmation({
            status: "error",
            message: error instanceof Error ? error.message : t("web.extension.connectFailed"),
          });
        }
      } finally {
        params.delete("connect");
        const query = params.toString();
        const next = window.location.pathname + (query ? `?${query}` : "") + window.location.hash;
        window.history.replaceState(null, "", next);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Runs once per mount of a freshly signed-in session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!confirmation) return;
    const timer = window.setTimeout(() => setConfirmation(null), 6000);
    return () => window.clearTimeout(timer);
  }, [confirmation]);

  return (
    <>
      {confirmation ? (
        <Section padding={3}>
          <Banner
            status={confirmation.status}
            title={confirmation.message}
            isDismissable
            onDismiss={() => setConfirmation(null)}
          />
        </Section>
      ) : null}
      <NookHostProvider host={host}>
        <DashboardApp />
      </NookHostProvider>
    </>
  );
}
