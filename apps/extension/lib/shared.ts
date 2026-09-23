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
 * NOTE: this file intentionally does NOT include the toast helpers
 * (showNotification in content.js / showNookToastInPage in background.js).
 * showNookToastInPage is passed to chrome.scripting.executeScript({ func })
 * and gets serialized and re-executed inside the target web page — it
 * cannot reference any outer scope, including this module. Keeping both
 * toast implementations self-contained (with a short comment explaining
 * why) is intentional, not an oversight.
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

export {
  ICONS,
  createAvatarFallback,
  formatDate
};
import type { Creator } from "./types";
