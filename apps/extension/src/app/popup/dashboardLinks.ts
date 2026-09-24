/**
 * Pure builders for the popup/dashboard deep links — both the local
 * extension-page ones and the web app's. Kept free of chrome.* so they're
 * trivially testable; callers wrap the local ones in chrome.runtime.getURL()
 * before opening a tab.
 */

/** "dashboard.html", or "dashboard.html?q=..." for a non-empty query. */
export function buildDashboardSearchUrl(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) return "dashboard.html";
  return `dashboard.html?q=${encodeURIComponent(trimmed)}`;
}

/** "dashboard.html?id=..." to open a specific bookmark's detail panel. */
export function buildDashboardBookmarkUrl(id: string): string {
  return `dashboard.html?id=${encodeURIComponent(id)}`;
}

/** Strips a trailing slash so callers can join `${apiUrl}/...` without a doubled slash. */
function trimTrailingSlash(apiUrl: string): string {
  return apiUrl.replace(/\/$/, "");
}

/** The web app's root, or with a trimmed/encoded `q` search param for a non-empty query. */
export function buildWebSearchUrl(apiUrl: string, query: string): string {
  const base = trimTrailingSlash(apiUrl);
  const trimmed = query.trim();
  if (!trimmed) return `${base}/`;
  return `${base}/?q=${encodeURIComponent(trimmed)}`;
}

/** The web app URL that opens a specific bookmark's detail panel. */
export function buildWebBookmarkUrl(apiUrl: string, id: string): string {
  return `${trimTrailingSlash(apiUrl)}/?id=${encodeURIComponent(id)}`;
}

/** The web app URL that starts the "connect this extension" flow (see lib/bridge-protocol.ts). */
export function buildWebConnectUrl(apiUrl: string): string {
  return `${trimTrailingSlash(apiUrl)}/?connect=extension`;
}

/**
 * Web app URL for redirecting the extension's own dashboard page, preserving
 * whichever of `?q=`/`?id=` was on the extension page's URL (`location.search`).
 */
export function buildWebDashboardRedirectUrl(apiUrl: string, search: string): string {
  const params = new URLSearchParams(search);
  const id = params.get("id");
  if (id) return buildWebBookmarkUrl(apiUrl, id);
  const q = params.get("q");
  if (q) return buildWebSearchUrl(apiUrl, q);
  return `${trimTrailingSlash(apiUrl)}/`;
}
