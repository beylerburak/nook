// @vitest-environment happy-dom
import { test } from "vitest";
import assert from "node:assert/strict";

import { extractMedia, parseQuoteBox, mediaKey } from "../entrypoints/content/tweet-dom";

test("mediaKey normalizes both poster URL forms X serves for the same image to the same key", () => {
  assert.equal(mediaKey("https://pbs.twimg.com/amplify_video_thumb/1/img/abc.jpg"), mediaKey("https://pbs.twimg.com/amplify_video_thumb/1/img/abc?format=jpg&name=small"));
});

test("extractMedia attaches videoUrl (from the lookup) to a <video poster> entry", () => {
  const article = document.createElement("article");
  const video = document.createElement("video");
  video.setAttribute("poster", "https://pbs.twimg.com/amplify_video_thumb/42/img/poster.jpg");
  article.appendChild(video);

  // The lookup receives an already mediaKey()'d poster (extension stripped), same as the registry expects.
  const lookupVideoUrl = (poster: string) =>
    poster === mediaKey("https://pbs.twimg.com/amplify_video_thumb/42/img/poster.jpg") ? "https://video.twimg.com/42/high.mp4" : undefined;

  const media = extractMedia(article, null, lookupVideoUrl);
  assert.equal(media.length, 1);
  assert.equal(media[0].type, "video");
  assert.equal(media[0].url, "https://pbs.twimg.com/amplify_video_thumb/42/img/poster.jpg");
  assert.equal(media[0].videoUrl, "https://video.twimg.com/42/high.mp4");
});

test("extractMedia attaches videoUrl to an <img src=video_thumb/> entry using the same lookup", () => {
  const article = document.createElement("article");
  const img = document.createElement("img");
  img.setAttribute("src", "https://pbs.twimg.com/tweet_video_thumb/7?format=jpg&name=small");
  article.appendChild(img);

  const lookupVideoUrl = (poster: string) => {
    // The lookup always receives an already-normalized (mediaKey'd) poster.
    assert.equal(poster, mediaKey("https://pbs.twimg.com/tweet_video_thumb/7?format=jpg&name=small"));
    return "https://video.twimg.com/7.mp4";
  };

  const media = extractMedia(article, null, lookupVideoUrl);
  assert.equal(media.length, 1);
  assert.equal(media[0].type, "video");
  assert.equal(media[0].videoUrl, "https://video.twimg.com/7.mp4");
});

test("extractMedia never attaches videoUrl to a plain photo, and omits the field entirely when the lookup has nothing", () => {
  const article = document.createElement("article");
  const img = document.createElement("img");
  img.setAttribute("src", "https://pbs.twimg.com/media/photo.jpg");
  article.appendChild(img);

  const media = extractMedia(article, null, () => "https://video.twimg.com/should-not-be-used.mp4");
  assert.equal(media[0].type, "image");
  assert.equal("videoUrl" in media[0], false);

  const video = document.createElement("video");
  video.setAttribute("poster", "https://pbs.twimg.com/amplify_video_thumb/99/img/poster.jpg");
  article.appendChild(video);
  const noLookupMedia = extractMedia(article);
  const videoEntry = noLookupMedia.find((m) => m.type === "video")!;
  assert.equal("videoUrl" in videoEntry, false, "no lookup passed → no videoUrl, same as before this feature");
});

test("parseQuoteBox threads the lookup through to the quoted tweet's media too", () => {
  const box = document.createElement("div");
  const userName = document.createElement("div");
  userName.setAttribute("data-testid", "User-Name");
  userName.textContent = "Quoted User\n@quoteduser";
  box.appendChild(userName);

  const video = document.createElement("video");
  video.setAttribute("poster", "https://pbs.twimg.com/amplify_video_thumb/55/img/poster.jpg");
  box.appendChild(video);

  const lookupVideoUrl = (poster: string) =>
    poster === mediaKey("https://pbs.twimg.com/amplify_video_thumb/55/img/poster.jpg") ? "https://video.twimg.com/55/high.mp4" : undefined;

  const quote = parseQuoteBox(box, lookupVideoUrl);
  assert.equal(quote.media?.[0]?.type, "video");
  assert.equal(quote.media?.[0]?.videoUrl, "https://video.twimg.com/55/high.mp4");
});
