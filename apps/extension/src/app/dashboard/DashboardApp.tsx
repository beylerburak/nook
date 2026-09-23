import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { EmptyState } from "@astryxdesign/core/EmptyState";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Lightbox } from "@astryxdesign/core/Lightbox";
import { Pagination } from "@astryxdesign/core/Pagination";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { ToastViewport, useToast } from "@astryxdesign/core/Toast";
import { Theme, type ThemeMode } from "@astryxdesign/core/theme";
import { nookTheme } from "../theme/nook.js";
import { CanvasEditorShell } from "../canvas-editor/page";
import { AppearanceMenu } from "../components/AppearanceMenu";
import { useAppearance } from "../components/useAppearance";
import { BookmarkCard } from "../components/BookmarkCard";
import { BookmarkTable, BOOKMARK_TABLE_VIEW_CONFIG } from "../data-table/BookmarkTable";
import { DataTableViewOptions } from "../data-table/view-options";
import { DataTableViewProvider } from "../data-table/view-state";
import { BookmarkDetailPanel } from "./BookmarkDetailPanel";
import {
  ClearAllBookmarksDialog,
  CreateListDialog,
  DeleteListDialog,
  ImportBookmarksDialog,
} from "./dialogs";
import { BookmarkGlyph } from "./glyphs";
import { LibrarySideNav } from "./LibrarySideNav";
import { useBookmarkLibrary } from "./useBookmarkLibrary";
import {
  DEFAULT_CARD_PAGE_SIZE,
  DEFAULT_TABLE_PAGE_SIZE,
  DEFAULT_VIEW,
  LIST_EMOJIS,
  allItemMedia,
  getTags,
  hasMedia,
  itemTitle,
  matchesSearch,
  visibleText,
  type BookmarkViewMode,
  type LibraryView,
  type LightboxState,
  type MediaFilter,
} from "./bookmark-utils";
import * as NookShared from "../../../lib/shared";
import type { Bookmark, BookmarkList, Media } from "../../../lib/types";

function DashboardScreen({
  appearance,
  onAppearanceChange,
}: {
  appearance: ThemeMode;
  onAppearanceChange: (mode: ThemeMode) => void;
}) {
  const toast = useToast();
  const searchInputRef = useRef<HTMLInputElement>(null);
  const {
    items,
    lists,
    isLoading,
    isImporting,
    importBookmarks,
    updateBookmark,
    deleteBookmark: deleteBookmarkRecord,
    createList: createListRecord,
    deleteList: deleteListRecord,
    clearAllBookmarks,
  } = useBookmarkLibrary(toast);

  const [search, setSearch] = useState("");
  const [view, setView] = useState<LibraryView>(DEFAULT_VIEW);
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [viewMode, setViewMode] = useState<BookmarkViewMode>("cards");
  const [cardPage, setCardPage] = useState(1);
  const [tablePage, setTablePage] = useState(1);
  const [cardPageSize, setCardPageSize] = useState(DEFAULT_CARD_PAGE_SIZE);
  const [tablePageSize, setTablePageSize] = useState(DEFAULT_TABLE_PAGE_SIZE);
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [activeItem, setActiveItem] = useState<Bookmark | null>(null);
  const [noteDraft, setNoteDraft] = useState("");
  const [tagDraft, setTagDraft] = useState("");
  const [lightbox, setLightbox] = useState<LightboxState>(null);
  const [isListDialogOpen, setIsListDialogOpen] = useState(false);
  const [isImportDialogOpen, setIsImportDialogOpen] = useState(false);
  const [isClearDialogOpen, setIsClearDialogOpen] = useState(false);
  const [pendingDeleteList, setPendingDeleteList] = useState<BookmarkList | null>(null);
  const [listNameDraft, setListNameDraft] = useState("");
  const [listEmoji, setListEmoji] = useState(LIST_EMOJIS[0]);
  const [importFile, setImportFile] = useState<File | null>(null);

  const resetPagination = useCallback(() => {
    setCardPage(1);
    setTablePage(1);
  }, []);

  const selectLibraryView = useCallback((nextView: LibraryView) => {
    setView(nextView);
    resetPagination();
  }, [resetPagination]);

  // Search-focus shortcut and whole-page JSON drag & drop. Purely UI
  // wiring — the bookmark data effects (initial load, cross-tab refresh)
  // live in useBookmarkLibrary.
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if (event.key === "/" && !event.metaKey && !event.ctrlKey) {
        const target = event.target as HTMLElement | null;
        if (target?.matches("input, textarea, [contenteditable=true]")) return;
        event.preventDefault();
        searchInputRef.current?.focus();
      }
      if (event.key === "Escape" && document.activeElement === searchInputRef.current) {
        searchInputRef.current?.blur();
      }
    };
    document.addEventListener("keydown", handleShortcut);

    const handleDrop = (event: DragEvent) => {
      const file = event.dataTransfer?.files?.[0];
      if (!file || (!file.name.endsWith(".json") && file.type !== "application/json")) return;
      event.preventDefault();
      setImportFile(file);
      setIsImportDialogOpen(true);
    };
    const preventFileNavigation = (event: DragEvent) => {
      if (Array.from(event.dataTransfer?.types || []).includes("Files")) event.preventDefault();
    };
    window.addEventListener("dragover", preventFileNavigation);
    window.addEventListener("drop", handleDrop);

    return () => {
      document.removeEventListener("keydown", handleShortcut);
      window.removeEventListener("dragover", preventFileNavigation);
      window.removeEventListener("drop", handleDrop);
    };
  }, []);

  const counts = useMemo(() => {
    const mediaCount = items.filter(hasMedia).length;
    return {
      all: items.length,
      x: items.filter((item) => item.source === "x").length,
      chrome: items.filter((item) => item.source === "chrome").length,
      unorganized: items.filter((item) => !item.listId).length,
      media: mediaCount,
      text: items.length - mediaCount,
    };
  }, [items]);
  const tags = useMemo(() => getTags(items), [items]);

  const filteredItems = useMemo(() => {
    const filtered = items.filter((item) => {
      if (view.kind === "x" && item.source !== "x") return false;
      if (view.kind === "chrome" && item.source !== "chrome") return false;
      if (view.kind === "unorganized" && item.listId) return false;
      if (view.kind === "list" && item.listId !== view.id) return false;
      if (
        view.kind === "tag" &&
        !(item.tags || []).some((tag) => tag.toLowerCase().replace(/^#/, "") === view.id)
      ) return false;
      if (mediaFilter === "media" && !hasMedia(item)) return false;
      if (mediaFilter === "text" && hasMedia(item)) return false;
      return matchesSearch(item, search.trim());
    });
    return NookShared.sortBookmarksByDate(filtered, sort);
  }, [items, view, mediaFilter, search, sort]);

  const listsById = useMemo(
    () => new Map(lists.map((list) => [list.id, list])),
    [lists],
  );
  const listCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of items) {
      if (item.listId) counts.set(item.listId, (counts.get(item.listId) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const pageSize = viewMode === "cards" ? cardPageSize : tablePageSize;
  const requestedPage = viewMode === "cards" ? cardPage : tablePage;
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const activePage = Math.min(requestedPage, totalPages);
  const pageItems = useMemo(
    () => filteredItems.slice((activePage - 1) * pageSize, activePage * pageSize),
    [filteredItems, activePage, pageSize],
  );

  const viewTitle = useMemo(() => {
    if (view.kind === "x") return "X bookmarks";
    if (view.kind === "chrome") return "Web pages";
    if (view.kind === "unorganized") return "Unorganized";
    if (view.kind === "list") {
      const list = lists.find((candidate) => candidate.id === view.id);
      return list ? (list.icon || list.emoji || "📁") + " " + list.name : "Collection";
    }
    if (view.kind === "tag") return "#" + view.id;
    return "All bookmarks";
  }, [view, lists]);

  const openDetails = useCallback((item: Bookmark) => {
    setActiveItem(item);
    setNoteDraft(item.note || "");
    setTagDraft("");
  }, []);

  const savePatch = async (patch: Partial<Bookmark>): Promise<boolean> => {
    if (!activeItem) return false;
    const updated = await updateBookmark(activeItem.id, patch);
    if (!updated) return false;
    setActiveItem(updated);
    return true;
  };

  const saveNote = () => {
    void savePatch({ note: noteDraft }).then((success) => {
      if (success) toast({ body: "Note saved." });
    });
  };

  const deleteBookmark = useCallback(async (item: Bookmark) => {
    const success = await deleteBookmarkRecord(item.id);
    if (success) setActiveItem((current) => (current?.id === item.id ? null : current));
  }, [deleteBookmarkRecord]);

  const openUrl = useCallback((url: string) => {
    chrome.tabs.create({ url }).catch((error) => {
      console.error("[Nook] Failed to open URL:", error);
      toast({ body: "Could not open this link.", type: "error" });
    });
  }, [toast]);

  const copyText = useCallback(async (item: Bookmark) => {
    const text = [visibleText(item), item.note, item.url].filter(Boolean).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      toast({ body: "Copied to clipboard." });
    } catch (error) {
      console.error("[Nook] Failed to copy to clipboard:", error);
      toast({ body: "Could not copy to clipboard.", type: "error" });
    }
  }, [toast]);

  const copyUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ body: "URL copied." });
    } catch (error) {
      console.error("[Nook] Failed to copy URL:", error);
      toast({ body: "Could not copy the URL.", type: "error" });
    }
  }, [toast]);

  const openBookmarkUrl = useCallback((url: string, _item: Bookmark) => {
    openUrl(url);
  }, [openUrl]);

  const openBookmarkTag = useCallback((_item: Bookmark, tag: string) => {
    selectLibraryView({ kind: "tag", id: tag.toLowerCase().replace(/^#/, "") });
  }, [selectLibraryView]);

  const openBookmarkMedia = useCallback((media: Media, bookmark: Bookmark) => {
    const mediaItems = allItemMedia(bookmark);
    const index = mediaItems.findIndex((candidate) => candidate.url === media.url);
    setLightbox({ media: mediaItems, index: Math.max(0, index) });
  }, []);

  const updateItemTags = async (nextTags: string[]): Promise<boolean> => {
    if (!activeItem) return false;
    const normalized = [
      ...new Set(nextTags.map((tag) => tag.trim().replace(/^#/, "").toLowerCase()).filter(Boolean)),
    ];
    return savePatch({ tags: normalized });
  };

  const handleCreateList = async () => {
    const name = listNameDraft.trim();
    if (!name) return;
    const now = new Date().toISOString();
    const success = await createListRecord({
      id: crypto.randomUUID(),
      name,
      icon: listEmoji,
      emoji: listEmoji,
      createdAt: now,
      updatedAt: now,
    });
    if (success) {
      setListNameDraft("");
      setListEmoji(LIST_EMOJIS[0]);
      setIsListDialogOpen(false);
    }
  };

  const handleDeleteList = async () => {
    if (!pendingDeleteList) return;
    const success = await deleteListRecord(pendingDeleteList.id);
    if (success) {
      if (view.kind === "list" && view.id === pendingDeleteList.id) selectLibraryView(DEFAULT_VIEW);
      setPendingDeleteList(null);
    }
  };

  const handleClearAll = async () => {
    const success = await clearAllBookmarks();
    if (success) setIsClearDialogOpen(false);
  };

  const handleImport = async () => {
    if (!importFile) return;
    const success = await importBookmarks(importFile);
    if (success) {
      setImportFile(null);
      setIsImportDialogOpen(false);
    }
  };

  const exportBookmarks = () => {
    const file = new Blob(
      [JSON.stringify({ items, lists, exportedAt: new Date().toISOString() }, null, 2)],
      { type: "application/json" },
    );
    const url = URL.createObjectURL(file);
    const link = document.createElement("a");
    link.href = url;
    link.download = "nook-bookmarks.json";
    link.click();
    URL.revokeObjectURL(url);
    toast({ body: "Bookmarks exported." });
  };

  const nav = (
    <LibrarySideNav
      view={view}
      counts={counts}
      lists={lists}
      listCounts={listCounts}
      tags={tags}
      onSelectView={selectLibraryView}
      onCreateList={() => setIsListDialogOpen(true)}
      onRequestDeleteList={setPendingDeleteList}
    />
  );

  const topNav = (
    <TopNav
      className="nook-glass-topnav"
      label="Nook primary navigation"
      heading={
        <TopNavHeading
          heading="Nook"
          subheading="Your visual library"
          logo={<Icon icon={BookmarkGlyph} color="accent" />}
        />
      }
      endContent={
        <HStack gap={2} align="center">
          <AppearanceMenu mode={appearance} onChange={onAppearanceChange} />
          <Button
            label="Import"
            variant="secondary"
            size="sm"
            icon={<Icon icon="arrowDown" size="sm" />}
            onClick={() => setIsImportDialogOpen(true)}
          />
          <Button
            label="Export"
            variant="secondary"
            size="sm"
            icon={<Icon icon="arrowUp" size="sm" />}
            onClick={exportBookmarks}
          />
          <Button
            label="Clear all"
            variant="ghost"
            size="sm"
            onClick={() => setIsClearDialogOpen(true)}
          />
        </HStack>
      }
    />
  );

  const inspector = activeItem ? (
    <BookmarkDetailPanel
      item={activeItem}
      lists={lists}
      tagCounts={tags}
      noteDraft={noteDraft}
      onNoteDraftChange={setNoteDraft}
      tagDraft={tagDraft}
      onTagDraftChange={setTagDraft}
      onClose={() => setActiveItem(null)}
      onSavePatch={savePatch}
      onUpdateTags={updateItemTags}
      onSaveNote={saveNote}
      onDelete={(item) => void deleteBookmark(item)}
      onOpenUrl={openUrl}
      onCopyUrl={(url) => void copyUrl(url)}
      onMedia={openBookmarkMedia}
    />
  ) : undefined;

  return (
    <>
      <CanvasEditorShell
        topNav={topNav}
        sideNav={nav}
        inspector={inspector}
        inspectorLabel={activeItem ? itemTitle(activeItem) + " details" : undefined}
      >
        <VStack className="nook-main-content" gap={5} padding={6}>
          <HStack justify="between" align="center" wrap="wrap" gap={3}>
            <VStack gap={1}>
              <Heading level={1}>{viewTitle}</Heading>
              <Text type="supporting" color="secondary">
                {filteredItems.length} saved {filteredItems.length === 1 ? "item" : "items"}
                {search.trim() ? " matching “" + search.trim() + "”" : ""}
              </Text>
            </VStack>
            <Badge label={items.length + " saved"} />
          </HStack>

          <DataTableViewProvider config={BOOKMARK_TABLE_VIEW_CONFIG}>
            <Toolbar
              className="nook-bookmark-toolbar"
              label="Bookmark search and view"
              size="sm"
              startContent={
                <TextInput
                  ref={searchInputRef}
                  label="Search bookmarks"
                  isLabelHidden
                  startIcon={<Icon icon="search" size="sm" />}
                  placeholder="Search bookmarks, @authors, #tags…"
                  value={search}
                  hasClear
                  width="15rem"
                  onChange={(value) => {
                    setSearch(value);
                    resetPagination();
                  }}
                />
              }
              endContent={
                <HStack gap={2} vAlign="center" wrap="wrap">
                  {viewMode === "table" ? (
                    <DataTableViewOptions
                      label="View options"
                      columnsLabel={{
                        title: "Columns",
                        displayed: "Displayed columns",
                        available: "Available columns",
                        restore: "Restore",
                        selectAll: "Select all",
                        emptyDisplayed: "No columns are displayed.",
                        emptyAvailable: "All columns are displayed.",
                        required: "This column is required",
                        reorder: "Reorder {column}",
                        reorderHint: "Use the up and down arrow keys or drag to reorder.",
                        remove: "Remove {column}",
                        add: "Add {column}",
                      }}
                      densityLabel="Density"
                      stickyLabel="Sticky columns"
                      stickyStartLabel="Pin from start"
                      stickyEndLabel="Pin from end"
                      stickyNoneLabel="None"
                      stickyOneLabel="One column"
                      stickyTwoLabel="Two columns"
                      groupingLabel="Group by"
                      groupingNoneLabel="No grouping"
                      densityLabels={{
                        compact: "Compact",
                        balanced: "Comfortable",
                        spacious: "Spacious",
                      }}
                    />
                  ) : null}
                  <SegmentedControl
                    label="Bookmark view"
                    value={viewMode}
                    onChange={(value) => {
                      const nextMode = value as BookmarkViewMode;
                      setViewMode(nextMode);
                      if (nextMode === "cards") setCardPage(1);
                      else setTablePage(1);
                    }}
                    size="md"
                  >
                    <SegmentedControlItem
                      value="cards"
                      label="Cards"
                      icon={<Icon icon="viewColumns" size="sm" />}
                    />
                    <SegmentedControlItem
                      value="table"
                      label="Table"
                      icon={<Icon icon="menu" size="sm" />}
                    />
                  </SegmentedControl>
                </HStack>
              }
            />

            <HStack justify="between" align="center" wrap="wrap" gap={3}>
              <TabList
                value={mediaFilter}
                onChange={(value) => {
                  setMediaFilter(value as MediaFilter);
                  resetPagination();
                }}
                size="sm"
              >
                <Tab value="all" label="All" endContent={<Badge label={counts.all} />} />
                <Tab value="media" label="With media" endContent={<Badge label={counts.media} />} />
                <Tab value="text" label="Text only" endContent={<Badge label={counts.text} />} />
              </TabList>
              <Selector
                label="Sort bookmarks"
                isLabelHidden
                size="sm"
                variant="ghost"
                options={[
                  { value: "newest", label: "Newest first" },
                  { value: "oldest", label: "Oldest first" },
                ]}
                value={sort}
                onChange={(value) => {
                  setSort(value as "newest" | "oldest");
                  resetPagination();
                }}
              />
            </HStack>

            {isLoading ? (
              <Section variant="muted" padding={6}>
                <Text color="secondary">Loading your library…</Text>
              </Section>
            ) : filteredItems.length === 0 ? (
              <EmptyState
                title={items.length ? "No matching bookmarks" : "Your library is ready"}
                description={
                  items.length
                    ? "Try another search or clear the current filter."
                    : "Save a post on X or a web page. Nook keeps it here for later."
                }
                actions={
                  items.length ? (
                    <Button
                      label="Show all bookmarks"
                      variant="secondary"
                      onClick={() => {
                        selectLibraryView(DEFAULT_VIEW);
                        setMediaFilter("all");
                        setSearch("");
                        resetPagination();
                      }}
                    />
                  ) : undefined
                }
              />
            ) : viewMode === "table" ? (
              <BookmarkTable
                items={pageItems}
                lists={lists}
                onOpenDetails={openDetails}
                onOpenUrl={openUrl}
              />
            ) : (
              <Grid className="nook-card-grid" columns={{ minWidth: 300, max: 4, repeat: "fit" }} gap={4}>
                {pageItems.map((item) => (
                  <BookmarkCard
                    key={item.id}
                    item={item}
                    listLabel={item.listId ? listsById.get(item.listId)?.name || "" : ""}
                    onOpenDetails={openDetails}
                    onOpenUrl={openBookmarkUrl}
                    onCopy={copyText}
                    onDelete={deleteBookmark}
                    onTag={openBookmarkTag}
                    onList={openDetails}
                    onMedia={openBookmarkMedia}
                  />
                ))}
              </Grid>
            )}

            {filteredItems.length > pageSize ? (
              <HStack justify="end" align="center" wrap="wrap" gap={3}>
                <Pagination
                  page={activePage}
                  onChange={(nextPage) => {
                    if (viewMode === "cards") setCardPage(nextPage);
                    else setTablePage(nextPage);
                  }}
                  totalItems={filteredItems.length}
                  pageSize={pageSize}
                  pageSizeOptions={viewMode === "cards" ? [24, 48, 96] : [25, 50, 100]}
                  onPageSizeChange={(nextSize) => {
                    if (viewMode === "cards") {
                      setCardPageSize(nextSize);
                      setCardPage(1);
                    } else {
                      setTablePageSize(nextSize);
                      setTablePage(1);
                    }
                  }}
                  variant="count"
                  size="sm"
                  label={viewMode === "cards" ? "Bookmark card pages" : "Bookmark table pages"}
                />
              </HStack>
            ) : null}
          </DataTableViewProvider>
        </VStack>
      </CanvasEditorShell>

      <CreateListDialog
        isOpen={isListDialogOpen}
        onOpenChange={setIsListDialogOpen}
        nameDraft={listNameDraft}
        onNameDraftChange={setListNameDraft}
        emoji={listEmoji}
        onEmojiChange={setListEmoji}
        emojiOptions={LIST_EMOJIS}
        onCreate={() => void handleCreateList()}
      />

      <ImportBookmarksDialog
        isOpen={isImportDialogOpen}
        onOpenChange={(open) => {
          setIsImportDialogOpen(open);
          if (!open) setImportFile(null);
        }}
        file={importFile}
        onFileChange={setImportFile}
        isImporting={isImporting}
        onImport={() => void handleImport()}
      />

      <ClearAllBookmarksDialog
        isOpen={isClearDialogOpen}
        onOpenChange={setIsClearDialogOpen}
        onConfirm={() => void handleClearAll()}
      />

      <DeleteListDialog
        list={pendingDeleteList}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteList(null);
        }}
        onConfirm={() => void handleDeleteList()}
      />

      {lightbox ? (
        <Lightbox
          isOpen
          onOpenChange={(open) => {
            if (!open) setLightbox(null);
          }}
          media={lightbox.media.map((media) => ({
            src: media.url,
            alt: media.alt || "Saved media",
            type: media.type === "video" ? "video" : "image",
          }))}
          index={lightbox.index}
          onIndexChange={(index) => setLightbox((current) => current ? { ...current, index } : current)}
          hasZoom
        />
      ) : null}
    </>
  );
}

export function DashboardApp() {
  const appearance = useAppearance();

  return (
    <Theme theme={nookTheme} mode={appearance.mode}>
      <ToastViewport position="bottomEnd">
        <DashboardScreen
          appearance={appearance.mode}
          onAppearanceChange={appearance.setMode}
        />
      </ToastViewport>
    </Theme>
  );
}

export default DashboardApp;
