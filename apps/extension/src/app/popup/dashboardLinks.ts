/**
 * Pure builders for the popup -> dashboard deep links. Kept free of
 * chrome.* so they're trivially testable; callers wrap the result in
 * chrome.runtime.getURL() before opening a tab.
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
