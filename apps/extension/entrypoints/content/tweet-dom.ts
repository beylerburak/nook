import type { Bookmark, Media, Quote } from "../../lib/types";

/** querySelectorAll that skips matches inside `exclude` (e.g. the quoted tweet box). */
export function queryAllOutside(root: Element, selector: string, exclude: Element | null = null): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(selector)].filter((el) => !exclude || !exclude.contains(el));
}

export function queryOutside(root: Element, selector: string, exclude: Element | null = null): HTMLElement | null {
  return queryAllOutside(root, selector, exclude)[0] || null;
}

/** The quoted tweet is rendered as a clickable div[role="link"] with its own User-Name. */
export function findQuoteBox(article: Element): HTMLElement | null {
  return (
    ([...article.querySelectorAll('div[role="link"]')].find((el) =>
      el.querySelector('[data-testid="User-Name"]')
    ) as HTMLElement | undefined) || null
  );
}

/**
 * Dedupe key for a pbs.twimg.com image: X serves the same poster as both
 * `…/abc.jpg` (video poster) and `…/abc?format=jpg&name=small` (<img>).
 * Also used (see video-media-registry.ts) to key the poster->MP4 cache, so
 * both DOM forms of the same poster resolve to the same lookup.
 */
export function mediaKey(src: string): string {
  return src.split("?")[0].replace(/\.(jpe?g|png|webp)$/i, "");
}

/** Looks up the playable MP4 for a video poster, learned from X's own GraphQL responses (see video-media-registry.ts). */
export type VideoUrlLookup = (poster: string) => string | undefined;

export function extractMedia(
  article: Element,
  exclude: Element | null = null,
  lookupVideoUrl?: VideoUrlLookup
): Media[] {
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

    const baseId = mediaKey(src);
    if (!seenUrls.has(baseId)) {
      seenUrls.add(baseId);
      const isVideo = /video_thumb\//.test(src);
      // baseId is already mediaKey(src), so it's safe to look up directly.
      const videoUrl = isVideo ? lookupVideoUrl?.(baseId) : undefined;
      media.push({
        type: isVideo ? "video" : "image",
        url: src,
        alt: img.getAttribute("alt") || "",
        ...(videoUrl ? { videoUrl } : {})
      });
    }
  }

  // 2. Video / GIF poster thumbnail
  const videos = queryAllOutside(article, "video", exclude);
  for (const video of videos) {
    const poster = video.getAttribute("poster") || (video as HTMLVideoElement).poster;
    if (poster) {
      const baseId = mediaKey(poster);
      if (!seenUrls.has(baseId)) {
        seenUrls.add(baseId);
        const videoUrl = lookupVideoUrl?.(baseId);
        media.push({
          type: "video",
          url: poster,
          alt: "Video thumbnail",
          ...(videoUrl ? { videoUrl } : {})
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
      const baseId = mediaKey(src);
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

export function extractAvatar(root: Element, exclude: Element | null = null): string | null {
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

export function parseUserName(userElement: HTMLElement | null): { handle: string | null; name: string | null } {
  const lines = (userElement?.innerText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    handle: lines.find((line) => line.startsWith("@")) || null,
    name: lines.find((line) => !line.startsWith("@") && line !== "·") || null
  };
}

export function parseQuoteBox(box: HTMLElement, lookupVideoUrl?: VideoUrlLookup): Quote {
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
    media: extractMedia(box, null, lookupVideoUrl),
    createdAt: box.querySelector("time")?.getAttribute("datetime") || null
  };
}

export function extractTweetUrl(
  article: Element,
  timeElement: Element | null,
  handle: string | null,
  exclude: Element | null = null
): string | null {
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

export function parseTweet(article: Element, lookupVideoUrl?: VideoUrlLookup): Bookmark {
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

  const media = extractMedia(article, quoteBox, lookupVideoUrl);
  const avatar = extractAvatar(article, quoteBox);
  const quote = quoteBox ? parseQuoteBox(quoteBox, lookupVideoUrl) : null;

  return {
    id: `x:${statusId}`,

    source: "x",

    title: handle ? `${handle}: ${text.slice(0, 100)}` : text.slice(0, 100),

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
