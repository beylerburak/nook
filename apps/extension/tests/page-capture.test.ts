import { test } from "vitest";
import assert from "node:assert/strict";
import { buildPageBookmarkItem, isFileUrl, isRestrictedUrl, mergeCapturedContent } from "../lib/page-capture";

test("isRestrictedUrl flags browser-internal schemes", () => {
  for (const url of [
    "chrome://extensions/",
    "chrome://newtab/",
    "edge://settings/",
    "about:blank",
    "chrome-extension://abcdefg/page.html",
    "brave://settings/",
    "javascript:void(0)",
  ]) {
    assert.equal(isRestrictedUrl(url), true, url);
  }
});

test("isRestrictedUrl flags the Chrome Web Store but not file:// (handled separately)", () => {
  assert.equal(isRestrictedUrl("https://chromewebstore.google.com/detail/foo"), true);
  assert.equal(isRestrictedUrl("https://chrome.google.com/webstore/detail/foo"), true);
  assert.equal(isRestrictedUrl("https://chrome.google.com/other"), false);
  assert.equal(isRestrictedUrl("file:///Users/me/notes.html"), false);
});

test("isRestrictedUrl allows ordinary http(s) pages", () => {
  assert.equal(isRestrictedUrl("https://example.com/article"), false);
  assert.equal(isRestrictedUrl("http://example.com"), false);
});

test("isRestrictedUrl treats an unparseable URL as restricted", () => {
  assert.equal(isRestrictedUrl("not a url"), true);
});

test("isFileUrl only matches the file: scheme", () => {
  assert.equal(isFileUrl("file:///Users/me/notes.html"), true);
  assert.equal(isFileUrl("https://example.com"), false);
  assert.equal(isFileUrl("not a url"), false);
});

test("buildPageBookmarkItem prefers metadata, falling back to the tab title then hostname", () => {
  const withMetadata = buildPageBookmarkItem({
    id: "web:1",
    source: "web",
    url: "https://example.com/article",
    metadata: { title: "Real Title", description: "Real description", siteName: "Example", image: null, iconHref: null },
    fallbackTitle: "Tab Title",
  });
  assert.equal(withMetadata.title, "Real Title");

  const withoutMetadata = buildPageBookmarkItem({
    id: "web:2",
    source: "web",
    url: "https://example.com/article",
    metadata: null,
    fallbackTitle: "Tab Title",
  });
  assert.equal(withoutMetadata.title, "Tab Title");

  const withNeither = buildPageBookmarkItem({
    id: "web:3",
    source: "web",
    url: "https://example.com/article",
    metadata: null,
  });
  assert.equal(withNeither.title, "example.com");
});

test("buildPageBookmarkItem truncates shortDescription to 180 chars but keeps full description", () => {
  const longText = "x".repeat(300);
  const item = buildPageBookmarkItem({
    id: "web:1",
    source: "web",
    url: "https://example.com",
    metadata: { title: "T", description: longText, siteName: "Example", image: null, iconHref: null },
  });
  assert.equal(item.shortDescription!.length, 180);
  assert.equal(item.description, longText);
});

test("buildPageBookmarkItem turns og:image into a single media/attachments entry", () => {
  const item = buildPageBookmarkItem({
    id: "web:1",
    source: "web",
    url: "https://example.com",
    metadata: { title: "T", description: "", siteName: "Example", image: "https://example.com/og.png", iconHref: null },
  });
  assert.deepEqual(item.media, [{ type: "image", url: "https://example.com/og.png", alt: "T" }]);
  assert.equal(item.attachments, item.media);
});

test("buildPageBookmarkItem's mediaOverride wins over metadata.image (Save image to Nook)", () => {
  const item = buildPageBookmarkItem({
    id: "web:1",
    source: "web",
    url: "https://example.com",
    metadata: { title: "T", description: "", siteName: "Example", image: "https://example.com/og.png", iconHref: null },
    mediaOverride: [{ type: "image", url: "https://example.com/right-clicked.png", alt: "picked" }],
  });
  assert.deepEqual(item.media, [{ type: "image", url: "https://example.com/right-clicked.png", alt: "picked" }]);
});

test("buildPageBookmarkItem's avatar falls back from metadata icon to favIconUrl to a favicon service", () => {
  const withIcon = buildPageBookmarkItem({
    id: "1",
    source: "web",
    url: "https://example.com",
    metadata: { title: "T", description: "", siteName: "", image: null, iconHref: "https://example.com/icon.png" },
  });
  assert.equal(withIcon.creator?.avatar, "https://example.com/icon.png");

  const withFavIcon = buildPageBookmarkItem({
    id: "2",
    source: "web",
    url: "https://example.com",
    metadata: null,
    favIconUrl: "https://example.com/favicon.ico",
  });
  assert.equal(withFavIcon.creator?.avatar, "https://example.com/favicon.ico");

  const withNeither = buildPageBookmarkItem({ id: "3", source: "web", url: "https://example.com", metadata: null });
  assert.equal(withNeither.creator?.avatar, "https://www.google.com/s2/favicons?domain=example.com&sz=128");
});

test("buildPageBookmarkItem defaults tags to ['web'] unless overridden", () => {
  const item = buildPageBookmarkItem({ id: "1", source: "web", url: "https://example.com", metadata: null });
  assert.deepEqual(item.tags, ["web"]);

  const tagged = buildPageBookmarkItem({ id: "1", source: "web", url: "https://example.com", metadata: null, tags: ["custom"] });
  assert.deepEqual(tagged.tags, ["custom"]);
});

test("mergeCapturedContent refreshes captured content but keeps the user's organization and restores it", () => {
  const existing = {
    id: "web:1",
    source: "web",
    title: "Old title",
    note: "my note",
    tags: ["research"],
    listId: "list-1",
    listName: "Reading",
    createdAt: "2024-01-01T00:00:00.000Z",
    deletedAt: "2024-02-01T00:00:00.000Z",
  };
  const captured = {
    id: "web:new",
    source: "web",
    title: "New title",
    tags: ["web"],
    listId: null,
    listName: null,
    url: "https://example.com",
    createdAt: "2025-01-01T00:00:00.000Z",
  };

  const merged = mergeCapturedContent(existing, captured);

  assert.equal(merged.id, "web:1");
  assert.equal(merged.title, "New title");
  assert.equal(merged.url, "https://example.com");
  assert.equal(merged.note, "my note");
  assert.deepEqual(merged.tags, ["research"]);
  assert.equal(merged.listId, "list-1");
  assert.equal(merged.listName, "Reading");
  assert.equal(merged.createdAt, "2024-01-01T00:00:00.000Z");
  assert.equal(merged.deletedAt, null);
});
