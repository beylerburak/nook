/**
 * Nook Shared Extension Helpers
 *
 * Small set of values/functions that were duplicated across background.js,
 * dashboard.js and popup.js. Exposed as a single global namespace
 * (globalThis.NookShared), same UMD-ish style as x-parser.js, so it can be
 * loaded as a plain <script> (dashboard.html / popup.html), via
 * importScripts (background.js, a classic service worker) and as a content
 * script (manifest.json, loaded before content.js).
 *
 * Bookmark feedback is rendered by the Astryx-backed content-script host.
 * Save entry points send it a typed runtime message so toast layout and note
 * handling stay shared across X and regular web pages.
 */



  // Inline SVG icons reused across dashboard.js / popup.js. The icons that
  // are reused at different sizes/styles are small builder functions (so
  // each call site keeps its original width/height/stroke attributes and
  // nothing renders differently); "play" is used at one fixed size
  // everywhere, so it stays a plain string.
  const ICONS = {
    externalLink: (size = 14) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
      <polyline points="15 3 21 3 21 9"></polyline>
      <line x1="10" y1="14" x2="21" y2="3"></line>
    </svg>
  `,
    trash: (size = 14, { round = true } = {}) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"${round ? ' stroke-linecap="round" stroke-linejoin="round"' : ""}>
      <path d="M3 6h18m-2 0v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6m3 0V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>
    </svg>
  `,
    copy: (size = 14) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
    </svg>
  `,
    info: (size = 14) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="12" y1="16" x2="12" y2="12"></line>
      <line x1="12" y1="8" x2="12.01" y2="8"></line>
    </svg>
  `,
    xLogo: (size = 15) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  `,
    globe: (size = 15) => `
    <svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
    </svg>
  `,
    play: `
    <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
      <polygon points="5 3 19 12 5 21 5 3"></polygon>
    </svg>
  `
  };

  /**
   * Single-letter avatar placeholder shown when a creator has no avatar
   * image, or when their avatar image fails to load.
   */
  function createAvatarFallback(creator: Creator | undefined): HTMLDivElement {
    const div = document.createElement("div");
    div.className = "avatar-fallback";
    const name = creator?.name || creator?.handle || "X";
    div.textContent = name.charAt(0).toUpperCase();
    return div;
  }

  /**
   * Formats an ISO date string as a short relative/absolute label
   * ("Just now", "5m ago", "3d ago", "Jan 5" ...).
   */
  function formatDate(dateString: string | null | undefined): string {
    if (!dateString) return "Saved";
    try {
      const date = new Date(dateString);
      if (isNaN(date.getTime())) return "Saved";

      const now = new Date();
      const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

      if (diffSec < 60) return "Just now";
      if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
      if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
      if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;

      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: date.getFullYear() !== now.getFullYear() ? "numeric" : undefined
      });
    } catch (e) {
      return "Saved";
    }
  }

function getBookmarkSortTime(item: Bookmark): number {
  // Chrome's createdAt is the browser bookmark's dateAdded. savedAt is when
  // Nook imported it, so preferring savedAt would group an import by import time.
  if (item.source === "chrome" && item.createdAt) {
    const createdAt = new Date(item.createdAt).getTime();
    if (Number.isFinite(createdAt)) return createdAt;
  }

  // X's timeline sort index is a millisecond timestamp and preserves the
  // service's bookmark order when a sync batch gives items similar savedAt values.
  if (item.source === "x" && item.xSortIndex && /^\d{13}$/.test(item.xSortIndex)) {
    const xSortTime = Number(item.xSortIndex);
    if (Number.isFinite(xSortTime)) return xSortTime;
  }

  const savedAt = item.savedAt ? new Date(item.savedAt).getTime() : NaN;
  if (Number.isFinite(savedAt)) return savedAt;

  const createdAt = item.createdAt ? new Date(item.createdAt).getTime() : NaN;
  return Number.isFinite(createdAt) ? createdAt : 0;
}

function sortBookmarksByDate(items: Bookmark[], direction: "newest" | "oldest" = "newest"): Bookmark[] {
  return [...items].sort((a, b) => {
    const timeA = getBookmarkSortTime(a);
    const timeB = getBookmarkSortTime(b);
    return direction === "newest" ? timeB - timeA : timeA - timeB;
  });
}

export {
  ICONS,
  createAvatarFallback,
  formatDate,
  sortBookmarksByDate
};
import type { Bookmark, Creator } from "./types";
