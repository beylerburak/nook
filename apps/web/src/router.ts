/**
 * Minimal client-side router for the app shell (mounted at /app/index.html —
 * see vite.config.ts's multi-page build and vite-plugins/app-history-fallback.ts
 * for how deep links like /app/dashboard reach that one HTML file). Not a
 * library: there are only a handful of routes today (see the dispatch table
 * in App.tsx), so this module is deliberately just a `useRoute` hook that
 * re-renders on navigation, plus a `navigate` helper — no route matching, no
 * nested layouts. Add those here if the route table in App.tsx ever grows
 * enough to need them.
 */
import { useEffect, useState } from "react";

/** Fired whenever `navigate` changes the URL — `popstate` alone only covers back/forward, not pushState/replaceState. */
const NAVIGATE_EVENT = "nook:navigate";

export interface Route {
  pathname: string;
  search: string;
}

function readRoute(): Route {
  return { pathname: window.location.pathname, search: window.location.search };
}

/** The current pathname/search, re-read on every `popstate` and every `navigate` call (including ones from elsewhere in the tree). */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(readRoute);

  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener("popstate", onChange);
    window.addEventListener(NAVIGATE_EVENT, onChange);
    return () => {
      window.removeEventListener("popstate", onChange);
      window.removeEventListener(NAVIGATE_EVENT, onChange);
    };
  }, []);

  return route;
}

/**
 * Pushes (or replaces) `path` onto history — `path` may carry its own query
 * string (e.g. "/app/dashboard?connect=extension"). Dispatches a same-window
 * `NAVIGATE_EVENT` since neither pushState nor replaceState fire `popstate`
 * themselves (that only fires for actual back/forward), so every mounted
 * `useRoute` needs an explicit nudge to notice the URL changed.
 */
export function navigate(path: string, options?: { replace?: boolean }): void {
  const url = new URL(path, window.location.origin);
  const target = `${url.pathname}${url.search}${url.hash}`;
  if (options?.replace) window.history.replaceState(null, "", target);
  else window.history.pushState(null, "", target);
  window.dispatchEvent(new Event(NAVIGATE_EVENT));
}
