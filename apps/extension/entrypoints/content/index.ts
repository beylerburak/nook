import { defineContentScript } from "wxt/utils/define-content-script";
import * as NookXParser from "../../lib/x-parser";
import type { Bookmark, ContentToBackgroundMessage, Media, MessageResponse, Quote } from "../../lib/types";

type UIElement = HTMLElement & { value?: string; files?: FileList | null; src?: string; href?: string; _timeout?: ReturnType<typeof setTimeout>; _successTimeout?: number };
const byId = (id: string): UIElement => document.getElementById(id) as UIElement;
const queryOne = (selector: string): UIElement => document.querySelector(selector) as UIElement;
const queryAll = (selector: string): UIElement[] => Array.from(document.querySelectorAll(selector)) as UIElement[];
const sendNookMessage = (message: ContentToBackgroundMessage): Promise<MessageResponse> =>
  chrome.runtime.sendMessage(message);


export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
  runAt: "document_idle",
  main() {
console.log("[Nook] Running");

const { parseGraphQLBookmarks, extractBottomCursor, diagnoseGraphQLResponse } = NookXParser;

function isExtensionValid() {
  return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
}

document.addEventListener(
  "click",
  async (event) => {
    try {
      const target = event.target;

      if (!(target instanceof Element)) return;

      // Only the bookmark button on a post that isn't bookmarked yet.
      // The "remove bookmark" button is usually removeBookmark.
      const bookmarkButton = target.closest('[data-testid="bookmark"]');

      if (!bookmarkButton) return;

      if (!isExtensionValid()) {
        console.warn("[Nook] Extension was reloaded. Please refresh the page (F5).");
        showNotification("Nook was updated. Please refresh the page (F5) 🔄");
        return;
      }

      const article = bookmarkButton.closest('article[data-testid="tweet"]');

      if (!article) {
        console.warn("[Nook] Tweet container not found");
        return;
      }

      const item = parseTweet(article);

      if (!item?.url) {
        console.warn("[Nook] Could not parse tweet", item);
        return;
      }

      const saved = await saveItem(item);

      if (saved) {
        showNotification(
          item.media?.length
            ? `Nook: Saved with ${item.media.length} media ✓`
            : "Nook: Saved to bookmarks ✓",
          item.id
        );
        console.log("[Nook] Saved", item);
      }
    } catch (err) {
      console.warn("[Nook] Click handler caught:", err);
    }
  },
  true
);

// querySelectorAll that skips matches inside `exclude` (e.g. the quoted tweet box)
function queryAllOutside(root: Element, selector: string, exclude: Element | null = null): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => !exclude || !exclude.contains(el));
}

function queryOutside(root: Element, selector: string, exclude: Element | null = null): HTMLElement | null {
  return queryAllOutside(root, selector, exclude)[0] || null;
}

// The quoted tweet is rendered as a clickable div[role="link"] with its own User-Name
function findQuoteBox(article: Element): HTMLElement | null {
  return [...article.querySelectorAll('div[role="link"]')].find((el) =>
    el.querySelector('[data-testid="User-Name"]')
  ) as HTMLElement | undefined || null;
}

function extractMedia(article: Element, exclude: Element | null = null): Media[] {
  const media: Media[] = [];
  const seenUrls = new Set();

  // 1. Tweet Photos (and video thumbnails X renders as <img>)
  const photoImgs = queryAllOutside(
    article,
    '[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"], img[src*="video_thumb/"]',
    exclude
  );

  for (const img of photoImgs) {
    let src = img.getAttribute("src") || (img as HTMLImageElement).src;
    if (!src) continue;

    // Normalizing low-res small thumbnails to large when available
    try {
      const urlObj = new URL(src);
      if (urlObj.searchParams.has("name")) {
        const curName = urlObj.searchParams.get("name");
        if (curName === "small" || curName === "240x240" || curName === "360x360") {
          urlObj.searchParams.set("name", "large");
          src = urlObj.href;
        }
      }
    } catch (e) {}

    const baseId = src.split("?")[0];
    if (!seenUrls.has(baseId)) {
      seenUrls.add(baseId);
      media.push({
        type: /video_thumb\//.test(src) ? "video" : "image",
        url: src,
        alt: img.getAttribute("alt") || ""
      });
    }
  }

  // 2. Video / GIF poster thumbnail
  const videos = queryAllOutside(article, "video", exclude);
  for (const video of videos) {
    const poster = video.getAttribute("poster") || (video as HTMLVideoElement).poster;
    if (poster) {
      const baseId = poster.split("?")[0];
      if (!seenUrls.has(baseId)) {
        seenUrls.add(baseId);
        media.push({
          type: "video",
          url: poster,
          alt: "Video thumbnail"
        });
      }
    }
  }

  // 3. Link Card Preview images (for external articles, YouTube, etc.)
  const cardImgs = queryAllOutside(
    article,
    '[data-testid="card.wrapper"] img, [data-testid^="card.layout"] img',
    exclude
  );
  for (const img of cardImgs) {
    const src = img.getAttribute("src") || (img as HTMLImageElement).src;
    if (src && !src.includes("profile_images")) {
      const baseId = src.split("?")[0];
      if (!seenUrls.has(baseId)) {
        seenUrls.add(baseId);
        media.push({
          type: "card",
          url: src,
          alt: img.getAttribute("alt") || "Link preview"
        });
      }
    }
  }

  return media;
}

function extractAvatar(root: Element, exclude: Element | null = null): string | null {
  const avatarImg = queryOutside(
    root,
    '[data-testid^="Tweet-User-Avatar"] img, [data-testid="UserAvatar"] img, img[src*="pbs.twimg.com/profile_images/"]',
    exclude
  );
  const src = avatarImg?.getAttribute("src") || (avatarImg as HTMLImageElement | null)?.src;
  if (src) return src;

  // Avatars that haven't loaded an <img> yet still carry a background-image
  const bg = queryOutside(root, '[style*="profile_images"]', exclude);
  return bg?.style.backgroundImage.match(/url\("?([^")]+)"?\)/)?.[1] || null;
}

function parseUserName(userElement: HTMLElement | null): { handle: string | null; name: string | null } {
  const lines = (userElement?.innerText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    handle: lines.find((line) => line.startsWith("@")) || null,
    name: lines.find((line) => !line.startsWith("@") && line !== "·") || null
  };
}

function parseQuoteBox(box: HTMLElement): Quote {
  const { handle, name } = parseUserName(box.querySelector<HTMLElement>('[data-testid="User-Name"]'));
  const text = box.querySelector<HTMLElement>('[data-testid="tweetText"]')?.innerText?.trim() || "";

  // The quote box has no permalink of its own; photo links still contain the status id
  let url = null;
  const statusHref = box.querySelector('a[href*="/status/"]')?.getAttribute("href");
  const match = statusHref?.match(/^\/?([^/]+)\/status\/(\d+)/);
  if (match) url = `https://x.com/${match[1]}/status/${match[2]}`;

  return {
    id: url ? `x:${url.match(/\/status\/(\d+)/)?.[1] ?? null}` : null,
    url,
    text,
    creator: { name, handle, avatar: extractAvatar(box) },
    media: extractMedia(box),
    createdAt: box.querySelector("time")?.getAttribute("datetime") || null
  };
}

function showNotification(message: string, bookmarkId?: string) {
  const id = "nook-toast-feedback";
  let toast = byId(id);
  clearTimeout(toast?._timeout);
  clearTimeout(toast?._successTimeout);
  if (!toast) {
    toast = document.createElement("div");
    toast.id = id;
    toast.style.cssText = `
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: min(340px, calc(100vw - 32px));
      box-sizing: border-box;
      background: #18181b;
      color: #f4f4f5;
      padding: 16px;
      border-radius: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      box-shadow: 0 12px 30px rgba(0,0,0,0.45), 0 0 0 1px rgba(255,255,255,0.12);
      z-index: 999999;
      transition: opacity 0.2s ease, transform 0.2s ease;
      line-height: 1.4;
    `;
    document.body.appendChild(toast);
  }

  if (!bookmarkId) {
    toast.textContent = message;
    toast.style.padding = "10px 18px";
    toast.style.width = "auto";
    toast.style.borderRadius = "9999px";
    toast._timeout = setTimeout(() => toast?.remove(), 2600);
  } else {
    const heading = document.createElement("div");
    heading.textContent = "✓  Saved to Nook";
    heading.style.cssText = "font-weight:700;font-size:14px;margin-bottom:4px";
    const detail = document.createElement("div");
    detail.textContent = message.replace(/^Nook:\s*/, "");
    detail.style.cssText = "color:#a1a1aa;font-size:12px;margin-bottom:12px";
    const actions = document.createElement("div");
    actions.style.cssText = "display:flex;gap:8px;align-items:center";
    const noteButton = document.createElement("button");
    noteButton.type = "button";
    noteButton.textContent = "＋ Add a note";
    noteButton.style.cssText = "border:0;border-radius:8px;background:#27272a;color:#fafafa;padding:8px 11px;font:600 12px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.textContent = "Dismiss";
    dismiss.style.cssText = "border:0;background:transparent;color:#a1a1aa;padding:8px;font:500 12px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer";
    const composer = document.createElement("div");
    composer.style.cssText = "display:none;margin-top:10px";
    const input = document.createElement("textarea");
    input.placeholder = "What do you want to remember?";
    input.rows = 3;
    input.style.cssText = "box-sizing:border-box;width:100%;resize:vertical;border:1px solid #3f3f46;border-radius:8px;background:#09090b;color:#fafafa;padding:9px;font:12px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;outline:none";
    const controls = document.createElement("div");
    controls.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:8px";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.cssText = "border:0;background:transparent;color:#a1a1aa;padding:7px 9px;font:500 12px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer";
    const save = document.createElement("button");
    save.type = "button";
    save.textContent = "Save note";
    save.style.cssText = "border:0;border-radius:8px;background:#7c3aed;color:white;padding:7px 11px;font:600 12px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer";
    noteButton.onclick = () => { composer.style.display = "block"; noteButton.style.display = "none"; input.focus(); };
    cancel.onclick = () => { composer.style.display = "none"; noteButton.style.display = "inline-block"; };
    dismiss.onclick = () => toast?.remove();
    save.onclick = () => {
      const note = input.value.trim();
      if (!note) { input.focus(); return; }
      save.disabled = true;
      save.textContent = "Saving…";
      sendNookMessage({ type: "UPDATE_BOOKMARK_NOTE", id: bookmarkId, note }).then((response) => {
        if (!response?.success) { save.disabled = false; save.textContent = "Try again"; return; }
        heading.textContent = "✓  Note saved";
        detail.textContent = "You can edit it anytime in Nook.";
        actions.remove();
        composer.remove();
        clearTimeout(toast?._successTimeout);
        toast!._successTimeout = window.setTimeout(() => {
          if (toast?.isConnected) toast.remove();
        }, 2800);
      }).catch(() => { save.disabled = false; save.textContent = "Try again"; });
    };
    controls.append(cancel, save);
    composer.append(input, controls);
    actions.append(noteButton, dismiss);
    toast.replaceChildren(heading, detail, actions, composer);
    toast._timeout = setTimeout(() => { if (composer.style.display !== "block") toast?.remove(); }, 7000);
    toast.addEventListener("mouseenter", () => clearTimeout(toast?._timeout));
    toast.addEventListener("mouseleave", () => {
      if (composer.style.display !== "block") toast!._timeout = setTimeout(() => toast?.remove(), 7000);
    });
  }
  toast.style.opacity = "1";
  toast.style.transform = "translateY(0)";
}

function extractTweetUrl(article: Element, timeElement: Element | null, handle: string | null, exclude: Element | null = null): string | null {
  let href = null;

  // 1. Time element link (most reliable on timeline)
  const timeLink = timeElement?.closest("a");
  if (timeLink) {
    href = timeLink.getAttribute("href") || (timeLink as HTMLAnchorElement).href;
  }

  // 2. Look for status link in article (ignoring quotes and photo links)
  if (!href) {
    const statusLinks = queryAllOutside(article, 'a[href*="/status/"]', exclude);
    for (const link of statusLinks) {
      const linkHref = link.getAttribute("href") || (link as HTMLAnchorElement).href;
      if (
        linkHref &&
        !linkHref.includes("/photo/") &&
        !linkHref.includes("/analytics") &&
        !linkHref.includes("/video/")
      ) {
        href = linkHref;
        break;
      }
    }
  }

  // 3. Current page URL if on a status page
  if (!href && window.location.pathname.includes("/status/")) {
    href = window.location.href;
  }

  // 4. Any status link fallback
  if (!href) {
    const anyStatus = queryOutside(article, 'a[href*="/status/"]', exclude);
    if (anyStatus) {
      href = anyStatus.getAttribute("href") || (anyStatus as HTMLAnchorElement).href;
    }
  }

  if (!href) return null;

  try {
    const urlObj = new URL(href, "https://x.com");
    let cleanPath = urlObj.pathname.replace(/\/(photo|analytics|video)\/\d+.*$/, "");
    cleanPath = cleanPath.replace(/\/(photo|analytics|video).*$/, "");
    return `https://x.com${cleanPath}`;
  } catch (e) {
    return href;
  }
}

function parseTweet(article: Element): Bookmark {
  // Everything inside the quoted tweet box belongs to the quote, not the main tweet
  const quoteBox = findQuoteBox(article);

  const textElement = queryOutside(article, '[data-testid="tweetText"]', quoteBox);
  const userElement = queryOutside(article, '[data-testid="User-Name"]', quoteBox);
  const timeElement = queryOutside(article, "time", quoteBox);

  const text = textElement?.innerText?.trim() || "";
  const { handle, name: creatorName } = parseUserName(userElement);

  let url = extractTweetUrl(article, timeElement, handle, quoteBox);
  const statusId = url?.match(/\/status\/(\d+)/)?.[1] || crypto.randomUUID();

  // If url was not found but statusId exists
  if (!url && statusId) {
    const userSlug = handle ? handle.replace("@", "") : "i";
    url = `https://x.com/${userSlug}/status/${statusId}`;
  }

  const media = extractMedia(article, quoteBox);
  const avatar = extractAvatar(article, quoteBox);
  const quote = quoteBox ? parseQuoteBox(quoteBox) : null;

  return {
    id: `x:${statusId}`,

    source: "x",

    title: handle
      ? `${handle}: ${text.slice(0, 100)}`
      : text.slice(0, 100),

    shortDescription: text.slice(0, 180),

    description: text,

    category: null,

    tags: [],

    media,

    attachments: media,

    urls: url ? [url] : [],

    url,

    creator: {
      name: creatorName,
      handle,
      avatar
    },

    quote,

    createdAt: timeElement?.getAttribute("datetime") || null,

    savedAt: new Date().toISOString()
  };
}

async function saveItem(item: Bookmark) {
  if (!isExtensionValid()) {
    console.warn("[Nook] Extension context invalidated. Please refresh the page (F5).");
    showNotification("Nook was updated. Please refresh the page (F5) 🔄");
    return false;
  }

  return new Promise((resolve) => {
    try {
      sendNookMessage({ type: "SAVE_ITEM", item }).then((response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Nook] Message error:", chrome.runtime.lastError.message);
          resolve(false);
        } else {
          resolve(response?.success === true);
        }
      });
    } catch (err) {
      console.warn("[Nook] Could not send message to background:", err);
      resolve(false);
    }
  });
}




// Note: GraphQL parsing is handled by NookXParser (apps/extension/x-parser.js)



// ─────────────────────────────────────────────
// Auto Sync — Direct API approach (no scroll)
// ─────────────────────────────────────────────

// X's public web bearer token (same one the web app itself uses)
const X_BEARER = "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

// Default features blob (same as what x.com sends)
const X_FEATURES = JSON.stringify({
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: false,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
});

// Bump when parseGraphQLBookmarks extracts new fields, to trigger one full backfill sync
const X_SYNC_PARSER_VERSION = 3;

// Store queryId captured by inject.js
  let _nookQueryId: string | null = null;

window.addEventListener("message", (event) => {
  if (event.data?.type === "NOOK_QUERY_ID") {
    if (typeof event.data.queryId !== "string") return;
    _nookQueryId = event.data.queryId;
    console.log("[Nook] Captured queryId from page:", _nookQueryId);
    // Persist in background.js so it survives SPA navigation
    sendNookMessage({ type: "STORE_QUERY_ID", queryId: event.data.queryId }).catch(() => {});
  }

  if (event.data?.type === "NOOK_SYNC_BOOKMARKS") {
    try {
      const items = parseGraphQLBookmarks(event.data.data) as unknown as Bookmark[];
      if (items.length > 0) {
        sendNookMessage({ type: "SYNC_ITEMS_BATCH", items }).then((response) => {
          if (response?.success && (response.count ?? 0) > 0) {
            showNotification(`Nook: ${response.count} bookmark${(response.count ?? 0) > 1 ? "s" : ""} synced ✓`);
          }
          if (typeof window._nookUpdateSyncLog === "function") {
            window._nookUpdateSyncLog(response?.count ?? 0);
          }
        });
      } else {
        if (typeof window._nookUpdateSyncLog === "function") {
          window._nookUpdateSyncLog(0);
        }
      }
    } catch (err) {
      console.error("[Nook] Error parsing bookmarks data:", err);
    }
  }
});

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
  return match ? match[1] : null;
}

// Note: extractBottomCursor is provided by NookXParser


async function fetchBookmarkPage(queryId: string, csrfToken: string, cursor: string | null) {
  const variables: { count: number; includePromotedContent: boolean; cursor?: string } = { count: 100, includePromotedContent: false };
  if (cursor) variables.cursor = cursor;

  const url = `https://x.com/i/api/graphql/${queryId}/Bookmarks?variables=${encodeURIComponent(JSON.stringify(variables))}&features=${encodeURIComponent(X_FEATURES)}`;

  const resp = await fetch(url, {
    credentials: "include",
    headers: {
      "Authorization": `Bearer ${X_BEARER}`,
      "X-Csrf-Token": csrfToken,
      "Content-Type": "application/json",
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Client-Language": "en",
    },
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function injectSyncOverlay() {
  if (byId("nook-sync-overlay")) return;
  const el = document.createElement("div");
  el.id = "nook-sync-overlay";
  el.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.92);backdrop-filter:blur(10px);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  el.innerHTML = `
    <div style="font-size:26px;font-weight:700;margin-bottom:10px">🔄 Nook Sync</div>
    <div style="font-size:14px;opacity:.7;margin-bottom:28px">Fetching all your bookmarks…</div>
    <div id="nook-sync-log" style="padding:12px 32px;background:#111;border:1px solid #2a2a2a;border-radius:12px;font-family:monospace;font-size:14px;min-width:260px;text-align:center">Starting…</div>
  `;
  document.body.appendChild(el);
}

async function startAutoSync(msgQueryId: string | null) {
  if (window._nookAutoSyncing) return;
  window._nookAutoSyncing = true;

  if (typeof parseGraphQLBookmarks !== "function" || typeof diagnoseGraphQLResponse !== "function") {
    console.error("[Nook] NookXParser is missing — x-parser.js failed to load");
    window._nookAutoSyncing = false;
    injectSyncOverlay();
    const el = byId("nook-sync-log");
    if (el) el.textContent = "Error: the X parser module failed to load.";
    setTimeout(() => sendNookMessage({ type: "CLOSE_CURRENT_TAB" }), 5000);
    return;
  }

  console.log("[Nook] Auto sync started (direct API mode)");
  injectSyncOverlay();
  const logEl = () => byId("nook-sync-log");
  const updateLog = (msg: string) => { const el = logEl(); if (el) el.textContent = msg; };

  function finishSync(newCount: number, updatedCount: number) {
    window._nookAutoSyncing = false;
    const ov = byId("nook-sync-overlay");
    if (ov) ov.innerHTML = `
      <div style="font-size:26px;font-weight:700;margin-bottom:10px;color:#4ade80">✓ Done</div>
      <div style="font-size:16px;margin-bottom:6px">${newCount} new bookmark${newCount === 1 ? "" : "s"} added to Nook.</div>
      ${updatedCount ? `<div style="font-size:13px;opacity:.7;margin-bottom:6px">${updatedCount} bookmark${updatedCount === 1 ? "" : "s"} updated (quotes / media).</div>` : ""}
      <div style="font-size:12px;opacity:.5">Closing tab…</div>
    `;
    setTimeout(() => sendNookMessage({ type: "CLOSE_CURRENT_TAB" }), 2000);
  }

  try {
    // Step 1: CSRF token
    const csrfToken = getCsrfToken();
    if (!csrfToken) throw new Error("CSRF token (ct0) not found. Are you logged in to X?");

    // Step 2: queryId resolution — priority: message arg > local > background.js cache
    updateLog("Fetching query ID…");
    let queryId = msgQueryId || _nookQueryId;

    if (!queryId) {
      // Ask background.js if it has a cached one
      queryId = await new Promise((resolve) => {
        sendNookMessage({ type: "GET_QUERY_ID" }).then((resp) => {
          resolve(resp?.queryId || null);
        });
      });
    }

    if (!queryId) {
      throw new Error("Could not find the X Bookmarks API query ID. Please open x.com/i/bookmarks manually first, then try again.");
    }

    console.log("[Nook] Using queryId:", queryId);


    // Step 3: Paginate through all bookmarks
    let cursor = null;
    let page = 0;
    let totalSynced = 0;
    let totalUpdated = 0;

    // Bumped when the parser starts extracting new data (v2: quoted tweets).
    // Until a full pass completes, don't stop early on already-saved pages so
    // older bookmarks get backfilled.
    const { xSyncParserVersion = 1 } = await chrome.storage.local.get<{ xSyncParserVersion?: number }>("xSyncParserVersion");
    const fullScan = xSyncParserVersion < X_SYNC_PARSER_VERSION;
    if (fullScan) console.log("[Nook] Parser updated — running full backfill scan");

    while (true) {
      page++;
      updateLog(`Fetching page ${page}… (${totalSynced} new)`);
      console.log("[Nook] Fetching page", page, "cursor:", cursor);

      const data = await fetchBookmarkPage(queryId, csrfToken, cursor);

      // ── Debug: show top-level keys in overlay on first page ──
      if (page === 1) {
        const topKeys = Object.keys(data?.data ?? {}).join(", ") || "(empty)";
        console.log("[Nook] API response top-level data keys:", topKeys);
        updateLog(`API response: ${topKeys}`);
        await new Promise(r => setTimeout(r, 1200)); // let user see it
      }

      // Check for API errors
      if (data?.errors?.length) {
        throw new Error(`API error: ${data.errors[0]?.message}`);
      }

      // Parse items from this page
      const items = parseGraphQLBookmarks(data);
      console.log("[Nook] Page", page, "parsed", items.length, "tweets from response");

      if (items.length === 0) {
        // An empty page can mean two very different things: a normal
        // end-of-list (cursor-only page, nothing to parse) or a schema
        // change that silently broke parsing (tweet-like entries present
        // but none could be turned into items). Diagnose to tell them apart
        // instead of always treating "0 items" as "reached the end".
        const diag = diagnoseGraphQLResponse(data);

        if (!diag.valid) {
          const diagMsg = diag.warnings.length
            ? diag.warnings.join(" | ")
            : (diag.errors.length ? diag.errors.join(" | ") : JSON.stringify(Object.keys(data?.data ?? {})));
          console.error("[Nook] Invalid response on page", page, "— diagnosis:", diag, "Full data:", JSON.stringify(data).slice(0, 500));
          throw new Error(`X's response schema may have changed (page ${page}): ${diagMsg}`);
        }

        console.log("[Nook] Empty page (cursor-only) on page", page, "— reached the end");
        break;
      } else {
        const partialWarning = diagnoseGraphQLResponse(data).warnings.find(w => w.includes("could be parsed"));
        if (partialWarning) {
          console.warn("[Nook] Partial parse on page", page, "—", partialWarning);
        }

        const result = await new Promise<MessageResponse>((resolve) => {
          sendNookMessage({ type: "SYNC_ITEMS_BATCH", items: items as unknown as Bookmark[] }).then(resolve);
        });
        totalSynced += result?.count ?? 0;
        totalUpdated += result?.updated ?? 0;
        updateLog(`Page ${page} — ${totalSynced} new, ${totalUpdated} updated`);

        if (!fullScan && result?.count === 0 && !result?.updated && cursor !== null) {
          console.log("[Nook] All items on page", page, "already saved — stopping");
          break;
        }
      }

      cursor = extractBottomCursor(data);
      if (!cursor) {
        console.log("[Nook] No more cursor — done");
        break;
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    if (fullScan) {
      await chrome.storage.local.set({ xSyncParserVersion: X_SYNC_PARSER_VERSION });
    }
    finishSync(totalSynced, totalUpdated);
  } catch (err) {
    console.error("[Nook] Auto sync error:", err);
    const ov = byId("nook-sync-overlay");
    if (ov) ov.innerHTML = `
      <div style="font-size:22px;font-weight:700;margin-bottom:10px;color:#f87171">✗ Error</div>
      <div style="font-size:14px;opacity:.8;max-width:340px;text-align:center">${err instanceof Error ? err.message : String(err)}</div>
      <div style="font-size:12px;opacity:.5;margin-top:16px">Closing tab…</div>
    `;
    window._nookAutoSyncing = false;
    setTimeout(() => sendNookMessage({ type: "CLOSE_CURRENT_TAB" }), 5000);
  }
}

// Listen for BEGIN_AUTO_SYNC from background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === "BEGIN_AUTO_SYNC") {
    sendResponse({ received: true });
    // Pass queryId from message (background.js cached it from inject.js interception)
    startAutoSync(message.queryId || null);
  }
});
  }
});
