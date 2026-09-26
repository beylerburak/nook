import { parseGraphQLBookmarks, extractBottomCursor, diagnoseGraphQLResponse } from "../../lib/x-parser";
import type { Bookmark, MessageResponse } from "../../lib/types";
import { translate } from "../../src/i18n/core";
import { getContentLocale } from "./locale-state";
import type { SendNookMessage } from "./messaging";
import type { Notify } from "./notify";

export interface BookmarkSyncDeps {
  sendMessage: SendNookMessage;
  notify: Notify;
}

// X's public web bearer token (same one the web app itself uses)
const X_BEARER =
  "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA";

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
  responsive_web_enhance_cards_enabled: false
});

// Bump when parseGraphQLBookmarks extracts new fields, to trigger one full backfill sync
const X_SYNC_PARSER_VERSION = 4;

function getCsrfToken(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)ct0=([^;]+)/);
  return match ? match[1] : null;
}

async function fetchBookmarkPage(queryId: string, csrfToken: string, cursor: string | null) {
  const variables: { count: number; includePromotedContent: boolean; cursor?: string } = {
    count: 100,
    includePromotedContent: false
  };
  if (cursor) variables.cursor = cursor;

  const url = `https://x.com/i/api/graphql/${queryId}/Bookmarks?variables=${encodeURIComponent(
    JSON.stringify(variables)
  )}&features=${encodeURIComponent(X_FEATURES)}`;

  const resp = await fetch(url, {
    credentials: "include",
    headers: {
      Authorization: `Bearer ${X_BEARER}`,
      "X-Csrf-Token": csrfToken,
      "Content-Type": "application/json",
      "X-Twitter-Active-User": "yes",
      "X-Twitter-Client-Language": "en"
    }
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function injectSyncOverlay(): void {
  if (document.getElementById("nook-sync-overlay")) return;
  const locale = getContentLocale();
  const el = document.createElement("div");
  el.id = "nook-sync-overlay";
  el.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.92);backdrop-filter:blur(10px);display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
  el.innerHTML = `
    <div style="font-size:26px;font-weight:700;margin-bottom:10px">${translate(locale, "extension.sync.title")}</div>
    <div style="font-size:14px;opacity:.7;margin-bottom:28px">${translate(locale, "extension.sync.fetchingAll")}</div>
    <div id="nook-sync-log" style="padding:12px 32px;background:#111;border:1px solid #2a2a2a;border-radius:12px;font-family:monospace;font-size:14px;min-width:260px;text-align:center">${translate(locale, "extension.sync.starting")}</div>
  `;
  document.body.appendChild(el);
}

/**
 * Sets up the auto-sync feature: captures the Bookmarks GraphQL queryId that
 * `inject.content` intercepts, listens for `BEGIN_AUTO_SYNC` from the
 * background page, and paginates X's Bookmarks API directly (no scrolling)
 * to backfill/refresh the local bookmark store.
 */
export function initBookmarkSync(deps: BookmarkSyncDeps): void {
  let queryIdFromPage: string | null = null;

  window.addEventListener("message", (event) => {
    if (event.data?.type === "NOOK_QUERY_ID") {
      if (typeof event.data.queryId !== "string") return;
      queryIdFromPage = event.data.queryId;
      console.log("[Nook] Captured queryId from page:", queryIdFromPage);
      // Persist in background.js so it survives SPA navigation
      deps.sendMessage({ type: "STORE_QUERY_ID", queryId: event.data.queryId }).catch(() => {});
    }

    if (event.data?.type === "NOOK_SYNC_BOOKMARKS") {
      try {
        const items = parseGraphQLBookmarks(event.data.data) as unknown as Bookmark[];
        if (items.length > 0) {
          deps.sendMessage({ type: "SYNC_ITEMS_BATCH", items }).then((response) => {
            if (response?.success && (response.count ?? 0) > 0) {
              deps.notify(translate(getContentLocale(), "extension.sync.syncedCount", { count: response.count ?? 0 }));
            }
            if (typeof window._nookUpdateSyncLog === "function") {
              window._nookUpdateSyncLog(response?.count ?? 0);
            }
          });
        } else if (typeof window._nookUpdateSyncLog === "function") {
          window._nookUpdateSyncLog(0);
        }
      } catch (err) {
        console.error("[Nook] Error parsing bookmarks data:", err);
      }
    }
  });

  async function startAutoSync(msgQueryId: string | null) {
    if (window._nookAutoSyncing) return;
    window._nookAutoSyncing = true;

    console.log("[Nook] Auto sync started (direct API mode)");
    injectSyncOverlay();
    const logEl = () => document.getElementById("nook-sync-log");
    const updateLog = (msg: string) => {
      const el = logEl();
      if (el) el.textContent = msg;
    };

    function finishSync(newCount: number, updatedCount: number) {
      window._nookAutoSyncing = false;
      const locale = getContentLocale();
      const ov = document.getElementById("nook-sync-overlay");
      if (ov) {
        ov.innerHTML = `
      <div style="font-size:26px;font-weight:700;margin-bottom:10px;color:#4ade80">✓ ${translate(locale, "extension.sync.done")}</div>
      <div style="font-size:16px;margin-bottom:6px">${translate(locale, "extension.sync.newBookmarksAdded", { count: newCount })}</div>
      ${updatedCount ? `<div style="font-size:13px;opacity:.7;margin-bottom:6px">${translate(locale, "extension.sync.bookmarksUpdated", { count: updatedCount })}</div>` : ""}
      <div style="font-size:12px;opacity:.5">${translate(locale, "extension.sync.closingTab")}</div>
    `;
      }
      setTimeout(() => deps.sendMessage({ type: "CLOSE_CURRENT_TAB" }), 2000);
    }

    try {
      // Step 1: CSRF token
      const csrfToken = getCsrfToken();
      if (!csrfToken) throw new Error(translate(getContentLocale(), "extension.sync.csrfMissing"));

      // Step 2: queryId resolution — priority: message arg > local > background.js cache
      updateLog(translate(getContentLocale(), "extension.sync.fetchingQueryId"));
      let queryId = msgQueryId || queryIdFromPage;

      if (!queryId) {
        // Ask background.js if it has a cached one
        queryId = await new Promise((resolve) => {
          deps.sendMessage({ type: "GET_QUERY_ID" }).then((resp) => {
            resolve(resp?.queryId || null);
          });
        });
      }

      if (!queryId) {
        throw new Error(translate(getContentLocale(), "extension.sync.queryIdMissing"));
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
      const { xSyncParserVersion = 1 } = await chrome.storage.local.get<{ xSyncParserVersion?: number }>(
        "xSyncParserVersion"
      );
      const fullScan = xSyncParserVersion < X_SYNC_PARSER_VERSION;
      if (fullScan) console.log("[Nook] Parser updated — running full backfill scan");

      while (true) {
        page++;
        updateLog(translate(getContentLocale(), "extension.sync.fetchingPage", { page, count: totalSynced }));
        console.log("[Nook] Fetching page", page, "cursor:", cursor);

        const data = await fetchBookmarkPage(queryId, csrfToken, cursor);

        // ── Debug: show top-level keys in overlay on first page ──
        if (page === 1) {
          const topKeys = Object.keys(data?.data ?? {}).join(", ") || "(empty)";
          console.log("[Nook] API response top-level data keys:", topKeys);
          updateLog(`API response: ${topKeys}`);
          await new Promise((r) => setTimeout(r, 1200)); // let user see it
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
              : diag.errors.length
                ? diag.errors.join(" | ")
                : JSON.stringify(Object.keys(data?.data ?? {}));
            console.error(
              "[Nook] Invalid response on page",
              page,
              "— diagnosis:",
              diag,
              "Full data:",
              JSON.stringify(data).slice(0, 500)
            );
            throw new Error(`X's response schema may have changed (page ${page}): ${diagMsg}`);
          }

          console.log("[Nook] Empty page (cursor-only) on page", page, "— reached the end");
          break;
        } else {
          const partialWarning = diagnoseGraphQLResponse(data).warnings.find((w) => w.includes("could be parsed"));
          if (partialWarning) {
            console.warn("[Nook] Partial parse on page", page, "—", partialWarning);
          }

          const result = await new Promise<MessageResponse>((resolve) => {
            deps.sendMessage({ type: "SYNC_ITEMS_BATCH", items: items as unknown as Bookmark[] }).then(resolve);
          });
          totalSynced += result?.count ?? 0;
          totalUpdated += result?.updated ?? 0;
          updateLog(
            translate(getContentLocale(), "extension.sync.pageProgress", {
              page,
              newCount: totalSynced,
              updatedCount: totalUpdated,
            }),
          );

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
      const locale = getContentLocale();
      const ov = document.getElementById("nook-sync-overlay");
      if (ov) {
        ov.innerHTML = `
      <div style="font-size:22px;font-weight:700;margin-bottom:10px;color:#f87171">✗ ${translate(locale, "extension.sync.error")}</div>
      <div style="font-size:14px;opacity:.8;max-width:340px;text-align:center">${err instanceof Error ? err.message : String(err)}</div>
      <div style="font-size:12px;opacity:.5;margin-top:16px">${translate(locale, "extension.sync.closingTab")}</div>
    `;
      }
      window._nookAutoSyncing = false;
      setTimeout(() => deps.sendMessage({ type: "CLOSE_CURRENT_TAB" }), 5000);
    }
  }

  // Listen for BEGIN_AUTO_SYNC from background.js
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "BEGIN_AUTO_SYNC") {
      sendResponse({ received: true });
      // Pass queryId from message (background.js cached it from inject.js interception)
      startAutoSync(message.queryId || null);
    }
  });
}
