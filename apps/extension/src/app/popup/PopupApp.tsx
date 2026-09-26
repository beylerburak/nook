import { useEffect, useState } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Button } from "@astryxdesign/core/Button";
import { VStack } from "@astryxdesign/core/Layout";
import { Theme, type ThemeMode } from "@astryxdesign/core/theme";
import { ToastViewport, useToast } from "@astryxdesign/core/Toast";
import { nookTheme } from "../theme/nook.js";
import { useAppearance } from "../components/useAppearance";
import { I18nProvider, useI18n } from "../../i18n";
import { useCloudStatus } from "../host/useCloudStatus";
import * as NookDB from "../../../lib/db";
import { cloudApiUrl } from "../../../lib/cloud-sync";
import type { BookmarkList } from "../../../lib/types";
import { getTags } from "../dashboard/bookmark-utils";
import {
  buildDashboardBookmarkUrl,
  buildDashboardSearchUrl,
  buildWebBookmarkUrl,
  buildWebConnectUrl,
  buildWebSearchUrl,
} from "./dashboardLinks";
import { PageCard } from "./PageCard";
import { PopupFooter } from "./PopupFooter";
import { PopupHeader } from "./PopupHeader";
import { QuickOrganize } from "./QuickOrganize";
import { SyncStatusLine } from "./SyncStatusLine";
import { useActivePage } from "./useActivePage";
import { useSaveShortcut } from "./useSaveShortcut";

function PopupScreen({
  appearanceMode,
  onAppearanceChange,
}: {
  appearanceMode: ThemeMode;
  onAppearanceChange: (mode: ThemeMode) => void;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const activePage = useActivePage();
  const saveShortcut = useSaveShortcut();
  const cloudStatus = useCloudStatus();

  const [totalCount, setTotalCount] = useState(0);
  const [lists, setLists] = useState<BookmarkList[]>([]);
  const [existingTags, setExistingTags] = useState<string[]>([]);
  const [isSyncing, setIsSyncing] = useState(false);
  const [justSaved, setJustSaved] = useState(false);

  // Library-wide metadata for the header count and the QuickOrganize
  // collection/tag pickers. Read straight from IndexedDB, same as
  // DashboardApp/useBookmarkLibrary, so the popup doesn't duplicate a
  // background message just to list collections and tags.
  useEffect(() => {
    let isActive = true;
    const loadLibraryMeta = async () => {
      await NookDB.ready();
      const [bookmarks, bookmarkLists] = await Promise.all([
        NookDB.getAllBookmarks(),
        NookDB.getAllLists(),
      ]);
      if (!isActive) return;
      setTotalCount(bookmarks.length);
      setLists(bookmarkLists);
      setExistingTags(getTags(bookmarks).map(([tag]) => tag));
    };
    void loadLibraryMeta().catch((error) => {
      console.error("[Nook] Failed to load library metadata:", error);
    });
    const channel = new BroadcastChannel("nook-db");
    channel.addEventListener("message", () => void loadLibraryMeta());
    return () => {
      isActive = false;
      channel.close();
    };
  }, []);

  const openUrl = (url: string) => {
    chrome.tabs.create({ url }).catch((error) => {
      console.error("[Nook] Failed to open URL:", error);
      toast({ body: t("popup.errors.openLinkFailed"), type: "error" });
    });
  };

  // The web app is the product once signed in (product contract §2): route
  // "open dashboard" / search / bookmark deep links there when this device
  // is linked to a cloud account and online, and to the local dashboard.html
  // otherwise (offline or signed out, where the local copy already works).
  const canUseWebApp = Boolean(cloudStatus?.signedIn) && !cloudStatus?.offline;
  const webApiUrl = cloudStatus?.apiUrl ?? cloudApiUrl();

  const openDashboard = () => openUrl(canUseWebApp ? webApiUrl : chrome.runtime.getURL("dashboard.html"));
  const openDashboardSearch = (query: string) =>
    openUrl(
      canUseWebApp
        ? buildWebSearchUrl(webApiUrl, query)
        : chrome.runtime.getURL(buildDashboardSearchUrl(query)),
    );
  const openBookmarkInDashboard = (id: string) =>
    openUrl(
      canUseWebApp
        ? buildWebBookmarkUrl(webApiUrl, id)
        : chrome.runtime.getURL(buildDashboardBookmarkUrl(id)),
    );
  const connectToWebApp = () => openUrl(buildWebConnectUrl(webApiUrl));

  const handleSave = async () => {
    try {
      await activePage.save();
      setJustSaved(true);
      toast({ body: t("popup.page.savedToNook") });
    } catch (error) {
      console.error("[Nook] Failed to save the page:", error);
      toast({ body: t("popup.errors.saveFailed"), type: "error" });
    }
  };

  const handleRemove = async () => {
    try {
      await activePage.remove();
      // Instant, undoable delete (no confirm dialog) matches how the
      // dashboard already handles bookmark deletion — see deleteBookmark in
      // useBookmarkLibrary.ts, which soft-deletes immediately and only
      // toasts. Undo re-saves the same page, which the background's
      // SAVE_ITEM handler already treats as un-deleting an existing row.
      toast({
        body: t("popup.toast.removed"),
        endContent: <Button label={t("popup.toast.undo")} size="sm" variant="ghost" onClick={() => void handleSave()} />,
      });
    } catch (error) {
      console.error("[Nook] Failed to remove the bookmark:", error);
      toast({ body: t("popup.errors.removeFailed"), type: "error" });
    }
  };

  const startSync = () => {
    setIsSyncing(true);
    try {
      chrome.runtime.sendMessage({ type: "START_AUTO_SYNC_X" }, () => {
        window.close();
      });
    } catch (error) {
      console.error("[Nook] Failed to start sync:", error);
      setIsSyncing(false);
      toast({ body: t("popup.errors.syncStartFailed"), type: "error" });
    }
  };

  const bookmark = activePage.state?.kind === "page" ? activePage.state.bookmark : null;

  return (
    <AppShell className="nook-popup-shell" height="auto" contentPadding={0} variant="surface">
      <VStack width="100%" isScrollable gap={3} padding={4}>
        <PopupHeader
          totalCount={totalCount}
          appearanceMode={appearanceMode}
          onAppearanceChange={onAppearanceChange}
          onOpenDashboard={openDashboard}
        />

        <SyncStatusLine status={cloudStatus} onConnect={connectToWebApp} />

        <PageCard
          state={activePage.state}
          phase={activePage.phase}
          errorMessage={activePage.error}
          isSaving={activePage.isSaving}
          isRemoving={activePage.isRemoving}
          saveShortcut={saveShortcut}
          onSave={() => void handleSave()}
          onRemove={() => void handleRemove()}
          onRetry={() => void activePage.refresh()}
          onOpenInDashboard={openBookmarkInDashboard}
        />

        {bookmark ? (
          <QuickOrganize
            bookmark={bookmark}
            lists={lists}
            suggestedTags={existingTags}
            defaultIsOpen={justSaved}
            onPatch={activePage.patchBookmark}
          />
        ) : null}

        <PopupFooter
          onSearch={openDashboardSearch}
          onSync={startSync}
          isSyncing={isSyncing}
          onOpenDashboard={openDashboard}
          saveShortcut={saveShortcut}
        />
      </VStack>
    </AppShell>
  );
}

export function PopupApp() {
  const appearance = useAppearance();

  return (
    <I18nProvider>
      <Theme theme={nookTheme} mode={appearance.mode}>
        <ToastViewport position="bottomEnd">
          <PopupScreen appearanceMode={appearance.mode} onAppearanceChange={appearance.setMode} />
        </ToastViewport>
      </Theme>
    </I18nProvider>
  );
}

export default PopupApp;
