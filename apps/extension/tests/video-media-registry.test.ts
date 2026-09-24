// @vitest-environment happy-dom
import { test, beforeEach } from "vitest";
import assert from "node:assert/strict";

import { registerVideoMedia, lookupVideoUrl, initVideoMediaRegistry, _resetForTests } from "../entrypoints/content/video-media-registry";

beforeEach(() => {
  _resetForTests();
});

test("lookupVideoUrl matches both poster URL forms X serves for the same image", () => {
  // The poster as it appears in X's GraphQL response (media_url_https)...
  registerVideoMedia([{ poster: "https://pbs.twimg.com/amplify_video_thumb/123/img/abc.jpg", videoUrl: "https://video.twimg.com/123/high.mp4" }]);

  // ...must resolve for the poster as it appears in the DOM (<video poster>,
  // same clean form) and for the <img> form with query params instead of an
  // extension.
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/amplify_video_thumb/123/img/abc.jpg"), "https://video.twimg.com/123/high.mp4");
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/amplify_video_thumb/123/img/abc?format=jpg&name=small"), "https://video.twimg.com/123/high.mp4");
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/amplify_video_thumb/123/img/abc?format=jpg&name=orig"), "https://video.twimg.com/123/high.mp4");
});

test("lookupVideoUrl returns undefined for an unknown poster, and registerVideoMedia ignores malformed entries", () => {
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/media/unknown.jpg"), undefined);

  registerVideoMedia([{ poster: "https://pbs.twimg.com/media/x.jpg" }, { videoUrl: "https://video.twimg.com/y.mp4" }, null, "not an object"]);
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/media/x.jpg"), undefined);

  registerVideoMedia("not an array" as unknown as unknown[]);
  registerVideoMedia(undefined);
});

test("a later registration for the same poster overwrites the earlier videoUrl", () => {
  registerVideoMedia([{ poster: "https://pbs.twimg.com/tweet_video_thumb/1.jpg", videoUrl: "https://video.twimg.com/1/old.mp4" }]);
  registerVideoMedia([{ poster: "https://pbs.twimg.com/tweet_video_thumb/1.jpg", videoUrl: "https://video.twimg.com/1/new.mp4" }]);
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/tweet_video_thumb/1.jpg"), "https://video.twimg.com/1/new.mp4");
});

test("the cache is bounded — registering well past the cap evicts the oldest entries, not the newest", () => {
  for (let i = 0; i < 800; i++) {
    registerVideoMedia([{ poster: `https://pbs.twimg.com/tweet_video_thumb/${i}.jpg`, videoUrl: `https://video.twimg.com/${i}.mp4` }]);
  }

  // Oldest (poster 0) was evicted...
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/tweet_video_thumb/0.jpg"), undefined);
  // ...but the most recent registration is still there.
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/tweet_video_thumb/799.jpg"), "https://video.twimg.com/799.mp4");
});

test("initVideoMediaRegistry learns from a NOOK_VIDEO_MEDIA postMessage and ignores other message types", () => {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const fakeWindow = {
    addEventListener: (type: string, listener: (event: MessageEvent) => void) => {
      if (type === "message") listeners.push(listener);
    }
  } as unknown as Window;

  initVideoMediaRegistry(fakeWindow);
  assert.equal(listeners.length, 1);

  listeners[0]({ source: fakeWindow, data: { type: "SOME_OTHER_MESSAGE" } } as unknown as MessageEvent);
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/tweet_video_thumb/9.jpg"), undefined);

  const message = {
    type: "NOOK_VIDEO_MEDIA",
    entries: [{ poster: "https://pbs.twimg.com/tweet_video_thumb/9.jpg", videoUrl: "https://video.twimg.com/9.mp4" }]
  };
  // Messages from another frame are ignored
  listeners[0]({ source: {}, data: message } as unknown as MessageEvent);
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/tweet_video_thumb/9.jpg"), undefined);

  listeners[0]({ source: fakeWindow, data: message } as unknown as MessageEvent);
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/tweet_video_thumb/9.jpg"), "https://video.twimg.com/9.mp4");
});

test("registerVideoMedia only accepts X's video CDN", () => {
  _resetForTests();
  registerVideoMedia([{ poster: "https://pbs.twimg.com/tweet_video_thumb/7.jpg", videoUrl: "https://evil.example/7.mp4" }]);
  assert.equal(lookupVideoUrl("https://pbs.twimg.com/tweet_video_thumb/7.jpg"), undefined);
});
