import * as NookDB from "../../lib/db";
import * as NookShared from "../../lib/shared";

type UIElement = HTMLElement & { value: any; files: FileList | null; src: string; href: string; dataset: DOMStringMap; textContent: any };
const byId = (id: string): UIElement => document.getElementById(id) as UIElement;
const queryOne = (selector: string): UIElement => document.querySelector(selector) as UIElement;
const queryAll = (selector: string): UIElement[] => Array.from(document.querySelectorAll(selector)) as UIElement[];

const { ICONS, createAvatarFallback } = NookShared;

async function loadItems() {
  const container = queryOne("#items");
  const countBadge = queryOne("#popup-count");
  const openDashboardBtn = queryOne("#open-dashboard");

  // Setup dashboard button
  if (openDashboardBtn) {
    openDashboardBtn.onclick = () => {
      chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
    };
  }

  const syncXBtn = queryOne("#sync-x-btn");
  if (syncXBtn) {
    syncXBtn.onclick = () => {
      syncXBtn.textContent = "Syncing...";
      syncXBtn.style.opacity = "0.5";
      syncXBtn.style.pointerEvents = "none";
      chrome.runtime.sendMessage({ type: "START_AUTO_SYNC_X" }, (res) => {
         window.close(); // Close popup when tab opens
      });
    };
  }

  await NookDB.ready();
  const items = await NookDB.getAllBookmarks();
  const lists = await NookDB.getAllLists();

  if (countBadge) {
    countBadge.textContent = String(items.length);
  }

  container.replaceChildren();

  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No bookmarks yet. Click the bookmark icon on X to save posts.";
    container.appendChild(empty);
    return;
  }

  for (const item of items) {
    const card = document.createElement("div");
    card.className = "item";
    card.style.cursor = "pointer";

    // Clicking card opens the tweet on X directly
    card.onclick = (e) => {
      if ((e.target as Element).closest(".btn-del")) return;
      if (item.url) {
        chrome.tabs.create({ url: item.url });
      } else {
        chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
      }
    };

    // Item Header (Author & delete)
    const header = document.createElement("div");
    header.className = "item-header";

    const author = document.createElement("div");
    author.className = "author";

    if (item.creator?.avatar) {
      const avatar = document.createElement("img");
      avatar.className = "avatar";
      avatar.src = item.creator.avatar;
      avatar.onerror = () => {
        avatar.replaceWith(createAvatarFallback(item.creator));
      };
      author.appendChild(avatar);
    } else {
      author.appendChild(createAvatarFallback(item.creator));
    }

    const isWeb = item.source === "chrome";
    const creator = document.createElement("div");
    creator.className = "creator";
    creator.textContent = isWeb
      ? item.title || item.creator?.name || item.creator?.handle || "Web Bookmark"
      : item.creator?.name || item.creator?.handle || "X Post";
    author.appendChild(creator);

    const delBtn = document.createElement("button");
    delBtn.className = "btn-del";
    delBtn.title = "Delete";
    delBtn.innerHTML = ICONS.trash(12, { round: false });
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      await deleteItem(item.id);
    };

    header.append(author, delBtn);
    card.appendChild(header);

    // List & Tags Badges in Popup
    const listObj = (lists || []).find((l) => l.id === item.listId);
    const itemTags = Array.isArray(item.tags) ? item.tags : [];
    if (listObj || itemTags.length > 0) {
      const badges = document.createElement("div");
      badges.className = "item-badges";

      if (listObj) {
        const lb = document.createElement("span");
        lb.className = "item-list-badge";
        lb.textContent = `${listObj.icon || "📁"} ${listObj.name}`;
        badges.appendChild(lb);
      }

      itemTags.slice(0, 3).forEach((t) => {
        const tb = document.createElement("span");
        tb.className = "item-tag";
        tb.textContent = `#${t.replace(/^#/, "")}`;
        badges.appendChild(tb);
      });

      card.appendChild(badges);
    }

    // Tweet text
    if (item.description) {
      const text = document.createElement("div");
      text.className = "text";
      text.textContent = item.description;
      card.appendChild(text);
    }

    // Media Preview (if available)
    const mediaList = item.media || item.attachments || [];
    if (mediaList.length > 0) {
      const firstMedia = mediaList[0];
      const mediaBox = document.createElement("div");
      mediaBox.className = "media-preview";

      const img = document.createElement("img");
      img.src = firstMedia.url;
      img.alt = firstMedia.alt || "Thumbnail";
      img.loading = "lazy";
      mediaBox.appendChild(img);

      if (mediaList.length > 1) {
        const badge = document.createElement("div");
        badge.className = "media-badge";
        badge.textContent = `+${mediaList.length - 1}`;
        mediaBox.appendChild(badge);
      } else if (firstMedia.type === "video") {
        const badge = document.createElement("div");
        badge.className = "media-badge";
        badge.textContent = "Video";
        mediaBox.appendChild(badge);
      }

      card.appendChild(mediaBox);
    }

    // Item Footer
    const footer = document.createElement("div");
    footer.className = "item-footer";

    const link = document.createElement("a");
    link.className = "url";
    link.href = item.url || "#";
    link.target = "_blank";
    link.onclick = (e) => e.stopPropagation();
    link.innerHTML = `
      <span>${isWeb ? "Open site" : "Open on X"}</span>
      ${ICONS.externalLink(10)}
    `;

    footer.appendChild(link);
    card.appendChild(footer);

    container.appendChild(card);
  }
}

async function deleteItem(id: string) {
  await NookDB.softDeleteBookmark(id);
  loadItems();
}

loadItems();
