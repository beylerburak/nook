/**
 * Generic (non-X) web page capture: metadata extraction and Bookmark item
 * construction, extracted from the old inline `chrome.bookmarks.onCreated`
 * handler so every save entry point (native bookmark, context menu,
 * keyboard shortcut, popup "Save this page") builds items the same way.
 *
 * `extractPageMetadataInTab` and `fetchPageMetadata` are the two ways to get
 * a page's OpenGraph/meta info: live from an open tab (accurate, reflects
 * client-side rendering) or by fetching the HTML directly (works for pages
 * that aren't open, e.g. a right-clicked link). `buildPageBookmarkItem` is
 * pure and takes whichever metadata was available.
 */

import type { Bookmark, Media } from "./types";

export interface PageMetadata {
  title: string;
  description: string;
  siteName: string;
  image: string | null;
  iconHref: string | null;
}

const RESTRICTED_PROTOCOLS = new Set([
  "chrome:",
  "edge:",
  "about:",
  "chrome-extension:",
  "moz-extension:",
  "brave:",
  "opera:",
  "vivaldi:",
  "javascript:",
]);

/** True for browser-internal pages and the Web Store — never worth trying to save. Excludes file:, which needs a permission check the caller makes. */
export function isRestrictedUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (RESTRICTED_PROTOCOLS.has(parsed.protocol)) return true;
  if (parsed.hostname === "chromewebstore.google.com") return true;
  if (parsed.hostname === "chrome.google.com" && parsed.pathname.startsWith("/webstore")) return true;
  return false;
}

export function isFileUrl(url: string): boolean {
  try {
    return new URL(url).protocol === "file:";
  } catch {
    return false;
  }
}

/**
 * Executed inside the target page via chrome.scripting.executeScript — must
 * stay self-contained (no closures over outer variables) since it's
 * serialized and run in the page's own context.
 */
export function extractPageMetadataInTab(): PageMetadata | null {
  try {
    const getMeta = (selectors: string[]) => {
      for (const sel of selectors) {
        const el = document.querySelector<HTMLMetaElement>(`meta[property="${sel}"], meta[name="${sel}"]`);
        if (el && el.content) {
          const val = el.content.trim();
          if (val) return val;
        }
      }
      return null;
    };

    const title = getMeta(["og:title", "twitter:title"]) || document.title || "";

    const description = getMeta(["og:description", "twitter:description", "description"]) || "";

    const siteName = getMeta(["og:site_name"]) || window.location.hostname.replace(/^www\./, "");

    let image = getMeta(["og:image", "twitter:image", "twitter:image:src"]);
    if (image) {
      try {
        image = new URL(image, window.location.href).href;
      } catch {
        // Keep the raw value; better than dropping the image entirely.
      }
    }

    let iconHref: string | null = null;
    const iconEl =
      document.querySelector<HTMLLinkElement>('link[rel*="apple-touch-icon"]') ||
      document.querySelector<HTMLLinkElement>('link[rel*="icon"][sizes="192x192"]') ||
      document.querySelector<HTMLLinkElement>('link[rel*="icon"][sizes="32x32"]') ||
      document.querySelector<HTMLLinkElement>('link[rel*="icon"]');

    if (iconEl && iconEl.href) {
      try {
        iconHref = new URL(iconEl.href, window.location.href).href;
      } catch {
        // Ignore an unparsable favicon href.
      }
    }

    return { title, description, siteName, image, iconHref };
  } catch {
    return null;
  }
}

/** Fallback for pages that aren't open in a tab: fetch the HTML and regex out the same OG/meta tags. */
export async function fetchPageMetadata(url: string): Promise<PageMetadata | null> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);

    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });
    clearTimeout(timeoutId);

    if (!res.ok) return null;

    const html = await res.text();

    const getTagContent = (pattern: RegExp) => {
      const match = html.match(pattern);
      return match ? match[1].trim() : null;
    };

    const title =
      getTagContent(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      getTagContent(/<title[^>]*>([^<]+)<\/title>/i) ||
      "";

    const description =
      getTagContent(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
      getTagContent(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
      "";

    let image =
      getTagContent(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      getTagContent(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);

    if (image) {
      try {
        image = new URL(image, url).href;
      } catch {
        // Keep the raw value.
      }
    }

    const siteName = getTagContent(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i);

    return { title, description, siteName: siteName || "", image, iconHref: null };
  } catch {
    return null;
  }
}

export interface BuildPageBookmarkItemParams {
  id: string;
  source: string;
  url: string;
  metadata: PageMetadata | null;
  /** Used when metadata has no title (e.g. a native Chrome bookmark's own title). */
  fallbackTitle?: string;
  favIconUrl?: string;
  tags?: string[];
  createdAt?: string;
  savedAt?: string;
  /** Overrides the media/attachments derived from metadata.image — used by "Save image to Nook". */
  mediaOverride?: Media[];
}

/** Pure: same Bookmark shape the old inline `chrome.bookmarks.onCreated` handler built. */
export function buildPageBookmarkItem(params: BuildPageBookmarkItemParams): Bookmark {
  const { id, source, url, metadata, fallbackTitle, favIconUrl, tags, createdAt, savedAt, mediaOverride } = params;

  let hostname = url;
  try {
    hostname = new URL(url).hostname.replace(/^www\./, "");
  } catch {
    // Keep the raw url as a last-resort "hostname".
  }

  const title = (metadata?.title || fallbackTitle || hostname).trim();
  const description = (metadata?.description || "").trim();
  const ogImage = metadata?.image || null;
  const siteName = metadata?.siteName || hostname;
  const avatar =
    metadata?.iconHref || favIconUrl || `https://www.google.com/s2/favicons?domain=${hostname}&sz=128`;

  const media: Media[] = mediaOverride ?? (ogImage ? [{ type: "image", url: ogImage, alt: title }] : []);

  return {
    id,
    source,
    title,
    shortDescription: description ? description.slice(0, 180) : "",
    description,
    category: null,
    tags: tags ?? ["web"],
    listId: null,
    listName: null,
    media,
    attachments: media,
    urls: [url],
    url,
    creator: {
      name: siteName,
      handle: hostname,
      avatar,
    },
    createdAt: createdAt ?? new Date().toISOString(),
    savedAt: savedAt ?? new Date().toISOString(),
  };
}

/** Fields refreshed from the page on re-save; everything else (note, tags, collection, …) belongs to the user. */
const CAPTURED_CONTENT_FIELDS = ["title", "shortDescription", "description", "media", "attachments", "urls", "url", "creator", "savedAt"] as const;

/**
 * Re-saving a page updates what was captured from it but keeps the user's own
 * organization, and restores it if it had been removed.
 */
export function mergeCapturedContent(existing: Bookmark, captured: Bookmark): Bookmark {
  const refreshed: Partial<Bookmark> = {};
  for (const field of CAPTURED_CONTENT_FIELDS) refreshed[field] = captured[field] as never;
  return { ...existing, ...refreshed, id: existing.id, deletedAt: null };
}
