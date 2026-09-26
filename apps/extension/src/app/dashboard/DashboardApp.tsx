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
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Toolbar } from "@astryxdesign/core/Toolbar";
import { TopNav, TopNavHeading } from "@astryxdesign/core/TopNav";
import { ToastViewport, useToast } from "@astryxdesign/core/Toast";
import { ToggleButton } from "@astryxdesign/core/ToggleButton";
import { Theme, type ThemeMode } from "@astryxdesign/core/theme";
import { nookTheme } from "../theme/nook.js";
import { CanvasEditorShell } from "../canvas-editor/page";
import { useAppearance } from "../components/useAppearance";
import { I18nProvider, useI18n } from "../../i18n";
import { BookmarkCard } from "../components/BookmarkCard";
import { SyncStatusIndicator } from "../components/SyncStatusIndicator";
import { UserMenu } from "../components/UserMenu";
import { BookmarkTable, getBookmarkTableViewConfig } from "../data-table/BookmarkTable";
import { DataTableViewOptions } from "../data-table/view-options";
import { DataTableViewProvider } from "../data-table/view-state";
import { SettingsDialog, type SettingsSection } from "../settings-dialog/SettingsDialog";
import { useCloudStatus } from "../host/useCloudStatus";
import { useNookHost } from "../host/NookHost";
import { BookmarkDetailPanel } from "./BookmarkDetailPanel";
import { CreateListDialog, DeleteListDialog } from "./dialogs";
import { BookmarkGlyph } from "./glyphs";
import { LibrarySideNav } from "./LibrarySideNav";
import { OrganizePage } from "./organize/OrganizePage";
import { useBookmarkLibrary } from "./useBookmarkLibrary";
import {
  DEFAULT_CARD_PAGE_SIZE,
  DEFAULT_TABLE_PAGE_SIZE,
  DEFAULT_VIEW,
  LIST_EMOJIS,
  allItemMedia,
  describeEmptySearch,
  describeSearchCount,
  describeSearchSignal,
  getTags,
  hasMedia,
  itemTitle,
  matchesLibraryView,
  searchFiltersForView,
  useLibrarySearch,
  visibleText,
  type BookmarkViewMode,
  type LibraryView,
  type LightboxState,
  type MediaFilter,
  type SearchFallback,
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
  const { t } = useI18n();
  const host = useNookHost();
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
  // The web host's `navigation.isOrganizeOpen` mirrors the URL
  // (/app/dashboard/organize vs /app/dashboard) — start there directly so a
  // direct link or a page refresh lands on Organize without a flash of the
  // bookmark grid first. The extension has no `navigation` capability (see
  // NookHost.tsx), so it always starts at the default view, exactly as
  // before.
  const [view, setView] = useState<LibraryView>(() =>
    host.navigation?.isOrganizeOpen ? { kind: "organize" } : DEFAULT_VIEW,
  );
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [notesOnly, setNotesOnly] = useState(false);
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
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | undefined>(undefined);
  const [pendingDeleteList, setPendingDeleteList] = useState<BookmarkList | null>(null);
  const [listNameDraft, setListNameDraft] = useState("");
  const [listEmoji, setListEmoji] = useState(LIST_EMOJIS[0]);

  const openSettings = useCallback((section?: SettingsSection) => {
    setSettingsSection(section);
    setIsSettingsOpen(true);
  }, []);

  const resetPagination = useCallback(() => {
    setCardPage(1);
    setTablePage(1);
  }, []);

  const selectLibraryView = useCallback((nextView: LibraryView) => {
    setView(nextView);
    resetPagination();
    // Web only (see NookHost.tsx) — keeps the URL in step with whatever view
    // was just picked, so Organize gets a real, linkable, back/forward-able
    // URL without any other view needing one (host.navigation is undefined
    // for the extension, so this is a no-op there).
    host.navigation?.onOrganizeOpenChange(nextView.kind === "organize");
  }, [resetPagination, host]);

  // The other direction: a browser back/forward, or a direct link to
  // /app/dashboard/organize, changes `host.navigation.isOrganizeOpen` out
  // from under this component (App.tsx's route state re-renders SignedInApp,
  // which recomputes the web host) — reconcile the local view to match
  // rather than leaving the URL and the rendered page disagreeing. Compares
  // only the organize/non-organize distinction, the one thing the URL knows
  // about, so it never clobbers the user's own click into a collection or tag.
  useEffect(() => {
    const isOrganizeOpen = host.navigation?.isOrganizeOpen;
    if (isOrganizeOpen === undefined) return;
    setView((current) => {
      if (isOrganizeOpen && current.kind !== "organize") return { kind: "organize" };
      if (!isOrganizeOpen && current.kind === "organize") return DEFAULT_VIEW;
      return current;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host.navigation?.isOrganizeOpen]);

  // Search-focus / Settings shortcuts and whole-page JSON drag & drop.
  // Purely UI wiring — the bookmark data effects (initial load, cross-tab
  // refresh) live in useBookmarkLibrary. A dropped file imports straight
  // away (importBookmarks toasts its own result); there's no confirmation
  // dialog to stage it in anymore now that import lives in Settings → Data.
  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ",") {
        event.preventDefault();
        openSettings(undefined);
        return;
      }
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
      void importBookmarks(file);
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
  }, [importBookmarks, openSettings]);

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

  // The view pipeline and the search are separate on purpose. Everything the
  // sidebar, the media tabs and the notes toggle decide is applied first and
  // unconditionally, and the search then decides which of *these* bookmarks to
  // show — so a server answer can rank inside the current view but can never
  // widen it, and the sidebar stays authoritative over an index that knows
  // nothing about "with media".
  const viewItems = useMemo(
    () => items.filter((item) => matchesLibraryView(item, view, mediaFilter, notesOnly)),
    [items, view, mediaFilter, notesOnly],
  );
  const serverFilters = useMemo(() => searchFiltersForView(view), [view]);

  // One subscription, reused for whether a search may be made at all. The same
  // status already drives the sync indicator in the top nav, so this adds no new
  // source of truth about the session — only a second reader of it.
  const cloudStatus = useCloudStatus();
  const canSearch = cloudStatus !== null && cloudStatus.signedIn && !cloudStatus.offline;
  const searchBlocked: SearchFallback | null = cloudStatus === null
    ? null
    : !cloudStatus.signedIn
      ? "signed-out"
      : cloudStatus.offline
        ? "offline"
        : null;

  const librarySearch = useLibrarySearch({
    items: viewItems,
    query: search,
    canSearch,
    blockedReason: searchBlocked,
    filters: serverFilters,
  });

  // Sort stays the user's choice: relevance ordering would silently reorder the
  // list under a selector that says "Newest first".
  const filteredItems = useMemo(() => {
    return NookShared.sortBookmarksByDate(librarySearch.items, sort);
  }, [librarySearch.items, sort]);
  const searchSignal = describeSearchSignal(librarySearch, t);
  const emptySearchCopy = describeEmptySearch(librarySearch, search.trim(), items.length, t);

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

  const bookmarkTableViewConfig = useMemo(() => getBookmarkTableViewConfig(t), [t]);

  const pageSize = viewMode === "cards" ? cardPageSize : tablePageSize;
  const requestedPage = viewMode === "cards" ? cardPage : tablePage;
  const totalPages = Math.max(1, Math.ceil(filteredItems.length / pageSize));
  const activePage = Math.min(requestedPage, totalPages);
  const pageItems = useMemo(
    () => filteredItems.slice((activePage - 1) * pageSize, activePage * pageSize),
    [filteredItems, activePage, pageSize],
  );

  const viewTitle = useMemo(() => {
    if (view.kind === "x") return t("dashboard.views.x");
    if (view.kind === "chrome") return t("dashboard.views.web");
    if (view.kind === "unorganized") return t("dashboard.views.unorganized");
    if (view.kind === "list") {
      const list = lists.find((candidate) => candidate.id === view.id);
      return list ? (list.icon || list.emoji || "📁") + " " + list.name : t("dashboard.views.collectionFallback");
    }
    if (view.kind === "tag") return "#" + view.id;
    return t("dashboard.views.all");
  }, [view, lists, t]);

  const openDetails = useCallback((item: Bookmark) => {
    setActiveItem(item);
    setNoteDraft(item.note || "");
    setTagDraft("");
  }, []);

  // Deep links from the popup: ?q= prefills the search box (see
  // buildDashboardSearchUrl in src/app/popup/dashboardLinks.ts), ?id= opens
  // that bookmark's detail panel once it's loaded. Read once on mount —
  // this is an entry point, not a two-way binding with the URL.
  const appliedDeepLinkRef = useRef(false);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const query = params.get("q");
    if (query) {
      setSearch(query);
      resetPagination();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (appliedDeepLinkRef.current || isLoading) return;
    const id = new URLSearchParams(window.location.search).get("id");
    if (id) {
      const match = items.find((item) => item.id === id);
      if (match) openDetails(match);
    }
    appliedDeepLinkRef.current = true;
  }, [isLoading, items, openDetails]);

  const savePatch = async (patch: Partial<Bookmark>): Promise<boolean> => {
    if (!activeItem) return false;
    const updated = await updateBookmark(activeItem.id, patch);
    if (!updated) return false;
    setActiveItem(updated);
    return true;
  };

  const saveNote = () => {
    void savePatch({ note: noteDraft }).then((success) => {
      if (success) toast({ body: t("dashboard.toast.noteSaved") });
    });
  };

  const deleteBookmark = useCallback(async (item: Bookmark) => {
    const success = await deleteBookmarkRecord(item.id);
    if (success) setActiveItem((current) => (current?.id === item.id ? null : current));
  }, [deleteBookmarkRecord]);

  const openUrl = useCallback((url: string) => {
    if (typeof chrome !== "undefined" && chrome.tabs?.create) {
      chrome.tabs.create({ url }).catch((error) => {
        console.error("[Nook] Failed to open URL:", error);
        toast({ body: t("dashboard.toast.couldNotOpenLink"), type: "error" });
      });
    } else {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, [toast, t]);

  const copyText = useCallback(async (item: Bookmark) => {
    const text = [visibleText(item), item.note, item.url].filter(Boolean).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      toast({ body: t("dashboard.toast.copiedToClipboard") });
    } catch (error) {
      console.error("[Nook] Failed to copy to clipboard:", error);
      toast({ body: t("dashboard.toast.couldNotCopyToClipboard"), type: "error" });
    }
  }, [toast, t]);

  const copyUrl = useCallback(async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      toast({ body: t("dashboard.toast.urlCopied") });
    } catch (error) {
      console.error("[Nook] Failed to copy URL:", error);
      toast({ body: t("dashboard.toast.couldNotCopyUrl"), type: "error" });
    }
  }, [toast, t]);

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
    toast({ body: t("dashboard.toast.bookmarksExported") });
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
      label={t("dashboard.topNav.ariaLabel")}
      heading={
        <TopNavHeading
          heading="Nook"
          subheading={t("dashboard.topNav.subheading")}
          logo={<Icon icon={BookmarkGlyph} color="accent" />}
        />
      }
      endContent={
        <HStack gap={2} align="center">
          <SyncStatusIndicator onOpenSync={() => openSettings("sync")} />
          <UserMenu
            onOpenProfile={() => openSettings("profile")}
            onOpenSettings={() => openSettings(undefined)}
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
        inspectorLabel={activeItem ? t("dashboard.detail.panelLabel", { title: itemTitle(activeItem, t) }) : undefined}
      >
        <VStack className="nook-main-content" gap={5} padding={6}>
          {view.kind === "organize" ? (
            <OrganizePage items={items} lists={lists} onOpenAiSettings={() => openSettings("ai")} />
          ) : (
          <>
          <HStack justify="between" align="center" wrap="wrap" gap={3}>
            <VStack gap={1}>
              <Heading level={1}>{viewTitle}</Heading>
              <Text type="supporting" color="secondary">
                {describeSearchCount(librarySearch, filteredItems.length, search.trim(), t)}
              </Text>
              {searchSignal ? (
                <HStack align="center" gap={2} wrap="wrap">
                  <StatusDot variant={searchSignal.variant} label={searchSignal.label} />
                  <Text type="supporting" color="secondary">{searchSignal.detail}</Text>
                </HStack>
              ) : null}
            </VStack>
            <Badge label={t("dashboard.badge.saved", { count: items.length })} />
          </HStack>

          <DataTableViewProvider config={bookmarkTableViewConfig}>
            <Toolbar
              className="nook-bookmark-toolbar"
              label={t("dashboard.toolbar.ariaLabel")}
              size="sm"
              startContent={
                <TextInput
                  ref={searchInputRef}
                  label={t("dashboard.search.label")}
                  isLabelHidden
                  startIcon={<Icon icon="search" size="sm" />}
                  placeholder={t("dashboard.search.placeholder")}
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
                      label={t("dashboard.viewOptions.label")}
                      columnsLabel={{
                        title: t("dashboard.viewOptions.columns.title"),
                        displayed: t("dashboard.viewOptions.columns.displayed"),
                        available: t("dashboard.viewOptions.columns.available"),
                        restore: t("dashboard.viewOptions.columns.restore"),
                        selectAll: t("dashboard.viewOptions.columns.selectAll"),
                        emptyDisplayed: t("dashboard.viewOptions.columns.emptyDisplayed"),
                        emptyAvailable: t("dashboard.viewOptions.columns.emptyAvailable"),
                        required: t("dashboard.viewOptions.columns.required"),
                        reorder: t("dashboard.viewOptions.columns.reorder"),
                        reorderHint: t("dashboard.viewOptions.columns.reorderHint"),
                        remove: t("dashboard.viewOptions.columns.remove"),
                        add: t("dashboard.viewOptions.columns.add"),
                      }}
                      densityLabel={t("dashboard.viewOptions.density")}
                      stickyLabel={t("dashboard.viewOptions.sticky")}
                      stickyStartLabel={t("dashboard.viewOptions.stickyStart")}
                      stickyEndLabel={t("dashboard.viewOptions.stickyEnd")}
                      stickyNoneLabel={t("dashboard.viewOptions.stickyNone")}
                      stickyOneLabel={t("dashboard.viewOptions.stickyOne")}
                      stickyTwoLabel={t("dashboard.viewOptions.stickyTwo")}
                      groupingLabel={t("dashboard.viewOptions.grouping")}
                      groupingNoneLabel={t("dashboard.viewOptions.groupingNone")}
                      densityLabels={{
                        compact: t("dashboard.viewOptions.densityOptions.compact"),
                        balanced: t("dashboard.viewOptions.densityOptions.balanced"),
                        spacious: t("dashboard.viewOptions.densityOptions.spacious"),
                      }}
                    />
                  ) : null}
                  <SegmentedControl
                    label={t("dashboard.toolbar.bookmarkViewLabel")}
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
                      label={t("dashboard.viewMode.cards")}
                      icon={<Icon icon="viewColumns" size="sm" />}
                    />
                    <SegmentedControlItem
                      value="table"
                      label={t("dashboard.viewMode.table")}
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
                <Tab value="all" label={t("dashboard.mediaFilter.all")} endContent={<Badge label={counts.all} />} />
                <Tab value="media" label={t("dashboard.mediaFilter.media")} endContent={<Badge label={counts.media} />} />
                <Tab value="text" label={t("dashboard.mediaFilter.text")} endContent={<Badge label={counts.text} />} />
              </TabList>
              <HStack align="center" gap={2} wrap="wrap">
                <ToggleButton
                  label={t("dashboard.mediaFilter.notesOnly")}
                  isPressed={notesOnly}
                  onPressedChange={(pressed) => {
                    setNotesOnly(pressed);
                    resetPagination();
                  }}
                  size="sm"
                >
                  {t("dashboard.mediaFilter.notesOnly")}
                </ToggleButton>
                <Selector
                  label={t("dashboard.sort.ariaLabel")}
                  isLabelHidden
                  size="sm"
                  variant="ghost"
                  options={[
                    { value: "newest", label: t("dashboard.sort.newest") },
                    { value: "oldest", label: t("dashboard.sort.oldest") },
                  ]}
                  value={sort}
                  onChange={(value) => {
                    setSort(value as "newest" | "oldest");
                    resetPagination();
                  }}
                />
              </HStack>
            </HStack>

            {isLoading ? (
              <Section variant="muted" padding={6}>
                <Text color="secondary">{t("dashboard.states.loading")}</Text>
              </Section>
            ) : filteredItems.length === 0 ? (
              <EmptyState
                title={emptySearchCopy.title}
                description={emptySearchCopy.description}
                actions={
                  items.length ? (
                    <Button
                      label={t("dashboard.emptyState.showAllBookmarks")}
                      variant="secondary"
                      onClick={() => {
                        selectLibraryView(DEFAULT_VIEW);
                        setMediaFilter("all");
                        setNotesOnly(false);
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
              <Grid className="nook-bookmark-masonry">
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
                  label={viewMode === "cards" ? t("dashboard.pagination.cardPages") : t("dashboard.pagination.tablePages")}
                />
              </HStack>
            ) : null}
          </DataTableViewProvider>
          </>
          )}
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

      <SettingsDialog
        isOpen={isSettingsOpen}
        onOpenChange={setIsSettingsOpen}
        initialSection={settingsSection}
        appearance={appearance}
        onAppearanceChange={onAppearanceChange}
        onOpenOrganize={() => {
          setIsSettingsOpen(false);
          selectLibraryView({ kind: "organize" });
        }}
        library={{
          bookmarkCount: items.length,
          collectionCount: lists.length,
          isImporting,
          importBookmarks,
          exportBookmarks,
          clearAllBookmarks,
        }}
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
            // Without a playable file (DOM-captured videos) show the poster image.
            src: media.type === "video" && media.videoUrl ? media.videoUrl : media.url,
            alt: media.alt || t("dashboard.lightbox.savedMediaAlt"),
            type: media.type === "video" && media.videoUrl ? "video" : "image",
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
    <I18nProvider>
      <Theme theme={nookTheme} mode={appearance.mode}>
        <ToastViewport position="bottomEnd">
          <DashboardScreen
            appearance={appearance.mode}
            onAppearanceChange={appearance.setMode}
          />
        </ToastViewport>
      </Theme>
    </I18nProvider>
  );
}

export default DashboardApp;
