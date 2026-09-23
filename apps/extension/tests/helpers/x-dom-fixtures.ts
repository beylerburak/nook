/**
 * Minimal DOM fixtures that mimic the shape of X's action-bar markup, just
 * enough for nook-button.ts's DOM logic (findActionBar / slotOf /
 * restingActionColor / makeNookButton) to operate on. Not a faithful
 * reproduction of X's real class names or nesting beyond what that logic reads.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

export interface ActionSlotOptions {
  testId: string;
  color?: string;
  count?: number;
  label?: string;
  tag?: "button" | "a";
}

/** One action-bar slot: <div><button data-testid=…><div style=color><div class=icon-wrap><hover-circle/><svg/></div><count?/></div></button></div> */
export function buildActionSlot(doc: Document, opts: ActionSlotOptions): HTMLElement {
  const slot = doc.createElement("div");
  slot.className = "css-slot";

  const action = doc.createElement(opts.tag ?? "button");
  action.setAttribute("data-testid", opts.testId);
  action.setAttribute("role", "button");
  if (opts.label) action.setAttribute("aria-label", opts.label);
  if (action.tagName === "BUTTON") action.setAttribute("type", "button");

  const colorBox = doc.createElement("div");
  colorBox.setAttribute("dir", "ltr");
  colorBox.style.color = opts.color ?? "rgb(113, 118, 123)";

  const iconWrap = doc.createElement("div");
  iconWrap.className = "icon-wrap";

  const hoverCircle = doc.createElement("div");
  hoverCircle.className = "hover-circle";

  const svg = doc.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  const g = doc.createElementNS(SVG_NS, "g");
  const path = doc.createElementNS(SVG_NS, "path");
  path.setAttribute("d", "M1 2h3v4h-3z");
  g.appendChild(path);
  svg.appendChild(g);

  iconWrap.appendChild(hoverCircle);
  iconWrap.appendChild(svg);
  colorBox.appendChild(iconWrap);

  if (opts.count !== undefined) {
    const countBox = doc.createElement("div");
    countBox.className = "count";
    const span = doc.createElement("span");
    span.textContent = String(opts.count);
    countBox.appendChild(span);
    colorBox.appendChild(countBox);
  }

  action.appendChild(colorBox);
  slot.appendChild(action);
  return slot;
}

/** Wraps slots in a div wrapping several of its own (X nests bookmark+share together in the feed). */
export function buildTrailingSlot(doc: Document, slots: HTMLElement[]): HTMLElement {
  const trailing = doc.createElement("div");
  trailing.className = "css-trailing-slot";
  for (const slot of slots) trailing.appendChild(slot);
  return trailing;
}

/** The role="group" action bar itself, holding the given slots as direct children. */
export function buildActionBar(doc: Document, slots: HTMLElement[]): HTMLElement {
  const group = doc.createElement("div");
  group.setAttribute("role", "group");
  for (const slot of slots) group.appendChild(slot);
  return group;
}

/** A tweet <article> containing the given action bar (or none). */
export function buildTweetArticle(doc: Document, actionBar: HTMLElement | null, statusId = "123"): HTMLElement {
  const article = doc.createElement("article");
  article.setAttribute("data-testid", "tweet");
  article.dataset.statusId = statusId;

  const userName = doc.createElement("div");
  userName.setAttribute("data-testid", "User-Name");
  userName.textContent = "Test User\n@testuser";
  article.appendChild(userName);

  const text = doc.createElement("div");
  text.setAttribute("data-testid", "tweetText");
  text.textContent = `Tweet ${statusId}`;
  article.appendChild(text);

  const time = doc.createElement("time");
  time.setAttribute("datetime", "2024-01-01T00:00:00.000Z");
  const timeLink = doc.createElement("a");
  timeLink.setAttribute("href", `/testuser/status/${statusId}`);
  timeLink.appendChild(time);
  article.appendChild(timeLink);

  if (actionBar) article.appendChild(actionBar);
  return article;
}

/** Standard feed layout: reply, retweet, like, views, then bookmark+share nested in a trailing div. */
export function buildFeedActionBarWithBookmark(doc: Document): HTMLElement {
  return buildActionBar(doc, [
    buildActionSlot(doc, { testId: "reply", count: 9, color: "rgb(113, 118, 123)" }),
    buildActionSlot(doc, { testId: "retweet", count: 2, color: "rgb(0, 186, 124)" }),
    buildActionSlot(doc, { testId: "like", count: 5, color: "rgb(249, 24, 128)" }),
    buildActionSlot(doc, { testId: "analytics", label: "View post analytics", color: "rgb(113, 118, 123)" }),
    buildTrailingSlot(doc, [
      buildActionSlot(doc, { testId: "bookmark", label: "Bookmark", color: "rgb(113, 118, 123)" }),
      buildActionSlot(doc, { testId: "share", tag: "a", label: "Share", color: "rgb(113, 118, 123)" })
    ])
  ]);
}

/** Post-detail layout: every action is its own top-level slot, including bookmark. */
export function buildDetailActionBar(doc: Document): HTMLElement {
  return buildActionBar(doc, [
    buildActionSlot(doc, { testId: "reply", count: 9, color: "rgb(113, 118, 123)" }),
    buildActionSlot(doc, { testId: "retweet", count: 2, color: "rgb(0, 186, 124)" }),
    buildActionSlot(doc, { testId: "like", count: 5, color: "rgb(249, 24, 128)" }),
    buildActionSlot(doc, { testId: "bookmark", label: "Bookmark", color: "rgb(113, 118, 123)" }),
    buildActionSlot(doc, { testId: "share", tag: "a", label: "Share", color: "rgb(113, 118, 123)" })
  ]);
}

/** Feed layout without a bookmark action at all (e.g. a region/feature-flag variant). */
export function buildFeedActionBarWithoutBookmark(doc: Document): HTMLElement {
  return buildActionBar(doc, [
    buildActionSlot(doc, { testId: "reply", count: 9, color: "rgb(113, 118, 123)" }),
    buildActionSlot(doc, { testId: "retweet", count: 2, color: "rgb(0, 186, 124)" }),
    buildActionSlot(doc, { testId: "like", count: 5, color: "rgb(249, 24, 128)" }),
    buildActionSlot(doc, { testId: "analytics", label: "View post analytics", color: "rgb(113, 118, 123)" }),
    buildActionSlot(doc, { testId: "share", tag: "a", label: "Share", color: "rgb(113, 118, 123)" })
  ]);
}
