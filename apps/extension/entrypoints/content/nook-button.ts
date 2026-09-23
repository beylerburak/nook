import type { Bookmark } from "../../lib/types";
import type { SendNookMessage } from "./messaging";
import type { Notify } from "./notify";

// X drives hover visuals from React state (inline color + a class swap on the
// circle behind the icon). A cloned node has no React handlers, so these rules
// replay the same states on the elements we keep from X's own markup.
export const NOOK_ACCENT = "16, 185, 129";

export function installNookHoverStyles(doc: Document = document): void {
  if (doc.getElementById("nook-x-action-hover-styles")) return;
  const style = doc.createElement("style");
  style.id = "nook-x-action-hover-styles";
  style.textContent = `
    button[data-nook-action="true"]:hover [data-nook-color],
    button[data-nook-action="true"]:focus-visible [data-nook-color],
    button[data-nook-action="true"][aria-pressed="true"] [data-nook-color] {
      color: rgb(${NOOK_ACCENT}) !important;
    }
    button[data-nook-action="true"]:hover [data-nook-hover],
    button[data-nook-action="true"]:focus-visible [data-nook-hover] {
      background-color: rgba(${NOOK_ACCENT}, 0.1) !important;
    }
    button[data-nook-action="true"]:focus-visible {
      outline: none;
    }
  `;
  (doc.head || doc.documentElement).appendChild(style);
}

export function renderNookButton(button: HTMLElement, saved: boolean): void {
  button.setAttribute("aria-label", saved ? "Saved to Nook" : "Save to Nook");
  button.setAttribute("aria-pressed", String(saved));
  button.title = saved ? "Saved to Nook" : "Save to Nook";
  const icon = button.querySelector("svg");
  if (icon) {
    icon.setAttribute("viewBox", "0 0 24 24");
    // When filled, cut the "N" out with X's page background (dark/dim/light) so it stays visible.
    const glyphStroke = saved ? getComputedStyle(document.body).backgroundColor || "currentColor" : "currentColor";
    const nookMark =
      '<path d="M5.25 3h13.5A1.25 1.25 0 0 1 20 4.25V21l-8-4-8 4V4.25A1.25 1.25 0 0 1 5.25 3Z" fill="' +
      (saved ? "currentColor" : "none") +
      '" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M9 13.5V9.25l6 5v-5" fill="none" stroke="' +
      glyphStroke +
      '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>';
    if (icon.innerHTML !== nookMark) icon.innerHTML = nookMark;
  }
}

/** The tweet's own action bar: the role="group" that holds its reply button. */
export function findActionBar(article: HTMLElement): HTMLElement | null {
  const reply = article.querySelector<HTMLElement>('[role="group"] [data-testid="reply"]');
  const group = reply?.closest<HTMLElement>('[role="group"]');
  return group && article.contains(group) ? group : null;
}

/** Direct child of the action bar that contains `el` (one "slot" of the bar). */
export function slotOf(group: HTMLElement, el: HTMLElement): HTMLElement {
  let slot = el;
  while (slot.parentElement && slot.parentElement !== group) slot = slot.parentElement;
  return slot;
}

// Resting icon color, read from an X action that has no active state (reply, views,
// share) and isn't hovered right now — so the theme (dark/dim/light) follows X.
export function restingActionColor(group: HTMLElement): string {
  const stateful =
    '[data-testid="like"], [data-testid="unlike"], [data-testid="retweet"], [data-testid="unretweet"], [data-testid="bookmark"], [data-testid="removeBookmark"], [data-nook-action]';
  for (const action of group.querySelectorAll<HTMLElement>("button, a")) {
    if (action.matches(stateful) || action.matches(":hover")) continue;
    const colored = action.querySelector<HTMLElement>('[style*="color"]');
    if (colored?.style.color) return colored.style.color;
  }
  return "";
}

/**
 * Clone X's reply slot so Nook gets X's exact slot sizing, icon size, hover circle
 * and transitions for the current context (feed vs. post detail), then strip the
 * reply-specific bits (count, ids, test ids).
 */
export function makeNookButton(
  group: HTMLElement,
  replyButton: HTMLElement
): { slot: HTMLElement; button: HTMLElement } | null {
  const source = slotOf(group, replyButton);
  const slot = source.cloneNode(true) as HTMLElement;
  const button = slot.matches('[data-testid="reply"]') ? slot : slot.querySelector<HTMLElement>('[data-testid="reply"]');
  const icon = button?.querySelector("svg");
  const iconWrapper = icon?.parentElement;
  if (!button || !icon || !iconWrapper) return null;

  // Keep only the path from the slot down to the icon wrapper: drops the reply count
  // and anything else X renders next to the icon.
  const keepPathTo = (parent: Element, target: Element) => {
    for (const child of Array.from(parent.childNodes)) {
      if (child === target) continue;
      if (child instanceof Element && child.contains(target)) keepPathTo(child, target);
      else child.remove();
    }
  };
  keepPathTo(slot, iconWrapper);

  for (const el of [slot, ...slot.querySelectorAll<HTMLElement>("*")]) {
    el.removeAttribute("id");
    el.removeAttribute("data-testid");
    el.removeAttribute("aria-describedby");
  }

  // X's hover circle is the empty sibling of the icon; its colored text container
  // is the nearest ancestor carrying the inline color.
  const hoverCircle = Array.from(iconWrapper.children).find((el) => el !== icon && !el.children.length);
  hoverCircle?.setAttribute("data-nook-hover", "");
  const inlineColored = iconWrapper.closest<HTMLElement>('[style*="color"]');
  const colorBox = inlineColored && button.contains(inlineColored) ? inlineColored : iconWrapper.parentElement;
  if (colorBox) {
    colorBox.setAttribute("data-nook-color", "");
    colorBox.style.color = restingActionColor(group) || colorBox.style.color;
  }

  button.setAttribute("data-nook-action", "true");
  if (button.tagName === "BUTTON") button.setAttribute("type", "button");
  renderNookButton(button, false);
  return { slot, button };
}

export interface NookButtonControllerDeps {
  parseTweet: (article: Element) => Bookmark;
  sendMessage: SendNookMessage;
  isExtensionValid: () => boolean;
  notify: Notify;
}

export interface NookButtonController {
  /** Scans `root` (a single tweet article, or any container) and installs/refreshes Nook buttons. */
  installNookButtons: (root?: ParentNode) => void;
  updateNookButtonState: (id: string, saved: boolean) => void;
  /** Installs styles, does the first scan, wires the click handler and starts observing for new tweets. */
  init: (doc?: Document) => MutationObserver;
}

/**
 * Owns all state for the injected "Save to Nook" action-bar button: which
 * tweets are known to be saved, which button belongs to which parsed tweet,
 * and which ids are already in flight to the background page.
 */
export function createNookButtonController(deps: NookButtonControllerDeps): NookButtonController {
  const nookSavedState = new Map<string, boolean>();
  const nookButtonItems = new WeakMap<HTMLElement, Bookmark>();
  const nookStatusRequested = new Set<string>();

  const queryAllButtons = (doc: Document): HTMLElement[] =>
    Array.from(doc.querySelectorAll<HTMLElement>('[data-nook-action="true"]'));

  function updateNookButtonState(id: string, saved: boolean) {
    nookSavedState.set(id, saved);
    for (const button of queryAllButtons(document)) {
      const item = nookButtonItems.get(button);
      if (item?.id === id) renderNookButton(button, saved);
    }
  }

  function installNookButtons(root: ParentNode = document) {
    const articles =
      root instanceof Element && root.matches('article[data-testid="tweet"]')
        ? [root as HTMLElement]
        : Array.from(root.querySelectorAll<HTMLElement>('article[data-testid="tweet"]'));
    const requested: string[] = [];

    for (const article of articles) {
      const group = findActionBar(article);
      if (!group) continue;

      if (!group.querySelector('[data-nook-action="true"]')) {
        const replyButton = group.querySelector<HTMLElement>('[data-testid="reply"]')!;
        const made = makeNookButton(group, replyButton);
        if (!made) continue;
        // Behave like one more native action: its own slot, placed right before the
        // bar's trailing slot (bookmark/share cluster in the feed, share on detail).
        const trailing = group.lastElementChild;
        if (trailing && trailing !== slotOf(group, replyButton)) trailing.before(made.slot);
        else group.appendChild(made.slot);
        const item = deps.parseTweet(article);
        if (item.url) nookButtonItems.set(made.button, item);
      }

      const button = group.querySelector<HTMLElement>('[data-nook-action="true"]');
      const item = button && nookButtonItems.get(button);
      if (!button || !item) continue;
      if (nookSavedState.has(item.id)) {
        renderNookButton(button, nookSavedState.get(item.id)!);
      } else if (!nookStatusRequested.has(item.id)) {
        nookStatusRequested.add(item.id);
        requested.push(item.id);
      }
    }

    if (requested.length && deps.isExtensionValid()) {
      deps
        .sendMessage({ type: "GET_NOOK_BOOKMARK_STATES", ids: requested })
        .then((response) => {
          for (const [id, saved] of Object.entries(response?.states || {})) nookSavedState.set(id, saved);
          for (const article of articles) {
            const button = article.querySelector<HTMLElement>('[data-nook-action="true"]');
            const item = button && nookButtonItems.get(button);
            if (button && item && nookSavedState.has(item.id)) renderNookButton(button, nookSavedState.get(item.id)!);
          }
        })
        .catch((err) => console.warn("[Nook] Could not load bookmark status:", err));
    }
  }

  function attachClickHandler(doc: Document) {
    doc.addEventListener(
      "click",
      async (event) => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const button = target.closest<HTMLElement>('[data-nook-action="true"]');
        if (!button) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!deps.isExtensionValid()) {
          deps.notify("Nook was updated. Please refresh the page (F5) 🔄");
          return;
        }
        const cachedItem = nookButtonItems.get(button);
        if (!cachedItem || button.getAttribute("aria-busy") === "true") return;

        // Re-parse the article instead of trusting the item cached at install time:
        // text/media can finish loading after install, and X reuses article DOM
        // nodes as the timeline scrolls, so the cached item can belong to a
        // different tweet by the time it's clicked.
        const article = button.closest<HTMLElement>('article[data-testid="tweet"]');
        const freshItem = article ? deps.parseTweet(article) : null;
        const item = freshItem?.url ? freshItem : cachedItem;
        if (item.id !== cachedItem.id) nookButtonItems.set(button, item);

        button.setAttribute("aria-busy", "true");
        (button as HTMLButtonElement).disabled = true;
        try {
          const response = await deps.sendMessage({ type: "TOGGLE_NOOK_BOOKMARK", item });
          if (!response?.success || response.saved === undefined) {
            throw new Error(response?.error || "Could not update Nook bookmark");
          }
          updateNookButtonState(item.id, response.saved);
          deps.notify(response.saved ? "Saved to Nook ✓" : "Removed from Nook", response.saved ? item.id : undefined);
        } catch (err) {
          console.warn("[Nook] Could not toggle bookmark:", err);
          deps.notify("Could not update Nook bookmark", undefined, "error");
        } finally {
          button.removeAttribute("aria-busy");
          (button as HTMLButtonElement).disabled = false;
        }
      },
      true
    );
  }

  function observe(doc: Document): MutationObserver {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
        if (target?.closest('[data-nook-action="true"]')) continue;
        for (const node of mutation.addedNodes) {
          if (node instanceof Element && !node.closest('[data-nook-action="true"]')) {
            const article = node.closest<HTMLElement>('article[data-testid="tweet"]');
            installNookButtons(article || node);
          }
        }
      }
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true });
    return observer;
  }

  function init(doc: Document = document): MutationObserver {
    installNookHoverStyles(doc);
    installNookButtons(doc);
    attachClickHandler(doc);
    return observe(doc);
  }

  return { installNookButtons, updateNookButtonState, init };
}
