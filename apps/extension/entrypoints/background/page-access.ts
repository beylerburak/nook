/**
 * Whether the active tab's page can be saved at all — separate from
 * lib/page-capture's pure `isRestrictedUrl`/`isFileUrl` because the file://
 * case needs the chrome.extension permission check, which only exists in
 * the background/extension-page context.
 */

import { isFileUrl, isRestrictedUrl } from "../../lib/page-capture";
import type { PageUnsavableReason } from "../../lib/types";

export async function classifyUnsavableUrl(url: string | undefined): Promise<PageUnsavableReason | null> {
  if (!url) return "restricted";

  if (isFileUrl(url)) {
    const allowed = await chrome.extension.isAllowedFileSchemeAccess().catch(() => false);
    return allowed ? null : "restricted";
  }

  return isRestrictedUrl(url) ? "restricted" : null;
}
