/**
 * Pure URL helpers shared by page capture, dedupe/lookup and the X post
 * detection used by the popup's ActivePageState. No chrome.* / DOM globals
 * here so this is plain unit-testable logic.
 */

// Common tracking params worth stripping before comparing/storing a URL.
// Prefix-matched (utm_*) or exact-matched — see `isTrackingParam`.
const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAM_NAMES = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "msclkid",
  "twclid",
  "yclid",
  "mc_cid",
  "mc_eid",
  "ref_src",
  "ref_url",
  "igshid",
  "igsh",
  "_hsenc",
  "_hsmi",
  "mkt_tok",
  "vero_id",
  "spm",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  if (TRACKING_PARAM_NAMES.has(lower)) return true;
  return TRACKING_PARAM_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * Canonical form of a URL for dedupe/lookup purposes: no hash, no tracking
 * params, remaining query params sorted so param order never causes a
 * false mismatch. Falls back to the trimmed input when it isn't a valid URL.
 */
export function normalizeUrlForDedupe(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return trimmed;
  }

  const keptParams: Array<[string, string]> = [];
  for (const [key, value] of url.searchParams.entries()) {
    if (!isTrackingParam(key)) keptParams.push([key, value]);
  }
  keptParams.sort(([a], [b]) => a.localeCompare(b));

  url.search = "";
  for (const [key, value] of keptParams) url.searchParams.append(key, value);
  url.hash = "";

  return url.toString();
}

const X_HOSTNAMES = new Set([
  "x.com",
  "www.x.com",
  "mobile.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

/** The numeric status id in an x.com/twitter.com `/<user>/status/<id>` URL, or null. */
export function extractXStatusId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!X_HOSTNAMES.has(parsed.hostname.toLowerCase())) return null;
  const match = parsed.pathname.match(/^\/[^/]+\/status\/(\d+)/);
  return match ? match[1] : null;
}

export function isXPostUrl(url: string): boolean {
  return extractXStatusId(url) !== null;
}

/** The `x:<id>` bookmark id the X content script uses for this status URL, or null. */
export function xBookmarkIdForUrl(url: string): string | null {
  const statusId = extractXStatusId(url);
  return statusId ? `x:${statusId}` : null;
}
