import { mediaKey } from "./tweet-dom";

/**
 * Bounded cache of X video posters -> playable MP4 URLs.
 *
 * DOM saves (tweet-dom.ts's extractMedia) only ever see a <video poster> /
 * blob: src, never a playable file — the MP4 only shows up in X's own
 * GraphQL responses. entrypoints/inject.content (MAIN world) eavesdrops on
 * those responses and posts poster->videoUrl pairs here via
 * window.postMessage; extractMedia looks them up by poster to attach
 * `videoUrl` on an otherwise poster-only DOM save.
 *
 * Capped and LRU-evicted since this lives for as long as the tab does and
 * X's timelines are effectively endless.
 */

const MAX_ENTRIES = 750;

const videoUrlByPoster = new Map<string, string>();

/** Learns poster->videoUrl mappings, keyed the same way extractMedia keys a poster it finds in the DOM. */
export function registerVideoMedia(entries: unknown): void {
  if (!Array.isArray(entries)) return;

  for (const entry of entries) {
    const poster = (entry as { poster?: unknown } | null)?.poster;
    const videoUrl = (entry as { videoUrl?: unknown } | null)?.videoUrl;
    if (typeof poster !== "string" || typeof videoUrl !== "string" || !poster) continue;
    // Any page script can post this message, and the URL ends up in a <video>
    // on the dashboard, so only accept X's own video CDN.
    if (!videoUrl.startsWith("https://video.twimg.com/")) continue;

    const key = mediaKey(poster);
    // Re-set (rather than just overwrite) moves the key to the end of the
    // Map's iteration order, so the oldest entry below is truly the LRU one.
    videoUrlByPoster.delete(key);
    videoUrlByPoster.set(key, videoUrl);

    if (videoUrlByPoster.size > MAX_ENTRIES) {
      const oldestKey = videoUrlByPoster.keys().next().value;
      if (oldestKey !== undefined) videoUrlByPoster.delete(oldestKey);
    }
  }
}

/** The playable MP4 for `poster`, if a GraphQL response has taught us one. */
export function lookupVideoUrl(poster: string): string | undefined {
  return videoUrlByPoster.get(mediaKey(poster));
}

/** Listens for NOOK_VIDEO_MEDIA postMessages from entrypoints/inject.content (MAIN world). */
export function initVideoMediaRegistry(win: Window = window): void {
  win.addEventListener("message", (event) => {
    if (event.source === win && event.data?.type === "NOOK_VIDEO_MEDIA") {
      registerVideoMedia(event.data.entries);
    }
  });
}

export function _resetForTests(): void {
  videoUrlByPoster.clear();
}
