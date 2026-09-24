import { defineContentScript } from "wxt/utils/define-content-script";
import type { BackgroundToContentMessage } from "../../lib/types";
import { isExtensionValid, sendNookMessage } from "./messaging";
import { showNotification, type Notify } from "./notify";
import { parseTweet } from "./tweet-dom";
import { createNookButtonController } from "./nook-button";
import { attachNativeBookmarkAutoSave } from "./auto-save";
import { initBookmarkSync } from "./bookmark-sync";
import { parseFocalTweet } from "./focal-tweet";

export default defineContentScript({
  matches: ["https://x.com/*", "https://twitter.com/*"],
  runAt: "document_idle",
  main() {
    console.log("[Nook] Running");

    const notify: Notify = (message, bookmarkId, toastType) =>
      showNotification(sendNookMessage, message, bookmarkId, toastType);

    // The Nook action-bar button: its own saved/unsaved state per tweet.
    const nookButtons = createNookButtonController({
      parseTweet,
      sendMessage: sendNookMessage,
      isExtensionValid,
      notify
    });
    nookButtons.init();

    // Clicking X's own bookmark button also saves to Nook, and should be
    // reflected on the Nook button for the same tweet.
    attachNativeBookmarkAutoSave({
      parseTweet,
      sendMessage: sendNookMessage,
      isExtensionValid,
      notify,
      onSaved: nookButtons.updateNookButtonState
    });

    // Direct-API bookmark backfill/sync, driven by BEGIN_AUTO_SYNC from the background page.
    initBookmarkSync({ sendMessage: sendNookMessage, notify });

    // The popup's SAVE_ACTIVE_PAGE goes through the background page, which asks
    // this content script to parse the focal tweet so it saves the same
    // `x:<id>` record the in-page Nook button uses, then reports state changes
    // back here so that button reflects saves/removes made from the popup.
    chrome.runtime.onMessage.addListener((message: BackgroundToContentMessage, _sender, sendResponse) => {
      if (message?.type === "PARSE_FOCAL_TWEET") {
        sendResponse(parseFocalTweet());
        return true;
      }
      if (message?.type === "NOOK_BOOKMARK_STATE_CHANGED") {
        nookButtons.updateNookButtonState(message.id, message.saved);
        return false;
      }
    });
  }
});
