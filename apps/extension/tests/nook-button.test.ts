// @vitest-environment happy-dom
import { test, vi } from "vitest";
import assert from "node:assert/strict";

import {
  createNookButtonController,
  findActionBar,
  renderNookButton,
  type NookButtonControllerDeps
} from "../entrypoints/content/nook-button";
import {
  buildActionBar,
  buildActionSlot,
  buildDetailActionBar,
  buildFeedActionBarWithBookmark,
  buildFeedActionBarWithoutBookmark,
  buildTweetArticle
} from "./helpers/x-dom-fixtures";
import type { Bookmark, ContentToBackgroundMessage, MessageResponse } from "../lib/types";

function mockDeps(overrides: Partial<NookButtonControllerDeps> = {}): NookButtonControllerDeps {
  return {
    parseTweet: vi.fn(
      (article: Element): Bookmark => {
        const statusId = (article as HTMLElement).dataset.statusId ?? "0";
        return {
          id: `x:${statusId}`,
          source: "x",
          url: `https://x.com/testuser/status/${statusId}`,
          title: `Tweet ${statusId}`
        };
      }
    ),
    sendMessage: vi.fn(async (_message: ContentToBackgroundMessage): Promise<MessageResponse> => ({ success: true })),
    isExtensionValid: () => true,
    notify: vi.fn(),
    ...overrides
  };
}

/** The Nook slot is the group's direct child that wraps the injected button. */
function findNookSlot(group: Element, button: Element): Element {
  const slot = Array.from(group.children).find((child) => child.contains(button));
  assert.ok(slot, "Nook button should live inside one of the action bar's direct children");
  return slot!;
}

const barVariants: Array<[string, (doc: Document) => HTMLElement]> = [
  ["feed action bar (with bookmark, trailing div)", buildFeedActionBarWithBookmark],
  ["detail action bar (bookmark as its own slot)", buildDetailActionBar],
  ["feed action bar without a bookmark action", buildFeedActionBarWithoutBookmark]
];

for (const [label, buildBar] of barVariants) {
  test(`installs a clean Nook slot right before the bar's last child — ${label}`, () => {
    const bar = buildBar(document);
    const article = buildTweetArticle(document, bar, "123");
    document.body.appendChild(article);

    const originalLastChild = bar.lastElementChild!;
    const originalChildCount = bar.children.length;

    const controller = createNookButtonController(mockDeps());
    controller.installNookButtons(article);

    const button = article.querySelector<HTMLElement>('[data-nook-action="true"]');
    assert.ok(button, "Nook button was not installed");
    const slot = findNookSlot(bar, button!);

    // Inserted as its own slot, directly before the bar's original last child.
    assert.equal(bar.children.length, originalChildCount + 1);
    assert.equal(bar.lastElementChild, originalLastChild);
    assert.equal(Array.from(bar.children).indexOf(slot), Array.from(bar.children).indexOf(originalLastChild) - 1);

    // No X ids/testids leaked onto the clone.
    assert.equal(slot.hasAttribute("id"), false);
    assert.equal(slot.hasAttribute("data-testid"), false);
    assert.equal(slot.querySelectorAll("[id], [data-testid]").length, 0);

    // The reply count was stripped along with everything else off the icon path.
    assert.equal(slot.querySelector(".count"), null);

    // Hover circle and color container are preserved and marked for the CSS to target.
    const hoverEl = slot.querySelector("[data-nook-hover]");
    assert.ok(hoverEl, "hover circle was not marked");
    assert.ok(hoverEl!.classList.contains("hover-circle"));

    const colorEl = slot.querySelector<HTMLElement>("[data-nook-color]");
    assert.ok(colorEl, "color container was not marked");
    // Resting color comes from the first non-stateful, non-hovered X action (reply itself).
    assert.equal(colorEl!.style.color, "rgb(113, 118, 123)");
  });
}

test("installNookButtons is idempotent", () => {
  const article = buildTweetArticle(document, buildDetailActionBar(document), "555");
  document.body.appendChild(article);

  const controller = createNookButtonController(mockDeps());
  controller.installNookButtons(article);
  controller.installNookButtons(article);

  assert.equal(article.querySelectorAll('[data-nook-action="true"]').length, 1);
});

test("skips tweets whose action bar has no reply action", () => {
  const barWithoutReply = buildActionBar(document, [
    buildActionSlot(document, { testId: "retweet", count: 1 }),
    buildActionSlot(document, { testId: "like", count: 1 })
  ]);
  const article = buildTweetArticle(document, barWithoutReply, "999");
  document.body.appendChild(article);

  createNookButtonController(mockDeps()).installNookButtons(article);

  assert.equal(article.querySelector('[data-nook-action="true"]'), null);
});

test("skips tweets with no action bar at all", () => {
  const article = buildTweetArticle(document, null, "888");
  document.body.appendChild(article);

  createNookButtonController(mockDeps()).installNookButtons(article);

  assert.equal(article.querySelector('[data-nook-action="true"]'), null);
});

test("findActionBar resolves the role=group that holds the reply action", () => {
  const bar = buildDetailActionBar(document);
  const article = buildTweetArticle(document, bar, "42");
  assert.equal(findActionBar(article), bar);
});

test("renderNookButton toggles aria-pressed, aria-label and title", () => {
  const button = document.createElement("button");
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  button.appendChild(svg);

  renderNookButton(button, false);
  assert.equal(button.getAttribute("aria-pressed"), "false");
  assert.equal(button.getAttribute("aria-label"), "Save to Nook");
  assert.equal(button.title, "Save to Nook");

  renderNookButton(button, true);
  assert.equal(button.getAttribute("aria-pressed"), "true");
  assert.equal(button.getAttribute("aria-label"), "Saved to Nook");
  assert.equal(button.title, "Saved to Nook");
});

test("clicking re-parses the tweet instead of trusting the install-time cache", async () => {
  const article = buildTweetArticle(document, buildFeedActionBarWithBookmark(document), "111");
  document.body.appendChild(article);

  // Starts as tweet 111; flipped to 222 below to simulate X reusing this
  // article's DOM node for a different tweet after the Nook button was installed.
  let liveStatusId = "111";
  const parseTweet = vi.fn(
    (): Bookmark => ({
      id: `x:${liveStatusId}`,
      source: "x",
      url: `https://x.com/testuser/status/${liveStatusId}`,
      title: `Tweet ${liveStatusId}`
    })
  );
  const sendMessage = vi.fn(
    async (_message: ContentToBackgroundMessage): Promise<MessageResponse> => ({ success: true, saved: true })
  );

  const controller = createNookButtonController(mockDeps({ parseTweet, sendMessage }));
  const observer = controller.init(document);

  const button = article.querySelector<HTMLElement>('[data-nook-action="true"]');
  assert.ok(button);
  assert.equal(parseTweet.mock.calls.length, 1, "should parse once at install time");

  liveStatusId = "222";
  button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  // installNookButtons's own GET_NOOK_BOOKMARK_STATES call (fired during init's
  // initial scan) also goes through sendMessage, so find the toggle call specifically.
  await vi.waitFor(() => {
    const toggled = sendMessage.mock.calls.some(([message]) => message.type === "TOGGLE_NOOK_BOOKMARK");
    assert.ok(toggled);
  });

  observer.disconnect();

  const toggleMessage = sendMessage.mock.calls.map(([message]) => message).find(
    (message): message is Extract<ContentToBackgroundMessage, { type: "TOGGLE_NOOK_BOOKMARK" }> =>
      message.type === "TOGGLE_NOOK_BOOKMARK"
  );
  assert.ok(toggleMessage);
  assert.equal(toggleMessage!.item.id, "x:222");
});
