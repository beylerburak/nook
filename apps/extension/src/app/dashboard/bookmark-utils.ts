import type { Bookmark, Media } from "../../../lib/types";

export type LibraryView =
  | { kind: "all" | "x" | "chrome" | "unorganized" }
  | { kind: "list"; id: string }
  | { kind: "tag"; id: string };
export type MediaFilter = "all" | "media" | "text";
export type BookmarkViewMode = "cards" | "table";
export type LightboxState = { media: Media[]; index: number } | null;

export const DEFAULT_CARD_PAGE_SIZE = 24;
export const DEFAULT_TABLE_PAGE_SIZE = 25;
export const DEFAULT_VIEW: LibraryView = { kind: "all" };
export const LIST_EMOJIS = ["📁", "✦", "♡", "✈️", "☕", "🎨", "📚", "🌿"];

export function hasNote(item: Bookmark) {
  return Boolean(item.note?.trim());
}

export function hasMedia(item: Bookmark) {
  return Boolean(
    (item.media?.length || item.attachments?.length || 0) > 0 ||
    (item.quote?.media?.length || 0) > 0,
  );
}

export function itemMedia(item: Bookmark): Media[] {
  return item.media?.length ? item.media : item.attachments || [];
}

export function allItemMedia(item: Bookmark): Media[] {
  return [...itemMedia(item), ...(item.quote?.media || [])];
}

export function visibleText(item: Bookmark) {
  return item.description || item.shortDescription || item.title || "";
}

export function itemTitle(item: Bookmark) {
  if (item.source === "chrome") {
    return item.title || item.creator?.name || item.creator?.handle || "Web bookmark";
  }
  return item.creator?.name || item.creator?.handle || "X post";
}

export function getTags(items: Bookmark[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const rawTag of item.tags || []) {
      const tag = rawTag.trim().toLowerCase().replace(/^#/, "");
      if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

export function matchesSearch(item: Bookmark, query: string) {
  if (!query) return true;
  const normalized = query.toLowerCase();
  const prefix = normalized[0];
  const term = prefix === "@" || prefix === "#" ? normalized.slice(1) : normalized;
  if (prefix === "@") {
    return [item.creator?.name, item.creator?.handle, item.quote?.creator?.name, item.quote?.creator?.handle]
      .filter(Boolean)
      .some((value) => value!.toLowerCase().includes(term));
  }
  if (prefix === "#") {
    return (item.tags || []).some((tag) => tag.toLowerCase().replace(/^#/, "").includes(term));
  }
  const searchable = [
    item.title,
    item.shortDescription,
    item.description,
    item.note,
    item.url,
    item.urls?.join(" "),
    item.creator?.name,
    item.creator?.handle,
    item.quote?.text,
    item.quote?.creator?.name,
    item.quote?.creator?.handle,
    ...(item.tags || []),
  ].filter(Boolean).join(" ").toLowerCase();
  return searchable.includes(term);
}
