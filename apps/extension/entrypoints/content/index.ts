import { defineContentScript } from "wxt/utils/define-content-script";
import { isExtensionValid, sendNookMessage } from "./messaging";
import { showNotification, type Notify } from "./notify";
import { parseTweet } from "./tweet-dom";
import { createNookButtonController } from "./nook-button";
import { attachNativeBookmarkAutoSave } from "./auto-save";
import { initBookmarkSync } from "./bookmark-sync";

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
  }
});
