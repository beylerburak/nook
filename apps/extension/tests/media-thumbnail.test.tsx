// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MediaThumbnail } from "../src/app/components/MediaThumbnail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("MediaThumbnail", () => {
  it("shows the video indicator badge and a Video hint for video media", () => {
    act(() => {
      root.render(
        <MediaThumbnail
          mediaType="video"
          src="https://example.com/poster.jpg"
          alt="A cat"
          label="A cat"
        />,
      );
    });

    expect(container.querySelector(".nook-media-thumbnail-badge")).not.toBeNull();
    // The accessible name (role=group aria-label) gets the "Video" hint since
    // neither alt nor label mentioned it.
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-label")).toMatch(/video/i);
  });

  it("does not duplicate the hint when the text already says Video", () => {
    act(() => {
      root.render(
        <MediaThumbnail
          mediaType="video"
          src="https://example.com/poster.jpg"
          alt="Video preview 1"
          label="Video preview 1"
        />,
      );
    });

    // The <img alt> reflects our resolved `alt` directly (unlike the group's
    // aria-label, which Thumbnail may combine with `label` on its own) — the
    // hint must not be prepended twice onto a value that already has it.
    const img = container.querySelector("img");
    expect(img?.getAttribute("alt")?.match(/video/gi)?.length).toBe(1);
  });

  it("renders no video badge for image media", () => {
    act(() => {
      root.render(
        <MediaThumbnail
          mediaType="image"
          src="https://example.com/photo.jpg"
          alt="A photo"
          label="A photo"
        />,
      );
    });

    expect(container.querySelector(".nook-media-thumbnail-badge")).toBeNull();
    const group = container.querySelector('[role="group"]');
    expect(group?.getAttribute("aria-label")).not.toMatch(/video/i);
  });
});
