import type { ParseFocalTweetResponse } from "../../lib/types";
import { parseTweet } from "./tweet-dom";

/** True when `href` is a status permalink for exactly `statusId` (not just a numeric prefix match). */
function linkMatchesStatusId(href: string, statusId: string): boolean {
  const match = href.match(/\/status\/(\d+)/);
  return match?.[1] === statusId;
}

/** The focal tweet on a status page (x.com/<user>/status/<id>) is the article carrying a permalink to that same id. */
export function findFocalTweetArticle(statusId: string, doc: Document = document): Element | null {
  const articles = Array.from(doc.querySelectorAll('article[data-testid="tweet"]'));
  return (
    articles.find((article) =>
      Array.from(article.querySelectorAll<HTMLAnchorElement>('a[href*="/status/"]')).some((a) =>
        linkMatchesStatusId(a.getAttribute("href") || a.href, statusId)
      )
    ) || null
  );
}

/** Handles PARSE_FOCAL_TWEET: parse the focal tweet on the current status page, reusing tweet-dom's parseTweet. */
export function parseFocalTweet(doc: Document = document): ParseFocalTweetResponse {
  const statusId = doc.location.pathname.match(/\/status\/(\d+)/)?.[1];
  if (!statusId) return { success: false, error: "Not on a post page" };

  const article = findFocalTweetArticle(statusId, doc);
  if (!article) return { success: false, error: "Could not find this post on the page" };

  try {
    return { success: true, item: parseTweet(article) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}
