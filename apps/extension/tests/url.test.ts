import { test } from "vitest";
import assert from "node:assert/strict";
import { extractXStatusId, isXPostUrl, normalizeUrlForDedupe, xBookmarkIdForUrl } from "../lib/url";

test("normalizeUrlForDedupe strips the hash", () => {
  assert.equal(
    normalizeUrlForDedupe("https://example.com/article#section-2"),
    "https://example.com/article"
  );
});

test("normalizeUrlForDedupe strips common tracking params", () => {
  const url =
    "https://example.com/post?utm_source=twitter&utm_medium=social&fbclid=abc123&gclid=xyz&ref_src=share";
  assert.equal(normalizeUrlForDedupe(url), "https://example.com/post");
});

test("normalizeUrlForDedupe keeps meaningful query params", () => {
  assert.equal(
    normalizeUrlForDedupe("https://example.com/watch?v=abc123&utm_source=x"),
    "https://example.com/watch?v=abc123"
  );
});

test("normalizeUrlForDedupe sorts remaining params so order never causes a mismatch", () => {
  const a = normalizeUrlForDedupe("https://example.com/search?b=2&a=1");
  const b = normalizeUrlForDedupe("https://example.com/search?a=1&b=2");
  assert.equal(a, b);
});

test("normalizeUrlForDedupe is a no-op for a URL with nothing to strip", () => {
  assert.equal(
    normalizeUrlForDedupe("https://example.com/page?id=42"),
    "https://example.com/page?id=42"
  );
});

test("normalizeUrlForDedupe falls back to the trimmed input for an unparseable URL", () => {
  assert.equal(normalizeUrlForDedupe("  not a url  "), "not a url");
});

test("extractXStatusId reads the status id from x.com and twitter.com URLs", () => {
  assert.equal(extractXStatusId("https://x.com/nook/status/1234567890"), "1234567890");
  assert.equal(extractXStatusId("https://twitter.com/nook/status/42"), "42");
  assert.equal(extractXStatusId("https://www.x.com/nook/status/42"), "42");
});

test("extractXStatusId ignores query strings and trailing path segments", () => {
  assert.equal(extractXStatusId("https://x.com/nook/status/42?s=20"), "42");
  assert.equal(extractXStatusId("https://x.com/nook/status/42/photo/1"), "42");
});

test("extractXStatusId returns null for non-status X URLs and non-X hosts", () => {
  assert.equal(extractXStatusId("https://x.com/nook"), null);
  assert.equal(extractXStatusId("https://x.com/i/bookmarks"), null);
  assert.equal(extractXStatusId("https://example.com/nook/status/42"), null);
  assert.equal(extractXStatusId("not a url"), null);
});

test("isXPostUrl / xBookmarkIdForUrl agree with extractXStatusId", () => {
  const url = "https://x.com/nook/status/999";
  assert.equal(isXPostUrl(url), true);
  assert.equal(xBookmarkIdForUrl(url), "x:999");

  const nonPost = "https://x.com/nook";
  assert.equal(isXPostUrl(nonPost), false);
  assert.equal(xBookmarkIdForUrl(nonPost), null);
});
