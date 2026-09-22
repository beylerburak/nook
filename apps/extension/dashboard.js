// Nook Dashboard Script - Lists & Tags Edition
let allItems = [];
let allLists = [];
let searchQuery = "";
let currentNav = "all"; // 'all' | 'unorganized' | null
let activeListId = null; // null or string (id of selected list)
let activeTag = null; // null or string (name of selected tag)
let currentFilter = "all"; // 'all' | 'media' | 'text'
let currentSort = "newest"; // 'newest' | 'oldest'
let activeDetailItem = null;
let selectedEmoji = "📁";

const { ICONS, createAvatarFallback, formatDate } = NookShared;

// DOM Elements
const sidebar = document.getElementById("sidebar");
const sidebarToggleBtn = document.getElementById("sidebar-toggle-btn");
const cardsContainer = document.getElementById("cards-container");
const emptyState = document.getElementById("empty-state");
const emptyTitle = document.getElementById("empty-title");
const emptyDesc = document.getElementById("empty-desc");
const currentViewTitle = document.getElementById("current-view-title");
const btnClearFilter = document.getElementById("btn-clear-filter");

const searchInput = document.getElementById("search-input");
const searchClearBtn = document.getElementById("search-clear");
const sortSelect = document.getElementById("sort-select");
const filterTabs = document.querySelectorAll(".filter-tab");
const totalCountBadge = document.getElementById("total-count-badge");
const countAllSpan = document.getElementById("count-all");
const countMediaSpan = document.getElementById("count-media");
const countTextSpan = document.getElementById("count-text");
const navCountAll = document.getElementById("nav-count-all");
const navCountX = document.getElementById("nav-count-x");
const navCountChrome = document.getElementById("nav-count-chrome");
const navCountUnorganized = document.getElementById("nav-count-unorganized");
const listsNav = document.getElementById("lists-nav");
const tagsNav = document.getElementById("tags-nav");
const btnNewList = document.getElementById("btn-new-list");

const btnImport = document.getElementById("btn-import");
const importFileInput = document.getElementById("import-file-input");
const btnExport = document.getElementById("btn-export");
const btnClearAll = document.getElementById("btn-clear-all");
const dragDropOverlay = document.getElementById("drag-drop-overlay");

// Detail Modal Elements
const detailModal = document.getElementById("detail-modal");
const modalAuthorInfo = document.getElementById("modal-author-info");
const detailModalClose = document.getElementById("detail-modal-close");
const modalTweetText = document.getElementById("modal-tweet-text");
const modalMediaGallery = document.getElementById("modal-media-gallery");
const modalQuote = document.getElementById("modal-quote");
const modalListSelect = document.getElementById("modal-list-select");
const modalTagsList = document.getElementById("modal-tags-list");
const modalTagInput = document.getElementById("modal-tag-input");
const modalSuggestedTags = document.getElementById("modal-suggested-tags");
const modalTweetDate = document.getElementById("modal-tweet-date");
const modalSavedDate = document.getElementById("modal-saved-date");
const modalTweetUrl = document.getElementById("modal-tweet-url");
const modalBtnOpenX = document.getElementById("modal-btn-open-x");
const modalBtnCopyText = document.getElementById("modal-btn-copy-text");
const modalBtnCopyUrl = document.getElementById("modal-btn-copy-url");
const modalBtnDelete = document.getElementById("modal-btn-delete");

// New List Modal Elements
const listModal = document.getElementById("list-modal");
const listModalClose = document.getElementById("list-modal-close");
const listModalCancel = document.getElementById("list-modal-cancel");
const listModalSave = document.getElementById("list-modal-save");
const listNameInput = document.getElementById("list-name-input");
const emojiPicker = document.getElementById("emoji-picker");

// Lightbox Elements
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxClose = document.getElementById("lightbox-close");
const toast = document.getElementById("toast");

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  setupEventListeners();
  initBookmarks();
});

// Setup Event Listeners
function setupEventListeners() {
  // Mobile sidebar toggle
  sidebarToggleBtn?.addEventListener("click", () => {
    sidebar.classList.toggle("open");
  });

  // Search input
  searchInput.addEventListener("input", (e) => {
    searchQuery = e.target.value.trim().toLowerCase();
    searchClearBtn.classList.toggle("hidden", !searchQuery);
    renderGrid();
  });

  searchClearBtn.addEventListener("click", () => {
    searchInput.value = "";
    searchQuery = "";
    searchClearBtn.classList.add("hidden");
    searchInput.focus();
    renderGrid();
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && document.activeElement !== searchInput && document.activeElement !== modalTagInput && document.activeElement !== listNameInput) {
      e.preventDefault();
      searchInput.focus();
    } else if (e.key === "Escape") {
      if (!lightbox.classList.contains("hidden")) {
        closeLightbox();
      } else if (!listModal.classList.contains("hidden")) {
        closeListModal();
      } else if (!detailModal.classList.contains("hidden")) {
        closeDetailModal();
      } else if (document.activeElement === searchInput) {
        searchInput.blur();
      }
    }
  });

  // Navigation Items (All & Unorganized)
  document.querySelectorAll(".nav-item[data-nav]").forEach((item) => {
    item.addEventListener("click", () => {
      const nav = item.dataset.nav;
      setActiveNavigation(nav, null, null);
    });
  });

  // Clear filter button
  btnClearFilter.addEventListener("click", () => {
    setActiveNavigation("all", null, null);
  });

  // Filter tabs (All, With Media, Text Only)
  filterTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      filterTabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      currentFilter = tab.dataset.filter;
      renderGrid();
    });
  });

  // Sort dropdown
  sortSelect.addEventListener("change", (e) => {
    currentSort = e.target.value;
    renderGrid();
  });

  // New List button
  btnNewList.addEventListener("click", openListModal);
  listModalClose.addEventListener("click", closeListModal);
  listModalCancel.addEventListener("click", closeListModal);
  listModalSave.addEventListener("click", handleSaveNewList);

  // Emoji picker chips
  emojiPicker.querySelectorAll(".emoji-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      emojiPicker.querySelectorAll(".emoji-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      selectedEmoji = chip.dataset.emoji;
    });
  });

  // List Modal Enter key
  listNameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveNewList();
    }
  });

  // Import JSON button
  btnImport.addEventListener("click", () => {
    importFileInput.click();
  });

  importFileInput.addEventListener("change", (e) => {
    const file = e.target.files?.[0];
    if (file) handleFileImport(file);
    importFileInput.value = "";
  });

  // Export JSON button
  btnExport.addEventListener("click", exportBookmarks);

  // Clear all button
  btnClearAll.addEventListener("click", confirmClearAll);

  // Detail Modal close events
  detailModalClose.addEventListener("click", closeDetailModal);
  detailModal.addEventListener("click", (e) => {
    if (e.target === detailModal) closeDetailModal();
  });

  // Lightbox close events
  lightboxClose.addEventListener("click", closeLightbox);
  lightbox.addEventListener("click", (e) => {
    if (e.target === lightbox) closeLightbox();
  });

  // Drag and Drop JSON onto page
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    if (hasFiles(e)) dragDropOverlay.classList.remove("hidden");
  });

  dragDropOverlay.addEventListener("dragover", (e) => e.preventDefault());
  dragDropOverlay.addEventListener("dragleave", (e) => {
    if (e.target === dragDropOverlay) dragDropOverlay.classList.add("hidden");
  });
  dragDropOverlay.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDropOverlay.classList.add("hidden");
    const file = e.dataTransfer?.files?.[0];
    if (file) handleFileImport(file);
  });

  // Listen for changes made in other extension contexts (e.g. the popup, or
  // a background auto-sync write) in real time. Every successful NookDB
  // write posts on this channel; debounce so a burst of writes (an import,
  // a sync batch) triggers one reload instead of many.
  const dbChannel = new BroadcastChannel("nook-db");
  let reloadDebounceTimer = null;
  dbChannel.addEventListener("message", (e) => {
    if (e.data?.type !== "changed") return;
    clearTimeout(reloadDebounceTimer);
    reloadDebounceTimer = setTimeout(reloadFromDB, 150);
  });
}

function hasFiles(e) {
  return e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files");
}

// Initialize Bookmarks & Lists
async function initBookmarks() {
  try {
    await NookDB.ready();
    await reloadFromDB();
  } catch (err) {
    console.error("[Nook] Failed to initialize bookmarks:", err);
    showToast("Failed to load bookmarks");
  }
}

// Reloads allItems/allLists from IndexedDB (non-deleted only) and re-renders.
// Used on startup and whenever another extension context (popup, background
// sync) reports a change via the "nook-db" BroadcastChannel.
async function reloadFromDB() {
  const [items, lists] = await Promise.all([NookDB.getAllBookmarks(), NookDB.getAllLists()]);
  allItems = items;
  allLists = lists;
  updateSidebar();
  renderGrid();
}

// Navigation / Filter state changer
function setActiveNavigation(nav, listId, tag) {
  currentNav = nav;
  activeListId = listId;
  activeTag = tag;

  // Close mobile sidebar on navigation
  sidebar.classList.remove("open");

  // Update active state in UI
  document.querySelectorAll(".nav-item").forEach((el) => el.classList.remove("active"));
  document.querySelectorAll(".tag-pill").forEach((el) => el.classList.remove("active"));

  if (nav === "all") {
    document.querySelector('.nav-item[data-nav="all"]')?.classList.add("active");
    currentViewTitle.textContent = "All Bookmarks";
    btnClearFilter.classList.add("hidden");
  } else if (nav === "x") {
    document.querySelector('.nav-item[data-nav="x"]')?.classList.add("active");
    currentViewTitle.textContent = "X / Twitter Bookmarks";
    btnClearFilter.classList.remove("hidden");
  } else if (nav === "chrome") {
    document.querySelector('.nav-item[data-nav="chrome"]')?.classList.add("active");
    currentViewTitle.textContent = "Web Page Bookmarks";
    btnClearFilter.classList.remove("hidden");
  } else if (nav === "unorganized") {
    document.querySelector('.nav-item[data-nav="unorganized"]')?.classList.add("active");
    currentViewTitle.textContent = "Unorganized Bookmarks";
    btnClearFilter.classList.remove("hidden");
  } else if (listId) {
    const listEl = document.querySelector(`.nav-item[data-list-id="${listId}"]`);
    listEl?.classList.add("active");
    const list = allLists.find((l) => l.id === listId);
    currentViewTitle.textContent = list ? `${list.icon || "📁"} ${list.name}` : "List";
    btnClearFilter.classList.remove("hidden");
  } else if (tag) {
    const tagEl = document.querySelector(`.tag-pill[data-tag="${tag}"]`);
    tagEl?.classList.add("active");
    currentViewTitle.textContent = `#${tag}`;
    btnClearFilter.classList.remove("hidden");
  }

  renderGrid();
}

// Update Sidebar (counts, lists, tags)
function updateSidebar() {
  const total = allItems.length;
  const countX = allItems.filter((i) => i.source === "x").length;
  const countChrome = allItems.filter((i) => i.source === "chrome").length;
  const unorganized = allItems.filter((i) => !i.listId).length;
  const withMedia = allItems.filter(hasAnyMedia).length;
  const textOnly = total - withMedia;

  totalCountBadge.textContent = total;
  countAllSpan.textContent = total;
  countMediaSpan.textContent = withMedia;
  countTextSpan.textContent = textOnly;
  navCountAll.textContent = total;
  if (navCountX) navCountX.textContent = countX;
  if (navCountChrome) navCountChrome.textContent = countChrome;
  navCountUnorganized.textContent = unorganized;

  // Render Lists in Sidebar
  listsNav.replaceChildren();
  if (allLists.length === 0) {
    const emptyLists = document.createElement("div");
    emptyLists.style.cssText = "font-size: 12px; color: var(--text-muted); padding: 6px 10px;";
    emptyLists.textContent = "No lists yet. Click + to create one.";
    listsNav.appendChild(emptyLists);
  } else {
    allLists.forEach((list) => {
      const count = allItems.filter((i) => i.listId === list.id).length;
      const item = document.createElement("div");
      item.className = "nav-item list-item" + (activeListId === list.id ? " active" : "");
      item.dataset.listId = list.id;

      const icon = document.createElement("span");
      icon.className = "nav-icon";
      icon.textContent = list.icon || "📁";

      const label = document.createElement("span");
      label.className = "nav-label";
      label.textContent = list.name;

      const countSpan = document.createElement("span");
      countSpan.className = "nav-count";
      countSpan.textContent = count;

      const delBtn = document.createElement("button");
      delBtn.className = "list-delete-btn";
      delBtn.title = "Delete list";
      delBtn.innerHTML = `
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      `;
      delBtn.onclick = (e) => {
        e.stopPropagation();
        confirmDeleteList(list.id, list.name);
      };

      item.append(icon, label, countSpan, delBtn);
      item.onclick = () => {
        setActiveNavigation(null, list.id, null);
      };

      listsNav.appendChild(item);
    });
  }

  // Render Tags in Sidebar
  tagsNav.replaceChildren();
  const tagCountMap = new Map();
  for (const item of allItems) {
    if (Array.isArray(item.tags)) {
      for (const t of item.tags) {
        const clean = t.trim().toLowerCase().replace(/^#/, "");
        if (clean) {
          tagCountMap.set(clean, (tagCountMap.get(clean) || 0) + 1);
        }
      }
    }
  }

  const sortedTags = Array.from(tagCountMap.entries()).sort((a, b) => b[1] - a[1]);

  if (sortedTags.length === 0) {
    const emptyTags = document.createElement("div");
    emptyTags.style.cssText = "font-size: 12px; color: var(--text-muted); padding: 4px 6px;";
    emptyTags.textContent = "No tags yet. Add tags from bookmark details.";
    tagsNav.appendChild(emptyTags);
  } else {
    sortedTags.forEach(([tag, count]) => {
      const pill = document.createElement("div");
      pill.className = "tag-pill" + (activeTag === tag ? " active" : "");
      pill.dataset.tag = tag;

      const name = document.createElement("span");
      name.textContent = `#${tag}`;

      const countSpan = document.createElement("span");
      countSpan.className = "tag-pill-count";
      countSpan.textContent = count;

      pill.append(name, countSpan);
      pill.onclick = () => {
        if (activeTag === tag) {
          setActiveNavigation("all", null, null);
        } else {
          setActiveNavigation(null, null, tag);
        }
      };

      tagsNav.appendChild(pill);
    });
  }
}

// Extract media array safely
function getMediaList(item) {
  if (Array.isArray(item.media) && item.media.length > 0) return item.media;
  if (Array.isArray(item.attachments) && item.attachments.length > 0) return item.attachments;
  return [];
}

// Media on the item itself or inside its quoted tweet
function hasAnyMedia(item) {
  return getMediaList(item).length > 0 || (item.quote?.media?.length || 0) > 0;
}

// Filter and Sort Grid Items
function getFilteredAndSortedItems() {
  let filtered = allItems.filter((item) => {
    // 1. Navigation / List filter
    if (currentNav === "unorganized") {
      if (item.listId) return false;
    } else if (currentNav === "x") {
      if (item.source !== "x") return false;
    } else if (currentNav === "chrome") {
      if (item.source !== "chrome") return false;
    } else if (activeListId) {
      if (item.listId !== activeListId) return false;
    }

    // 2. Tag filter
    if (activeTag) {
      const itemTags = (item.tags || []).map((t) => t.toLowerCase().replace(/^#/, ""));
      if (!itemTags.includes(activeTag.toLowerCase())) return false;
    }

    // 3. Media filter tabs (media inside a quoted tweet counts too)
    if (currentFilter === "media" && !hasAnyMedia(item)) return false;
    if (currentFilter === "text" && hasAnyMedia(item)) return false;

    // 4. Search query
    if (searchQuery) {
      const text = [item.description, item.quote?.text, item.quote?.creator?.name, item.quote?.creator?.handle]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const name = (item.creator?.name || "").toLowerCase();
      const handle = (item.creator?.handle || "").toLowerCase();
      const url = (item.url || "").toLowerCase();
      const tags = (item.tags || []).join(" ").toLowerCase();
      const match =
        text.includes(searchQuery) ||
        name.includes(searchQuery) ||
        handle.includes(searchQuery) ||
        url.includes(searchQuery) ||
        tags.includes(searchQuery);
      if (!match) return false;
    }

    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    const timeA = new Date(a.savedAt || a.createdAt || 0).getTime();
    const timeB = new Date(b.savedAt || b.createdAt || 0).getTime();
    return currentSort === "newest" ? timeB - timeA : timeA - timeB;
  });

  return filtered;
}

// Render Grid
function renderGrid() {
  const items = getFilteredAndSortedItems();
  cardsContainer.replaceChildren();

  if (items.length === 0) {
    cardsContainer.classList.add("hidden");
    emptyState.classList.remove("hidden");

    if (allItems.length === 0) {
      emptyTitle.textContent = "No bookmarks yet";
      emptyDesc.textContent =
        "Browse X (Twitter) and click the bookmark button on any post. Nook will automatically save it here along with photos and video previews.";
    } else {
      emptyTitle.textContent = "No matching bookmarks";
      emptyDesc.textContent =
        "No bookmarks match your search or current filter. Try clearing filters or searching for different keywords.";
    }
    return;
  }

  emptyState.classList.add("hidden");
  cardsContainer.classList.remove("hidden");

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const card = createBookmarkCard(item);
    fragment.appendChild(card);
  }
  cardsContainer.appendChild(fragment);
}

// Create single bookmark card element
function createBookmarkCard(item) {
  const card = document.createElement("article");
  card.className = "bookmark-card";
  card.dataset.id = item.id;

  // Clicking card anywhere opens Detail Modal
  card.addEventListener("click", (e) => {
    if (
      e.target.closest(".action-btn") ||
      e.target.closest(".btn-card-open") ||
      e.target.closest(".media-thumb") ||
      e.target.closest(".media-single") ||
      e.target.closest(".card-list-badge") ||
      e.target.closest("a.quote-card") ||
      e.target.closest(".card-tag-pill")
    ) {
      return;
    }
    openDetailModal(item);
  });

  const creator = item.creator || {};
  const mediaList = getMediaList(item);
  const listObj = allLists.find((l) => l.id === item.listId);
  const itemTags = Array.isArray(item.tags) ? item.tags : [];

  // 1. Card Header
  const header = document.createElement("div");
  header.className = "card-header";

  const authorLink = document.createElement("div");
  authorLink.className = "author-info";

  // Avatar
  if (creator.avatar) {
    const avatarImg = document.createElement("img");
    avatarImg.className = "avatar";
    avatarImg.src = creator.avatar;
    avatarImg.alt = creator.name || creator.handle || "Avatar";
    avatarImg.onerror = () => {
      avatarImg.replaceWith(createAvatarFallback(creator));
    };
    authorLink.appendChild(avatarImg);
  } else {
    authorLink.appendChild(createAvatarFallback(creator));
  }

  // Names
  const isWeb = item.source === "chrome";
  const authorNames = document.createElement("div");
  authorNames.className = "author-names";

  const nameSpan = document.createElement("span");
  nameSpan.className = "author-name";
  nameSpan.textContent = isWeb
    ? item.title || creator.name || creator.handle || "Web Bookmark"
    : creator.name || creator.handle || "X User";

  const handleSpan = document.createElement("span");
  handleSpan.className = "author-handle";
  handleSpan.textContent = isWeb
    ? creator.handle || (item.url ? new URL(item.url).hostname : "")
    : creator.handle || "";

  authorNames.append(nameSpan, handleSpan);
  authorLink.appendChild(authorNames);

  // Link Icon (X logo for x, Globe icon for web)
  const xLink = document.createElement("a");
  xLink.className = "card-x-link";
  xLink.href = item.url || "#";
  xLink.target = "_blank";
  xLink.rel = "noopener noreferrer";
  xLink.title = isWeb ? "Open website" : "Open on X";
  xLink.innerHTML = isWeb
    ? `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="10"></circle>
      <line x1="2" y1="12" x2="22" y2="12"></line>
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1 4-10z"></path>
    </svg>
  `
    : ICONS.xLogo(15);
  xLink.addEventListener("click", (e) => e.stopPropagation());

  header.append(authorLink, xLink);
  card.appendChild(header);

  // 2. Badges Row (List badge + Tags)
  if (listObj || itemTags.length > 0) {
    const badgesWrap = document.createElement("div");
    badgesWrap.className = "card-badges-wrap";

    // List Badge
    if (listObj) {
      const listBadge = document.createElement("span");
      listBadge.className = "card-list-badge";
      listBadge.textContent = `${listObj.icon || "📁"} ${listObj.name}`;
      listBadge.title = `Filter by list: ${listObj.name}`;
      listBadge.onclick = (e) => {
        e.stopPropagation();
        setActiveNavigation(null, listObj.id, null);
      };
      badgesWrap.appendChild(listBadge);
    }

    // Tag Pills
    itemTags.forEach((tag) => {
      const cleanTag = tag.replace(/^#/, "");
      const tagPill = document.createElement("span");
      tagPill.className = "card-tag-pill";
      tagPill.textContent = `#${cleanTag}`;
      tagPill.title = `Filter by tag: #${cleanTag}`;
      tagPill.onclick = (e) => {
        e.stopPropagation();
        setActiveNavigation(null, null, cleanTag);
      };
      badgesWrap.appendChild(tagPill);
    });

    card.appendChild(badgesWrap);
  }

  // 3. Card Body (Tweet text)
  if (item.description) {
    const body = document.createElement("div");
    body.className = "card-body";

    const textEl = document.createElement("div");
    textEl.className = "tweet-text";
    textEl.replaceChildren(formatTweetText(item.description));

    body.appendChild(textEl);
    card.appendChild(body);
  }

  // 4. Media Gallery
  if (mediaList.length > 0) {
    const mediaContainer = createMediaGallery(mediaList);
    card.appendChild(mediaContainer);
  }

  // 4b. Quoted Tweet
  if (item.quote) {
    card.appendChild(createQuoteCard(item.quote));
  }

  // 5. Card Footer
  const footer = document.createElement("div");
  footer.className = "card-footer";

  const footerLeft = document.createElement("div");
  footerLeft.className = "footer-left";
  footerLeft.textContent = formatDate(item.savedAt || item.createdAt);

  const footerActions = document.createElement("div");
  footerActions.className = "footer-actions";

  // "Detay" button
  const detailBtn = document.createElement("button");
  detailBtn.className = "action-btn";
  detailBtn.title = "View details, assign list or tags";
  detailBtn.innerHTML = ICONS.info(14);
  detailBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    openDetailModal(item);
  });

  // "Open" Link (Open on X or Open site)
  const openLink = document.createElement("a");
  openLink.className = "btn-card-open";
  openLink.href = item.url || "#";
  openLink.target = "_blank";
  openLink.rel = "noopener noreferrer";
  openLink.innerHTML = `
    <span>${isWeb ? "Open site" : "Open on X"}</span>
    ${ICONS.externalLink(11)}
  `;
  openLink.addEventListener("click", (e) => e.stopPropagation());

  // Copy Link Button
  const copyBtn = document.createElement("button");
  copyBtn.className = "action-btn";
  copyBtn.title = "Copy link";
  copyBtn.innerHTML = ICONS.copy(14);
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (item.url) {
      navigator.clipboard.writeText(item.url);
      showToast("Link copied to clipboard ✓");
    }
  });

  // Delete Button
  const deleteBtn = document.createElement("button");
  deleteBtn.className = "action-btn delete-btn";
  deleteBtn.title = "Delete bookmark";
  deleteBtn.innerHTML = ICONS.trash(14);
  deleteBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    deleteBookmark(item.id);
  });

  footerActions.append(openLink, detailBtn, copyBtn, deleteBtn);
  footer.append(footerLeft, footerActions);
  card.appendChild(footer);

  return card;
}

// Quoted tweet shown inside a bookmark card / detail modal, like X renders it
function createQuoteCard(quote) {
  const creator = quote.creator || {};
  const box = document.createElement(quote.url ? "a" : "div");
  box.className = "quote-card";
  if (quote.url) {
    box.href = quote.url;
    box.target = "_blank";
    box.rel = "noopener noreferrer";
    box.title = "Open quoted post on X";
    box.addEventListener("click", (e) => e.stopPropagation());
  }

  const header = document.createElement("div");
  header.className = "quote-header";

  if (creator.avatar) {
    const avatarImg = document.createElement("img");
    avatarImg.className = "avatar quote-avatar";
    avatarImg.src = creator.avatar;
    avatarImg.alt = creator.name || creator.handle || "Avatar";
    avatarImg.onerror = () => {
      const fallback = createAvatarFallback(creator);
      fallback.classList.add("quote-avatar");
      avatarImg.replaceWith(fallback);
    };
    header.appendChild(avatarImg);
  } else {
    const fallback = createAvatarFallback(creator);
    fallback.classList.add("quote-avatar");
    header.appendChild(fallback);
  }

  const nameSpan = document.createElement("span");
  nameSpan.className = "quote-name";
  nameSpan.textContent = creator.name || creator.handle || "X User";

  const handleSpan = document.createElement("span");
  handleSpan.className = "quote-handle";
  handleSpan.textContent = [creator.handle, quote.createdAt ? formatDate(quote.createdAt) : null]
    .filter(Boolean)
    .join(" · ");

  header.append(nameSpan, handleSpan);
  box.appendChild(header);

  if (quote.text) {
    const textEl = document.createElement("div");
    textEl.className = "quote-text";
    // Plain text: the whole box is already a link, nested <a> would be invalid
    textEl.textContent = quote.text;
    box.appendChild(textEl);
  }

  if (Array.isArray(quote.media) && quote.media.length > 0) {
    const gallery = createMediaGallery(quote.media);
    gallery.classList.add("quote-media");
    box.appendChild(gallery);
  }

  return box;
}

// Media Gallery Component
function createMediaGallery(mediaList) {
  const container = document.createElement("div");
  container.className = "card-media";

  const count = mediaList.length;

  if (count === 1) {
    const item = mediaList[0];
    const wrapper = document.createElement("div");
    wrapper.className = "media-single";

    const img = document.createElement("img");
    img.src = item.url;
    img.alt = item.alt || "Media";
    img.loading = "lazy";
    img.addEventListener("click", (e) => {
      e.preventDefault(); // may sit inside a quote-card link
      e.stopPropagation();
      openLightbox(item.url);
    });

    wrapper.appendChild(img);

    if (item.type === "video") {
      const badge = document.createElement("div");
      badge.className = "video-overlay";
      badge.innerHTML = `
        ${ICONS.play}
        Video
      `;
      wrapper.appendChild(badge);
    }

    container.appendChild(wrapper);
  } else {
    const grid = document.createElement("div");
    grid.className = count === 2 ? "media-grid-2" : count === 3 ? "media-grid-3" : "media-grid-4";

    const displayItems = mediaList.slice(0, 4);
    displayItems.forEach((media) => {
      const thumb = document.createElement("div");
      thumb.className = "media-thumb";

      const img = document.createElement("img");
      img.src = media.url;
      img.alt = media.alt || "Thumbnail";
      img.loading = "lazy";
      img.addEventListener("click", (e) => {
        e.preventDefault(); // may sit inside a quote-card link
        e.stopPropagation();
        openLightbox(media.url);
      });

      thumb.appendChild(img);
      grid.appendChild(thumb);
    });

    container.appendChild(grid);
  }

  return container;
}

// Format Tweet Text — safe DOM-based version
// Uses createElement instead of innerHTML/regex-replace;
// no quote-injection / href-breakout risk.
function formatTweetText(text) {
  if (!text) return document.createElement("span");

  // Combined tokenizer: splits URLs and @mentions
  const TOKEN_RE = /(https?:\/\/[^\s]+)|(@[a-zA-Z0-9_]+)/g;

  const fragment = document.createDocumentFragment();
  let lastIndex = 0;
  let match;

  while ((match = TOKEN_RE.exec(text)) !== null) {
    // Append the preceding plain-text chunk
    if (match.index > lastIndex) {
      fragment.appendChild(
        document.createTextNode(text.slice(lastIndex, match.index))
      );
    }

    const a = document.createElement("a");
    a.rel = "noopener noreferrer";
    a.target = "_blank";
    // CSP compliant: addEventListener instead of an onclick attribute
    a.addEventListener("click", (e) => e.stopPropagation());

    if (match[1]) {
      // URL match - strip trailing punctuation (e.g. "https://site.com." -> link + ".")
      let url = match[1];
      let trailingPunct = "";
      const punctMatch = url.match(/[.,!?:;)"']+$/);
      if (punctMatch) {
        trailingPunct = punctMatch[0];
        url = url.slice(0, -trailingPunct.length);
      }

      a.href = url;
      a.textContent = url;
      fragment.appendChild(a);

      if (trailingPunct) {
        fragment.appendChild(document.createTextNode(trailingPunct));
      }
    } else {
      // @mention match
      const handle = match[2].slice(1); // strip the "@" character
      a.href = `https://x.com/${handle}`;
      a.textContent = match[2];
      fragment.appendChild(a);
    }

    lastIndex = TOKEN_RE.lastIndex;
  }

  // Sondaki kalan metin
  if (lastIndex < text.length) {
    fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
  }

  const wrapper = document.createElement("span");
  wrapper.appendChild(fragment);
  return wrapper;
}

// Open Detail Modal
function openDetailModal(item) {
  activeDetailItem = item;
  const creator = item.creator || {};

  // Setup Author
  modalAuthorInfo.replaceChildren();
  if (creator.avatar) {
    const avatarImg = document.createElement("img");
    avatarImg.className = "avatar";
    avatarImg.src = creator.avatar;
    avatarImg.onerror = () => {
      avatarImg.replaceWith(createAvatarFallback(creator));
    };
    modalAuthorInfo.appendChild(avatarImg);
  } else {
    modalAuthorInfo.appendChild(createAvatarFallback(creator));
  }

  const names = document.createElement("div");
  names.className = "author-names";

  const nameSpan = document.createElement("span");
  nameSpan.className = "author-name";
  nameSpan.textContent = creator.name || creator.handle || "X User";

  const handleSpan = document.createElement("span");
  handleSpan.className = "author-handle";
  handleSpan.textContent = creator.handle || "";

  names.append(nameSpan, handleSpan);
  modalAuthorInfo.appendChild(names);

  // Setup Text
  modalTweetText.replaceChildren(formatTweetText(item.description || "No text content"));

  // Setup Media
  modalMediaGallery.replaceChildren();
  const mediaList = getMediaList(item);
  if (mediaList.length > 0) {
    mediaList.forEach((media) => {
      const mediaBox = document.createElement("div");
      mediaBox.className = "modal-media-item";

      const img = document.createElement("img");
      img.src = media.url;
      img.alt = media.alt || "Media preview";
      img.addEventListener("click", () => openLightbox(media.url));

      mediaBox.appendChild(img);

      if (media.type === "video") {
        const badge = document.createElement("div");
        badge.className = "video-overlay";
        badge.innerHTML = `
          ${ICONS.play}
          Video Preview
        `;
        mediaBox.appendChild(badge);
      }

      modalMediaGallery.appendChild(mediaBox);
    });
  }

  // Setup Quoted Tweet
  modalQuote.replaceChildren();
  if (item.quote) {
    modalQuote.appendChild(createQuoteCard(item.quote));
  }

  // Setup List Selector in Modal
  modalListSelect.replaceChildren();
  const noListOpt = document.createElement("option");
  noListOpt.value = "";
  noListOpt.textContent = "(No List)";
  modalListSelect.appendChild(noListOpt);

  allLists.forEach((l) => {
    const opt = document.createElement("option");
    opt.value = l.id;
    opt.textContent = `${l.icon || "📁"} ${l.name}`;
    modalListSelect.appendChild(opt);
  });

  modalListSelect.value = item.listId || "";
  modalListSelect.onchange = async () => {
    const selectedId = modalListSelect.value || null;
    const selectedList = allLists.find((l) => l.id === selectedId);
    item.listId = selectedId;
    item.listName = selectedList ? selectedList.name : null;

    await saveUpdatedItem(item);
    updateSidebar();
    renderGrid();
    showToast(selectedList ? `Moved to "${selectedList.name}"` : "Removed from list");
  };

  // Setup Tags in Modal
  renderModalTags(item);

  // Setup Dates & Links
  modalTweetDate.textContent = item.createdAt ? new Date(item.createdAt).toLocaleString() : "Unknown";
  modalSavedDate.textContent = item.savedAt ? new Date(item.savedAt).toLocaleString() : "Unknown";

  if (item.url) {
    const isWeb = item.source === "chrome";
    modalTweetUrl.textContent = item.url;
    modalTweetUrl.href = item.url;
    modalBtnOpenX.href = item.url;
    modalBtnOpenX.classList.remove("hidden");
    modalBtnOpenX.innerHTML = `
      <span>${isWeb ? "Open site" : "Open on X"}</span>
      ${ICONS.externalLink(14)}
    `;
  } else {
    modalTweetUrl.textContent = "No URL available";
    modalTweetUrl.removeAttribute("href");
    modalBtnOpenX.classList.add("hidden");
  }

  // Actions
  modalBtnCopyText.onclick = () => {
    if (item.description) {
      navigator.clipboard.writeText(item.description);
      showToast("Tweet text copied ✓");
    }
  };

  modalBtnCopyUrl.onclick = () => {
    if (item.url) {
      navigator.clipboard.writeText(item.url);
      showToast("Link copied to clipboard ✓");
    }
  };

  modalBtnDelete.onclick = () => {
    deleteBookmark(item.id);
    closeDetailModal();
  };

  detailModal.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function renderModalTags(item) {
  modalTagsList.replaceChildren();
  if (!Array.isArray(item.tags)) item.tags = [];

  item.tags.forEach((tag) => {
    const clean = tag.replace(/^#/, "");
    const chip = document.createElement("span");
    chip.className = "modal-tag-chip";

    const name = document.createElement("span");
    name.textContent = `#${clean}`;

    const rmBtn = document.createElement("button");
    rmBtn.className = "modal-tag-remove";
    rmBtn.innerHTML = `
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    `;
    rmBtn.onclick = async () => {
      item.tags = item.tags.filter((t) => t.replace(/^#/, "").toLowerCase() !== clean.toLowerCase());
      await saveUpdatedItem(item);
      renderModalTags(item);
      updateSidebar();
      renderGrid();
    };

    chip.append(name, rmBtn);
    modalTagsList.appendChild(chip);
  });

  // Tag input
  modalTagInput.value = "";
  modalTagInput.onkeydown = async (e) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      const val = modalTagInput.value.trim().toLowerCase().replace(/^#/, "");
      if (val && !item.tags.map((t) => t.toLowerCase().replace(/^#/, "")).includes(val)) {
        item.tags.push(val);
        await saveUpdatedItem(item);
        renderModalTags(item);
        updateSidebar();
        renderGrid();
      }
      modalTagInput.value = "";
    }
  };

  // Suggested Tags (system tags not already added)
  modalSuggestedTags.replaceChildren();
  const allSystemTags = new Set();
  allItems.forEach((i) => {
    (i.tags || []).forEach((t) => allSystemTags.add(t.replace(/^#/, "").toLowerCase()));
  });

  const currentItemTags = item.tags.map((t) => t.replace(/^#/, "").toLowerCase());
  const suggestions = Array.from(allSystemTags).filter((t) => !currentItemTags.includes(t));

  if (suggestions.length > 0) {
    suggestions.slice(0, 8).forEach((st) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "suggested-tag-btn";
      btn.textContent = `+ #${st}`;
      btn.onclick = async () => {
        item.tags.push(st);
        await saveUpdatedItem(item);
        renderModalTags(item);
        updateSidebar();
        renderGrid();
      };
      modalSuggestedTags.appendChild(btn);
    });
  }
}

function closeDetailModal() {
  detailModal.classList.add("hidden");
  activeDetailItem = null;
  document.body.style.overflow = "";
}

// Lightbox modal controls
function openLightbox(url) {
  lightboxImg.src = url;
  lightbox.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeLightbox() {
  lightbox.classList.add("hidden");
  lightboxImg.src = "";
  if (detailModal.classList.contains("hidden") && listModal.classList.contains("hidden")) {
    document.body.style.overflow = "";
  }
}

// Save an item that has updated tags or listId — writes only this one
// record to IndexedDB, not the whole in-memory array.
async function saveUpdatedItem(item) {
  const saved = await NookDB.putBookmark(item);
  const idx = allItems.findIndex((i) => i.id === saved.id);
  if (idx >= 0) allItems[idx] = saved;
}

// New List Modal Controls
function openListModal() {
  selectedEmoji = "📁";
  listNameInput.value = "";
  emojiPicker.querySelectorAll(".emoji-chip").forEach((c) => {
    c.classList.toggle("active", c.dataset.emoji === "📁");
  });
  listModal.classList.remove("hidden");
  listNameInput.focus();
}

function closeListModal() {
  listModal.classList.add("hidden");
}

async function handleSaveNewList() {
  const name = listNameInput.value.trim();
  if (!name) {
    showToast("Please enter a list name");
    return;
  }

  const newList = await NookDB.putList({
    id: "list_" + Date.now(),
    name,
    icon: selectedEmoji || "📁",
    createdAt: new Date().toISOString()
  });

  allLists.push(newList);

  closeListModal();
  updateSidebar();
  setActiveNavigation(null, newList.id, null);
  showToast(`Created list "${newList.name}" ✓`);
}

async function confirmDeleteList(listId, listName) {
  const confirmed = window.confirm(
    `Are you sure you want to delete the list "${listName}"? Bookmarks in this list will NOT be deleted, they will simply become unorganized.`
  );

  if (!confirmed) return;

  // Soft-deletes the list and clears listId/listName on its bookmarks in a
  // single IndexedDB transaction, then reload since many records changed.
  await NookDB.softDeleteList(listId);
  await reloadFromDB();

  if (activeListId === listId) {
    setActiveNavigation("all", null, null);
  } else {
    updateSidebar();
    renderGrid();
  }

  showToast(`Deleted list "${listName}"`);
}

// Delete Bookmark (soft delete — the record stays as a tombstone in IndexedDB)
async function deleteBookmark(id) {
  try {
    await NookDB.softDeleteBookmark(id);

    allItems = allItems.filter((item) => item.id !== id);
    updateSidebar();
    renderGrid();
    showToast("Bookmark deleted");
  } catch (err) {
    console.error("[Nook] Failed to delete item:", err);
    showToast("Failed to delete bookmark");
  }
}

// Clear all bookmarks
async function confirmClearAll() {
  if (!allItems.length) {
    showToast("No bookmarks to clear");
    return;
  }

  const confirmed = window.confirm(
    "Are you sure you want to delete ALL bookmarks? This action cannot be undone."
  );

  if (confirmed) {
    await NookDB.softDeleteAllBookmarks();
    allItems = [];
    updateSidebar();
    renderGrid();
    showToast("All bookmarks cleared");
  }
}

// Export as JSON file (includes both items and lists)
function exportBookmarks() {
  if (!allItems.length && !allLists.length) {
    showToast("Nothing to export");
    return;
  }

  const exportPayload = {
    items: allItems,
    lists: allLists,
    exportedAt: new Date().toISOString()
  };

  const dataStr =
    "data:text/json;charset=utf-8," +
    encodeURIComponent(JSON.stringify(exportPayload, null, 2));
  const downloadAnchor = document.createElement("a");
  downloadAnchor.setAttribute("href", dataStr);
  const dateStr = new Date().toISOString().split("T")[0];
  downloadAnchor.setAttribute("download", `nook-bookmarks-${dateStr}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();

  showToast("Bookmarks and lists exported successfully ✓");
}

// Handle JSON File Import (both legacy array and { items, lists })
function handleFileImport(file) {
  if (!file.name.endsWith(".json")) {
    showToast("Please select a valid .json file");
    return;
  }

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const content = e.target?.result;
      const parsed = JSON.parse(content);

      const incomingItems = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.items)
        ? parsed.items
        : [];

      const incomingLists = Array.isArray(parsed.lists) ? parsed.lists : [];

      if (incomingItems.length === 0 && incomingLists.length === 0) {
        showToast("No bookmarks or lists found in file");
        return;
      }

      // Upsert items by id, keeping existing fields an incoming record
      // doesn't carry (e.g. an older export missing a newer field).
      const existingItemById = new Map(allItems.map((item) => [item.id, item]));
      const itemsToWrite = incomingItems
        .filter((item) => item?.id)
        .map((item) => ({ ...existingItemById.get(item.id), ...item }));
      const newItemCount = itemsToWrite.filter((item) => !existingItemById.has(item.id)).length;

      const existingListById = new Map(allLists.map((l) => [l.id, l]));
      const listsToWrite = incomingLists
        .filter((l) => l?.id)
        .map((l) => ({ ...existingListById.get(l.id), ...l }));

      await NookDB.putBookmarks(itemsToWrite);
      for (const list of listsToWrite) {
        await NookDB.putList(list);
      }

      await reloadFromDB();

      showToast(`Imported ${incomingItems.length} bookmarks (${newItemCount} new) & ${incomingLists.length} lists ✓`);
    } catch (err) {
      console.error("[Nook] Import error:", err);
      showToast("Invalid JSON file: " + err.message);
    }
  };

  reader.readAsText(file);
}

// Toast notification helper
let toastTimeout;
function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");

  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => {
    toast.classList.add("hidden");
  }, 2800);
}
