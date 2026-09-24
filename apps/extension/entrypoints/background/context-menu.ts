/**
 * Right-click "Save ... to Nook" entries. Registration is idempotent
 * (removeAll before creating) so re-running it on every onInstalled/update
 * never throws "duplicate id" or leaves stale menus behind.
 */

import { saveCurrentTab, saveImageTarget, saveLinkTarget } from "./save-page";

export const MENU_SAVE_PAGE = "nook-save-page";
export const MENU_SAVE_LINK = "nook-save-link";
export const MENU_SAVE_IMAGE = "nook-save-image";

export function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SAVE_PAGE, title: "Save page to Nook", contexts: ["page"] });
    chrome.contextMenus.create({ id: MENU_SAVE_LINK, title: "Save link to Nook", contexts: ["link"] });
    chrome.contextMenus.create({ id: MENU_SAVE_IMAGE, title: "Save image to Nook", contexts: ["image"] });
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
