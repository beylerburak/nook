import type { XApiNode, XApiResponse } from "./types";

type XRecord = XApiNode & Record<string, any>;
interface ParseDiagnostic {
  valid: boolean;
  timelineKey: string | null;
  entryCount: number;
  tweetEntryCount: number;
  tweetCount: number;
  hasBottomCursor: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Nook X Parser Module
 *
 * Pure, standalone parser for X's (Twitter) GraphQL API responses.
 * Works both in Node.js (via require/import for tests & server-side) and
 * in Chrome Extension (via globalThis.NookXParser in content scripts).
 */



  /**
   * Unwraps TweetWithVisibilityResults wrapper when present.
   * X often wraps protected or moderated tweets with this type.
   */
  function unwrapTweetResult(result: XRecord | null | undefined): XRecord | null {
    if (!result) return null;
    return result.__typename === "TweetWithVisibilityResults" ? result.tweet ?? null : result;
  }

  /**
   * Cleans and normalizes tweet text:
   * 1. Uses note_tweet text (longform) if present.
   * 2. Falls back to legacy full_text sliced by display_text_range (stripping trailing media t.co links).
   * 3. Unescapes HTML entities (&amp;, &lt;, &gt;).
   */
  function cleanTweetText(tweet: XRecord | null | undefined): string {
    if (!tweet) return "";
    let text = tweet.note_tweet?.note_tweet_results?.result?.text || "";

    if (!text && tweet.legacy) {
      text = tweet.legacy.full_text || tweet.legacy.text || "";
      const range = tweet.legacy.display_text_range;
      if (Array.isArray(range) && range.length === 2) {
        text = Array.from(text).slice(range[0], range[1]).join("");
      }
    }

    return text
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();
  }

  /**
   * Picks the highest-bitrate MP4 from a video's variants. The other variants
   * are HLS playlists (.m3u8) that a plain <video> element can't play.
   */
  function pickVideoUrl(videoInfo: XRecord | null | undefined): string | null {
    const variants = Array.isArray(videoInfo?.variants) ? videoInfo.variants : [];
    let best: XRecord | null = null;
    for (const v of variants) {
      if (v?.content_type !== "video/mp4" || !v.url) continue;
      if (!best || (v.bitrate ?? 0) > (best.bitrate ?? 0)) best = v;
    }
    return best?.url ?? null;
  }

  /**
   * Generic best-effort scan for video/GIF media anywhere in an X GraphQL
   * JSON response — HomeTimeline, TweetDetail, UserTweets, SearchTimeline,
   * etc., not just Bookmarks. X nests tweets differently per surface, so
   * rather than following a known shape this walks every object looking for
   * the `media_url_https` + `video_info` pair that marks a video/GIF media
   * entity, wherever it lives (top-level tweet, quoted tweet, retweet, …).
   * Iterative (no recursion) since responses can nest deeply; walking
   * already-parsed JSON is cheap next to the network request that produced
   * it, and nothing is posted/copied besides the small {poster, videoUrl}
   * pairs found.
   */
  function extractVideoMediaEntries(input: unknown): Array<{ poster: string; videoUrl: string }> {
    const entries: Array<{ poster: string; videoUrl: string }> = [];
    if (!input || typeof input !== "object") return entries;

    const seenPosters = new Set<string>();
    const stack: unknown[] = [input];

    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;

      if (Array.isArray(node)) {
        for (const child of node) stack.push(child);
        continue;
      }

      const record = node as XRecord;
      if (typeof record.media_url_https === "string" && record.video_info && typeof record.video_info === "object") {
        const poster = record.media_url_https;
        if (!seenPosters.has(poster)) {
          const videoUrl = pickVideoUrl(record.video_info as XRecord);
          if (videoUrl) {
            seenPosters.add(poster);
            entries.push({ poster, videoUrl });
          }
        }
        // A media entity's own fields (video_info variants, etc.) don't nest
        // further tweets/media, so no need to descend into it.
        continue;
      }

      for (const key in record) {
        if (Object.prototype.hasOwnProperty.call(record, key)) stack.push(record[key]);
      }
    }

    return entries;
  }

  /**
   * Parses media items from tweet entities / extended_entities
   */
  type ParsedMedia = { type: "image" | "video"; url: string; alt: string; videoUrl?: string };

  function parseTweetMedia(legacy: XRecord | null | undefined): ParsedMedia[] {
    const media: ParsedMedia[] = [];
    if (!legacy) return media;

    const mediaEntities = legacy.extended_entities?.media || legacy.entities?.media || [];
    for (const m of mediaEntities) {
      if (!m || !m.media_url_https) continue;

      if (m.type === "photo") {
        media.push({
          type: "image",
          url: m.media_url_https,
          alt: m.ext_alt_text || ""
        });
      } else if (m.type === "video" || m.type === "animated_gif") {
        // `url` stays the poster image so every thumbnail renderer keeps working;
        // `videoUrl` is the playable file.
        const videoUrl = pickVideoUrl(m.video_info);
        media.push({
          type: "video",
          url: m.media_url_https,
          alt: m.ext_alt_text || (m.type === "animated_gif" ? "GIF" : "Video"),
          ...(videoUrl ? { videoUrl } : {})
        });
      }
    }
    return media;
  }

  /**
   * Parses a single GraphQL tweet result (used for both bookmarked and quoted tweets).
   */
  function parseGraphQLTweet(result: XRecord | null | undefined): XRecord | null {
    const tweet = unwrapTweetResult(result);
    if (!tweet?.legacy) return null;

    // X moved name/screen_name to user.core and avatar to user.avatar;
    // older responses keep them under user.legacy.
    const userResult = tweet.core?.user_results?.result;
    if (!userResult) return null;
    const userCore = userResult.core ?? {};
    const userLegacy = userResult.legacy ?? {};
    const legacy = tweet.legacy;

    const screenName = userCore.screen_name || userLegacy.screen_name;
    const statusId = tweet.rest_id || legacy.id_str;
    if (!screenName || !statusId) return null;

    const text = cleanTweetText(tweet);
    const media = parseTweetMedia(legacy);

    return {
      statusId,
      text,
      media,
      url: `https://x.com/${screenName}/status/${statusId}`,
      creator: {
        name: userCore.name || userLegacy.name || screenName,
        handle: `@${screenName}`,
        avatar: userResult.avatar?.image_url || userLegacy.profile_image_url_https || null
      },
      createdAt: legacy.created_at ? new Date(legacy.created_at).toISOString() : null
    };
  }

  /**
   * Extracts bottom cursor from GraphQL timeline response for pagination.
   */
  function extractBottomCursor(input: unknown): string | null {
    const data = input as XApiResponse | XRecord | null | undefined;
    try {
      const timeline =
        data?.data?.bookmark_timeline_v2?.timeline ||
        data?.data?.bookmark_timeline?.timeline ||
        data?.data?.bookmarks?.timeline ||
        null;

      const instructions = timeline?.instructions || [];
      for (const inst of instructions) {
        const entries = inst.entries || (inst.entry ? [inst.entry] : []);
        for (const entry of entries) {
          const content = entry?.content;
          if (content?.entryType === "TimelineTimelineCursor" && content?.cursorType === "Bottom") {
            return content.value || null;
          }
          // Nested cursor inside TimelineTimelineModule
          if (content?.items) {
            for (const item of content.items) {
              const ic = item?.item?.itemContent;
              if (ic?.itemType === "TimelineTimelineCursor" && ic?.cursorType === "Bottom") {
                return ic.value || null;
              }
            }
          }
        }
      }
    } catch (_) {}
    return null;
  }

  /**
   * Parses GraphQL Bookmarks API response into normalized Nook bookmark items.
   */
  function parseGraphQLBookmarks(input: unknown): XRecord[] {
    const data = input as XApiResponse | XRecord | null | undefined;
    const parsedItems: XRecord[] = [];
    if (!data || typeof data !== "object") return parsedItems;

    try {
      const timeline =
        data?.data?.bookmark_timeline_v2?.timeline ||
        data?.data?.bookmark_timeline?.timeline ||
        data?.data?.bookmarks?.timeline ||
        null;

      if (!timeline) return parsedItems;

      const instructions = timeline.instructions || [];
      const allEntries = [];
      for (const inst of instructions) {
        if (Array.isArray(inst.entries)) allEntries.push(...inst.entries);
        if (inst.entry) allEntries.push(inst.entry);
      }

      for (const entry of allEntries) {
        const entryId = entry?.entryId ?? "";
        if (!entryId.startsWith("tweet-") && !entryId.includes("bookmark")) continue;

        const content = entry.content ?? entry.item?.content;
        if (!content) continue;

        const itemContent = content.itemContent ?? content;
        const tweetResult = itemContent?.tweet_results?.result;
        if (!tweetResult) continue;

        const tweet = parseGraphQLTweet(tweetResult);
        if (!tweet) continue;

        // Handle quoted tweet if present
        const quotedResult = unwrapTweetResult(tweetResult)?.quoted_status_result?.result;
        const quote = quotedResult ? parseGraphQLTweet(quotedResult) : null;

        parsedItems.push({
          id: `x:${tweet.statusId}`,
          source: "x",
          xSortIndex: typeof entry.sortIndex === "string" ? entry.sortIndex : undefined,
          title: `${tweet.creator.handle}: ${(tweet.text ?? "").slice(0, 100)}`,
          shortDescription: (tweet.text ?? "").slice(0, 180),
          description: tweet.text,
          category: null,
          tags: [],
          media: tweet.media,
          attachments: tweet.media,
          urls: [tweet.url],
          url: tweet.url,
          creator: tweet.creator,
          quote: quote
            ? {
                id: `x:${quote.statusId}`,
                url: quote.url,
                text: quote.text,
                creator: quote.creator,
                media: quote.media,
                createdAt: quote.createdAt
              }
            : null,
          createdAt: tweet.createdAt,
          savedAt: new Date().toISOString()
        });
      }
    } catch (err) {
      if (typeof console !== "undefined" && console.error) {
        console.error("[Nook X Parser] Error in parseGraphQLBookmarks:", err);
      }
    }

    return parsedItems;
  }

  /**
   * Diagnoses X GraphQL response to detect schema changes, API errors, or unexpected formats.
   */
  function diagnoseGraphQLResponse(input: unknown): ParseDiagnostic {
    const data = input as XApiResponse | XRecord | null | undefined;
    const result = {
      valid: false,
      timelineKey: null as string | null,
      entryCount: 0,
      tweetEntryCount: 0,
      tweetCount: 0,
      hasBottomCursor: false,
      errors: [] as string[],
      warnings: [] as string[]
    };

    if (!data || typeof data !== "object") {
      result.errors.push("Response data is null or not an object");
      return result;
    }

    if (Array.isArray(data.errors) && data.errors.length > 0) {
      for (const err of data.errors) {
        result.errors.push(err.message || JSON.stringify(err));
      }
    }

    if (!data.data || typeof data.data !== "object") {
      result.errors.push("Missing 'data' field in response");
      return result;
    }

    const timelineKeys = ["bookmark_timeline_v2", "bookmark_timeline", "bookmarks"];
    let timeline = null;
    for (const key of timelineKeys) {
      if (data.data[key]?.timeline) {
        result.timelineKey = key;
        timeline = data.data[key].timeline;
        break;
      }
    }

    if (!timeline) {
      const presentKeys = Object.keys(data.data);
      result.warnings.push(
        `No known timeline found under 'data'. Present keys: [${presentKeys.join(", ")}]`
      );
      return result;
    }

    const instructions = timeline.instructions || [];
    if (!Array.isArray(instructions) || instructions.length === 0) {
      result.warnings.push("Timeline instructions array is empty or missing");
      return result;
    }

    const allEntries = [];
    for (const inst of instructions) {
      if (Array.isArray(inst.entries)) allEntries.push(...inst.entries);
      if (inst.entry) allEntries.push(inst.entry);
    }
    result.entryCount = allEntries.length;

    // Mirror the entry filter used in parseGraphQLBookmarks so we can tell
    // "no tweet-like entries on this page" (normal end-of-list / cursor-only
    // page) apart from "tweet-like entries present but none could be parsed"
    // (schema likely changed).
    result.tweetEntryCount = allEntries.filter((entry) => {
      const entryId = entry?.entryId ?? "";
      return entryId.startsWith("tweet-") || entryId.includes("bookmark");
    }).length;

    const parsed = parseGraphQLBookmarks(data);
    result.tweetCount = parsed.length;

    const cursor = extractBottomCursor(data);
    result.hasBottomCursor = Boolean(cursor);

    if (result.tweetEntryCount > 0 && result.tweetCount === 0) {
      result.warnings.push(
        "Tweet-like entries were present but none could be parsed. Schema may have changed."
      );
    } else if (result.tweetCount < result.tweetEntryCount) {
      result.warnings.push(
        `Only ${result.tweetCount} of ${result.tweetEntryCount} tweet-like entries could be parsed. Some entries may be unparseable due to a partial schema change.`
      );
    }

    result.valid =
      result.errors.length === 0 &&
      !(result.tweetEntryCount > 0 && result.tweetCount === 0) &&
      (result.tweetCount > 0 || result.hasBottomCursor || result.tweetEntryCount === 0);
    return result;
  }

export {
  unwrapTweetResult,
  cleanTweetText,
  pickVideoUrl,
  parseTweetMedia,
  parseGraphQLTweet,
  extractBottomCursor,
  parseGraphQLBookmarks,
  diagnoseGraphQLResponse,
  extractVideoMediaEntries
};
