import type { Bookmark } from "../../lib/types";
import type { SendNookMessage } from "./messaging";
import type { Notify } from "./notify";

export interface AutoSaveDeps {
  parseTweet: (article: Element) => Bookmark;
  sendMessage: SendNookMessage;
  isExtensionValid: () => boolean;
  notify: Notify;
  /** Lets the Nook action-bar button reflect a save made through X's native bookmark button. */
  onSaved: (id: string, saved: true) => void;
}

async function saveItem(deps: AutoSaveDeps, item: Bookmark): Promise<boolean> {
  if (!deps.isExtensionValid()) {
    console.warn("[Nook] Extension context invalidated. Please refresh the page (F5).");
    deps.notify("Nook was updated. Please refresh the page (F5) 🔄");
    return false;
  }

  return new Promise((resolve) => {
    try {
      deps.sendMessage({ type: "SAVE_ITEM", item }).then((response) => {
        if (chrome.runtime.lastError) {
          console.warn("[Nook] Message error:", chrome.runtime.lastError.message);
          resolve(false);
        } else {
          resolve(response?.success === true);
        }
      });
    } catch (err) {
      console.warn("[Nook] Could not send message to background:", err);
      resolve(false);
    }
  });
}

/**
 * Saves to Nook whenever the user clicks X's own (native) bookmark button,
 * so bookmarking on X keeps working as a save shortcut alongside the
 * dedicated Nook button.
 */
export function attachNativeBookmarkAutoSave(deps: AutoSaveDeps, doc: Document = document): void {
  doc.addEventListener(
    "click",
    async (event) => {
      try {
        const target = event.target;
        if (!(target instanceof Element)) return;

        // Only the bookmark button on a post that isn't bookmarked yet.
        // The "remove bookmark" button is usually removeBookmark.
        const bookmarkButton = target.closest('[data-testid="bookmark"]');
        if (!bookmarkButton) return;

        if (!deps.isExtensionValid()) {
          console.warn("[Nook] Extension was reloaded. Please refresh the page (F5).");
          deps.notify("Nook was updated. Please refresh the page (F5) 🔄");
          return;
        }

        const article = bookmarkButton.closest('article[data-testid="tweet"]');
        if (!article) {
          console.warn("[Nook] Tweet container not found");
          return;
        }

        const item = deps.parseTweet(article);
        if (!item?.url) {
          console.warn("[Nook] Could not parse tweet", item);
          return;
        }

        const saved = await saveItem(deps, item);
        if (saved) {
          deps.onSaved(item.id, true);
          deps.notify(
            item.media?.length ? `Nook: Saved with ${item.media.length} media ✓` : "Nook: Saved to bookmarks ✓",
            item.id
          );
        }
      } catch (err) {
        console.warn("[Nook] Click handler caught:", err);
      }
    },
    true
  );
}
