/**
 * Pure helpers for rendering an "Active sessions" row (Settings → Account &
 * security) from the raw fields Better Auth hands back: a `User-Agent`
 * string and an IP address. No DOM, no host access — safe to unit test in
 * isolation and safe to call from a render function.
 */

export type SessionBrowser =
  | "Chrome"
  | "Safari"
  | "Firefox"
  | "Edge"
  | "Opera"
  | "Vivaldi"
  | "Samsung Internet"
  | "Arc"
  | "Nook"
  | "Unknown browser";

export type SessionOS = "macOS" | "Windows" | "iOS" | "Android" | "Linux" | "Chrome OS" | "Unknown OS";

export type SessionDeviceType = "desktop" | "mobile" | "tablet";

export interface SessionDescription {
  browser: SessionBrowser;
  os: SessionOS;
  device: SessionDeviceType;
}

const UNKNOWN_SESSION: SessionDescription = { browser: "Unknown browser", os: "Unknown OS", device: "desktop" };

/**
 * Parses a `User-Agent` string into a short, human summary. Best-effort:
 * UA sniffing is inherently fuzzy (browsers borrow each other's tokens for
 * compatibility, and some — Arc, Brave — deliberately mimic Chrome's UA to
 * resist fingerprinting), so this favors a sensible fallback over false
 * precision.
 */
export function describeSession(userAgent: string | null | undefined): SessionDescription {
  const ua = userAgent?.trim();
  if (!ua) return UNKNOWN_SESSION;
  return { browser: detectBrowser(ua), os: detectOS(ua), device: detectDevice(ua) };
}

function detectBrowser(ua: string): SessionBrowser {
  // A custom UA token Nook's own background requests (extension service
  // worker, sync jobs) could carry — checked first so it wins over the
  // Chromium tokens the underlying fetch would otherwise also match.
  if (/Nook\//i.test(ua)) return "Nook";
  if (/Edg(e|A|iOS)?\//i.test(ua)) return "Edge";
  if (/OPR\/|Opera/i.test(ua)) return "Opera";
  if (/Vivaldi\//i.test(ua)) return "Vivaldi";
  if (/SamsungBrowser\//i.test(ua)) return "Samsung Internet";
  if (/\bArc\//i.test(ua)) return "Arc";
  if (/Firefox\/|FxiOS\//i.test(ua)) return "Firefox";
  if (/CriOS\/|Chrome\//i.test(ua)) return "Chrome";
  if (/Version\/.*Safari\//i.test(ua)) return "Safari";
  return "Unknown browser";
}

function detectOS(ua: string): SessionOS {
  if (/iPhone|iPad|iPod/i.test(ua)) return "iOS";
  if (/CrOS/i.test(ua)) return "Chrome OS";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows NT/i.test(ua)) return "Windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macOS";
  if (/Linux/i.test(ua)) return "Linux";
  return "Unknown OS";
}

function detectDevice(ua: string): SessionDeviceType {
  if (/iPad/i.test(ua) || /Tablet/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return "tablet";
  if (/iPhone|iPod/i.test(ua) || /Mobi/i.test(ua) || (/Android/i.test(ua) && /Mobile/i.test(ua))) return "mobile";
  return "desktop";
}

/** "Chrome on macOS" for a fully-recognized session, with graceful degradation when a part is unknown. */
export function sessionTitle(info: SessionDescription): string {
  const unknownBrowser = info.browser === "Unknown browser";
  const unknownOS = info.os === "Unknown OS";
  if (unknownBrowser && unknownOS) return "Unknown device";
  if (unknownOS) return info.browser;
  if (unknownBrowser) return `Unknown browser on ${info.os}`;
  return `${info.browser} on ${info.os}`;
}

/**
 * Whether an IP address is worth showing next to a session. Private,
 * loopback, link-local and Docker/compose-network addresses are noise on a
 * self-hosted deployment (they all read as "172.29.0.1" behind a reverse
 * proxy) — only a real public IP is useful to the person reviewing their
 * sessions.
 */
export function isPublicIpAddress(ip: string | null | undefined): boolean {
  const value = ip?.trim();
  if (!value) return false;

  if (value === "::1") return false; // IPv6 loopback
  if (/^f[cd][0-9a-f]{2}:/i.test(value)) return false; // fc00::/7 unique local

  const v4 = value.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 127) return false; // loopback
    if (a === 10) return false; // private
    if (a === 172 && b >= 16 && b <= 31) return false; // private / docker default bridge
    if (a === 192 && b === 168) return false; // private
    if (a === 169 && b === 254) return false; // link-local
    return true;
  }

  // Anything else IPv6-shaped that isn't loopback or unique-local is treated as public.
  return true;
}
