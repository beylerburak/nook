/**
 * Right-click "Save ... to Nook" entries. Registration is idempotent
 * (removeAll before creating) so re-running it on every onInstalled/update
 * never throws "duplicate id" or leaves stale menus behind.
 */

import { loadLocaleSetting } from "../../lib/locale";
import { resolveLocale, translate } from "../../src/i18n/core";
import { saveCurrentTab, saveImageTarget, saveLinkTarget } from "./save-page";

export const MENU_SAVE_PAGE = "nook-save-page";
export const MENU_SAVE_LINK = "nook-save-link";
export const MENU_SAVE_IMAGE = "nook-save-image";

/**
 * (Re-)creates the context menu entries in the current locale. Idempotent
 * (removeAll before creating), so it's safe to call again whenever the
 * language setting changes — see the subscribeToLocaleSetting call in
 * entrypoints/background/index.ts.
 */
export async function registerContextMenus(): Promise<void> {
  const locale = resolveLocale(await loadLocaleSetting());
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SAVE_PAGE,
      title: translate(locale, "extension.contextMenu.savePage"),
      contexts: ["page"],
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_LINK,
      title: translate(locale, "extension.contextMenu.saveLink"),
      contexts: ["link"],
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_IMAGE,
      title: translate(locale, "extension.contextMenu.saveImage"),
      contexts: ["image"],
    });
  });
}

export async function handleContextMenuClick(
  info: chrome.contextMenus.OnClickData,
  tab: chrome.tabs.Tab | undefined
): Promise<void> {
  if (!tab) return;

  switch (info.menuItemId) {
    case MENU_SAVE_PAGE:
      await saveCurrentTab(tab);
      return;
    case MENU_SAVE_LINK:
      if (info.linkUrl) await saveLinkTarget(info.linkUrl, tab);
      return;
    case MENU_SAVE_IMAGE:
      if (info.srcUrl) await saveImageTarget(info.srcUrl, tab);
      return;
    default:
      return;
  }
}
