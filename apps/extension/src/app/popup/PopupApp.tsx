import { useEffect, useState } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Text } from "@astryxdesign/core/Text";
import { Thumbnail } from "@astryxdesign/core/Thumbnail";
import { Token } from "@astryxdesign/core/Token";
import { Theme, type ThemeMode } from "@astryxdesign/core/theme";
import { ToastViewport, useToast } from "@astryxdesign/core/Toast";
import { nookTheme } from "../theme/nook.js";
import { AppearanceMenu } from "../components/AppearanceMenu";
import { useAppearance } from "../components/useAppearance";
import * as NookDB from "../../../lib/db";
import * as NookShared from "../../../lib/shared";
import type { Bookmark, BookmarkList } from "../../../lib/types";

function bookmarkLabel(item: Bookmark) {
  if (item.source === "chrome") {
    return item.title || item.creator?.name || item.creator?.handle || "Web Bookmark";
  }
  return item.creator?.name || item.creator?.handle || "X Post";
}

function PopupScreen({
  appearanceMode,
  onAppearanceChange,
}: {
  appearanceMode: ThemeMode;
  onAppearanceChange: (mode: ThemeMode) => void;
}) {
  const toast = useToast();
  const [items, setItems] = useState<Bookmark[]>([]);
  const [lists, setLists] = useState<BookmarkList[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSyncing, setIsSyncing] = useState(false);

  const refresh = async () => {
    await NookDB.ready();
    const [bookmarks, bookmarkLists] = await Promise.all([
      NookDB.getAllBookmarks(),
      NookDB.getAllLists(),
    ]);
    setItems(NookShared.sortBookmarksByDate(bookmarks));
    setLists(bookmarkLists);
    setIsLoading(false);
  };

  useEffect(() => {
    void refresh().catch((error) => {
      console.error("[Nook] Failed to load bookmarks:", error);
      setIsLoading(false);
      toast({ body: "Could not load bookmarks.", type: "error" });
    });
    const channel = new BroadcastChannel("nook-db");
    channel.addEventListener("message", () => {
      void refresh().catch((error) => {
        console.error("[Nook] Failed to refresh bookmarks:", error);
      });
    });
    return () => channel.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast]);

  const openUrl = (url: string) => {
    chrome.tabs.create({ url }).catch((error) => {
      console.error("[Nook] Failed to open URL:", error);
      toast({ body: "Could not open this link.", type: "error" });
    });
  };

  const openDashboard = () => {
    openUrl(chrome.runtime.getURL("dashboard.html"));
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
      toast({ body: "Could not start syncing.", type: "error" });
    }
  };

  const deleteBookmark = async (id: string) => {
    try {
      await NookDB.softDeleteBookmark(id);
      await refresh();
    } catch (error) {
      console.error("[Nook] Failed to delete bookmark:", error);
      toast({ body: "Could not delete this bookmark.", type: "error" });
    }
  };

  return (
    <AppShell className="nook-popup-shell" height="auto" contentPadding={0} variant="surface">
      <VStack width="100%" isScrollable gap={3} padding={4}>
        <HStack justify="between" align="center" gap={2}>
          <HStack align="center" gap={2}>
            <Text type="large" weight="bold">Nook</Text>
            <Badge label={items.length} />
          </HStack>
          <HStack align="center" gap={1}>
            <AppearanceMenu mode={appearanceMode} onChange={onAppearanceChange} />
            <Button label="Dashboard" size="sm" variant="secondary" onClick={openDashboard} />
          </HStack>
        </HStack>

        <HStack gap={2}>
          <Button
            label="Sync X bookmarks"
            size="sm"
            variant="primary"
            isLoading={isSyncing}
            onClick={startSync}
          />
          <Text type="supporting">Latest saved bookmarks</Text>
        </HStack>

        {isLoading ? (
          <Text color="secondary">Loading bookmarks…</Text>
        ) : items.length === 0 ? (
          <EmptyState
            title="No bookmarks yet"
            description="Save a post on X or a web page to see it here."
            isCompact
          />
        ) : (
          <List density="compact" hasDividers aria-label="Latest bookmarks">
            {items.map((item) => {
              const media = item.media || item.attachments || [];
              const list = lists.find((candidate) => candidate.id === item.listId);
              const title = bookmarkLabel(item);
              const description = item.description || item.shortDescription || item.url || "";
              return (
                <ListItem
                  key={item.id}
                  label={title}
                  description={
                    <VStack gap={2}>
                      <Text type="supporting" color="secondary">{description}</Text>
                      {list && <Token label={(list.icon || "📁") + " " + list.name} size="sm" />}
                      {(item.tags || []).slice(0, 3).map((tag) => (
                        <Token key={tag} label={"#" + tag.replace(/^#/, "")} size="sm" />
                      ))}
                    </VStack>
                  }
                  startContent={
                    <Avatar
                      name={item.creator?.name || item.creator?.handle || title}
                      src={item.creator?.avatar || undefined}
                      size="sm"
                    />
                  }
                  endContent={
                    <HStack align="center" gap={1}>
                      {media[0] && (
                        <Thumbnail
                          src={media[0].url}
                          alt={media[0].alt || `${title} preview`}
                          label={`${title} preview`}
                        />
                      )}
                      <Button
                        label="Delete"
                        size="sm"
                        variant="ghost"
                        onClick={(event) => {
                          event.stopPropagation();
                          void deleteBookmark(item.id);
                        }}
                      />
                    </HStack>
                  }
                  onClick={() => {
                    if (item.url) openUrl(item.url);
                    else openDashboard();
                  }}
                />
              );
            })}
          </List>
        )}
      </VStack>
    </AppShell>
  );
}

export function PopupApp() {
  const appearance = useAppearance();

  return (
    <Theme theme={nookTheme} mode={appearance.mode}>
      <ToastViewport position="bottomEnd">
        <PopupScreen appearanceMode={appearance.mode} onAppearanceChange={appearance.setMode} />
      </ToastViewport>
    </Theme>
  );
}

export default PopupApp;
