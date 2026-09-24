import { useCallback, useEffect, useState } from "react";
import type { useToast } from "@astryxdesign/core/Toast";
import * as NookDB from "../../../lib/db";
import type { Bookmark, BookmarkList } from "../../../lib/types";

type ToastFn = ReturnType<typeof useToast>;

/**
 * Owns the bookmarks/collections loaded from IndexedDB: the in-memory
 * state, cross-tab refresh via BroadcastChannel, and every write operation
 * (import, update, delete, create/delete collection, clear all). Every
 * operation reports failures through `toast` and never throws, so a
 * rejected IndexedDB write can't become an unhandled promise rejection.
 *
 * Used by both the extension and the web app — the web app is local-first
 * too, and syncs this same IndexedDB library to the cloud out of band (see
 * lib/cloud-sync.ts / lib/cloud-runner.ts), rather than reading through a
 * separate network-backed hook.
 */
export function useBookmarkLibrary(toast: ToastFn) {
  const [items, setItems] = useState<Bookmark[]>([]);
  const [lists, setLists] = useState<BookmarkList[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);

  const refresh = useCallback(async () => {
    await NookDB.ready();
    const [nextItems, nextLists] = await Promise.all([
      NookDB.getAllBookmarks(),
      NookDB.getAllLists(),
    ]);
    setItems(nextItems);
    setLists(nextLists);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh().catch((error) => {
      console.error("[Nook] Failed to load bookmarks:", error);
      setIsLoading(false);
      toast({ body: "Could not load bookmarks.", type: "error" });
    });

    const channel = new BroadcastChannel("nook-db");
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    channel.addEventListener("message", (event) => {
      if (event.data?.type !== "changed") return;
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => void refresh(), 150);
    });

    return () => {
      channel.close();
      if (reloadTimer) clearTimeout(reloadTimer);
    };
  }, [refresh, toast]);

  const importBookmarks = useCallback(async (file: File): Promise<boolean> => {
    setIsImporting(true);
    try {
      const parsed: unknown = JSON.parse(await file.text());
      const payload = Array.isArray(parsed) ? { items: parsed, lists: [] } : parsed;
      if (!payload || typeof payload !== "object") throw new Error("Invalid JSON export");
      const importedItems = (payload as { items?: unknown }).items;
      const importedLists = (payload as { lists?: unknown }).lists;
      if (!Array.isArray(importedItems)) throw new Error("The file does not contain bookmarks");
      const validItems = importedItems.filter(
        (item): item is Bookmark =>
          Boolean(item && typeof item === "object" && typeof (item as Bookmark).id === "string"),
      );
      const validLists = Array.isArray(importedLists)
        ? importedLists.filter(
            (list): list is BookmarkList =>
              Boolean(list && typeof list === "object" && typeof (list as BookmarkList).id === "string"),
          )
        : [];
      await NookDB.putBookmarks(validItems);
      await Promise.all(validLists.map((list) => NookDB.putList(list)));
      await refresh();
      toast({ body: "Imported " + validItems.length + " bookmarks." });
      return true;
    } catch (error) {
      console.error("[Nook] Import failed:", error);
      toast({ body: "Could not import this JSON file.", type: "error" });
      return false;
    } finally {
      setIsImporting(false);
    }
  }, [refresh, toast]);

  const updateBookmark = useCallback(async (
    id: string,
    patch: Partial<Bookmark>,
  ): Promise<Bookmark | null> => {
    try {
      const updated = await NookDB.updateBookmark(id, patch);
      if (!updated) return null;
      await refresh();
      return updated;
    } catch (error) {
      console.error("[Nook] Failed to update bookmark:", error);
      toast({ body: "Could not save changes.", type: "error" });
      return null;
    }
  }, [refresh, toast]);

  const deleteBookmark = useCallback(async (id: string): Promise<boolean> => {
    try {
      await NookDB.softDeleteBookmark(id);
      await refresh();
      toast({ body: "Bookmark deleted." });
      return true;
    } catch (error) {
      console.error("[Nook] Failed to delete bookmark:", error);
      toast({ body: "Could not delete this bookmark.", type: "error" });
      return false;
    }
  }, [refresh, toast]);

  const createList = useCallback(async (list: BookmarkList): Promise<boolean> => {
    try {
      await NookDB.putList(list);
      await refresh();
      toast({ body: "Collection created." });
      return true;
    } catch (error) {
      console.error("[Nook] Failed to create collection:", error);
      toast({ body: "Could not create this collection.", type: "error" });
      return false;
    }
  }, [refresh, toast]);

  const deleteList = useCallback(async (id: string): Promise<boolean> => {
    try {
      await NookDB.softDeleteList(id);
      await refresh();
      toast({ body: "Collection deleted." });
      return true;
    } catch (error) {
      console.error("[Nook] Failed to delete collection:", error);
      toast({ body: "Could not delete this collection.", type: "error" });
      return false;
    }
  }, [refresh, toast]);

  const clearAllBookmarks = useCallback(async (): Promise<boolean> => {
    try {
      await NookDB.softDeleteAllBookmarks();
      await refresh();
      toast({ body: "Bookmarks cleared." });
      return true;
    } catch (error) {
      console.error("[Nook] Failed to clear bookmarks:", error);
      toast({ body: "Could not clear bookmarks.", type: "error" });
      return false;
    }
  }, [refresh, toast]);

  return {
    items,
    lists,
    isLoading,
    isImporting,
    refresh,
    importBookmarks,
    updateBookmark,
    deleteBookmark,
    createList,
    deleteList,
    clearAllBookmarks,
  };
}
