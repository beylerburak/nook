/**
 * Nook IndexedDB Storage Layer
 *
 * Thin promise wrapper over raw IndexedDB, replacing the old design where
 * chrome.storage.local held one big "items" array and one big "lists" array
 * that got read-modify-written in full on every single change. Each
 * bookmark/list is now its own IndexedDB record, so a single tag edit only
 * touches that one record.
 *
 * Every record carries `updatedAt` (ISO string, set on every write) and
 * `deletedAt` (ISO string or null). Deletes are SOFT — we set `deletedAt`
 * instead of removing the row — so a future self-hosted backend (Postgres +
 * REST API) can sync against this store via "give me everything changed
 * since timestamp X", tombstones included (see getChangesSince).
 *
 * UMD-ish export, same pattern as x-parser.js / shared.js, so this file can
 * be loaded as a plain <script> (dashboard.html / popup.html), via
 * importScripts (background.js, a classic service worker) and required from
 * Node tests (tests/db.test.js, via fake-indexeddb). Everything lives inside
 * the factory function — no top-level const/let/function leaks into the
 * shared global scope that other extension scripts run in.
 */



  const DB_VERSION = 2;
  const STORE_BOOKMARKS = "bookmarks";
  const STORE_LISTS = "lists";
  const STORE_META = "meta";

  // Overridable for tests (each test gets its own DB name so state never
  // leaks between them). Changing it only takes effect before open()/ready()
  // is first called — see _resetForTests().
  let _dbName = "nook";

  // Memoized promises so open()/ready() only do their work once per context
  // (once per service worker lifetime, once per dashboard/popup page load).
  let _dbPromise: Promise<IDBDatabase> | null = null;
  let _readyPromise: Promise<unknown> | null = null;

  // -- small IndexedDB promise helpers ---------------------------------

  function promisifyRequest<T = any>(request: IDBRequest<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function promisifyTransaction(tx: IDBTransaction): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    });
  }

  function nowIso() {
    return new Date().toISOString();
  }

  // -- open / schema -----------------------------------------------------

  function open(): Promise<IDBDatabase> {
    if (_dbPromise) return _dbPromise;

    _dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(_dbName, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        const upgrade = request.transaction!;

        if (!db.objectStoreNames.contains(STORE_BOOKMARKS)) {
          const bookmarks = db.createObjectStore(STORE_BOOKMARKS, { keyPath: "id" });
          bookmarks.createIndex("url", "url");
          bookmarks.createIndex("source", "source");
          bookmarks.createIndex("listId", "listId");
          bookmarks.createIndex("savedAt", "savedAt");
          bookmarks.createIndex("updatedAt", "updatedAt");
        }

        // v2: urlKey (normalized URL) index for duplicate-free page lookups.
        const bookmarkStore = upgrade.objectStore(STORE_BOOKMARKS);
        if (!bookmarkStore.indexNames.contains("urlKey")) {
          bookmarkStore.createIndex("urlKey", "urlKey");
          if (event.oldVersion > 0) backfillUrlKeys(bookmarkStore);
        }

        if (!db.objectStoreNames.contains(STORE_LISTS)) {
          const lists = db.createObjectStore(STORE_LISTS, { keyPath: "id" });
          lists.createIndex("updatedAt", "updatedAt");
        }

        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "key" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    return _dbPromise;
  }

  // -- change notification -------------------------------------------------

  // Lets other extension contexts (dashboard, popup) know a write happened
  // so they can reload from the DB, instead of chrome.storage.onChanged
  // which only fired for whole-array chrome.storage.local writes. Guarded
  // because BroadcastChannel doesn't exist in the Node test environment.
  function notifyChange(stores: string[], ids: string[] = []) {
    // Alarms wake the MV3 service worker even when all Nook pages are closed.
    if (typeof chrome !== "undefined" && chrome.alarms?.create) {
      void chrome.alarms.create("nook-cloud-sync-soon", { delayInMinutes: 0.1 });
    }
    if (typeof BroadcastChannel === "undefined") return;
    try {
      const channel = new BroadcastChannel("nook-db");
      channel.postMessage({ type: "changed", stores, ids });
      channel.close();
    } catch (e) {
      // Ignore — never let a notification failure break the caller's write.
    }
  }

  // -- bookmarks -----------------------------------------------------------

  async function getAllBookmarks({ includeDeleted = false }: { includeDeleted?: boolean } = {}): Promise<Bookmark[]> {
    const db = await open();
    const tx = db.transaction(STORE_BOOKMARKS, "readonly");
    const all = await promisifyRequest<Bookmark[]>(tx.objectStore(STORE_BOOKMARKS).getAll());
    return includeDeleted ? all : all.filter((item) => !item.deletedAt);
  }

  async function getBookmark(id: string): Promise<Bookmark | undefined> {
    const db = await open();
    const tx = db.transaction(STORE_BOOKMARKS, "readonly");
    return promisifyRequest<Bookmark | undefined>(tx.objectStore(STORE_BOOKMARKS).get(id));
  }

  // Non-deleted only — used for dedupe on save, so a soft-deleted bookmark
  // never silently blocks re-saving the same URL.
  //
  // Tries an exact match first (cheap index lookup, and backward compatible
  // with rows saved before URL normalization existed). Falls back to
  // comparing normalized URLs across the whole store so a link that gained
  // or lost a tracking param/hash since it was saved still dedupes.
  /**
   * Finds the bookmark for a page URL by its normalized form (tracking params and
   * hash ignored), via the urlKey index. A live bookmark always wins; with
   * `includeDeleted`, a soft-deleted one is returned when no live one exists, so
   * re-saving restores it with its note, tags and collection.
   */
  async function findBookmarkByUrl(url: string, options: { includeDeleted?: boolean } = {}): Promise<Bookmark | null> {
    const db = await open();
    const tx = db.transaction(STORE_BOOKMARKS, "readonly");
    const index = tx.objectStore(STORE_BOOKMARKS).index("urlKey");
    const matches = await promisifyRequest<Bookmark[]>(index.getAll(normalizeUrlForDedupe(url)));
    const live = matches.find((item) => !item.deletedAt);
    if (live) return live;
    if (!options.includeDeleted || matches.length === 0) return null;
    // Most recently removed first: that's the one the user means to bring back.
    return [...matches].sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)))[0];
  }



  function withWriteDefaults<T extends Bookmark | BookmarkList>(item: T): T {
    return withUrlKey({
      ...item,
      updatedAt: nowIso(),
      deletedAt: item.deletedAt === undefined ? null : item.deletedAt
    });
  }

  /** Keeps a bookmark's `urlKey` (its normalized URL, indexed) in sync with `url`. */
  function withUrlKey<T extends Bookmark | BookmarkList>(item: T): T {
    if (!("url" in item)) return item;
    const url = typeof item.url === "string" ? item.url : "";
    return { ...item, urlKey: url ? normalizeUrlForDedupe(url) : undefined };
  }

  function backfillUrlKeys(store: IDBObjectStore): void {
    const cursorRequest = store.openCursor();
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor) return;
      cursor.update(withUrlKey(cursor.value as Bookmark));
      cursor.continue();
    };
  }

  // Saves `item` under its own id, restoring it if it previously existed and
  // was soft-deleted (a deliberate re-save should win over an old tombstone),
  // and leaving it untouched if it's already saved and not deleted. Shared by
  // the X "SAVE_ITEM" flow (Nook action-bar button / native bookmark) and the
  // popup's SAVE_ACTIVE_PAGE path so both save X posts the same way.
  async function saveOrRestoreBookmark(item: Bookmark): Promise<Bookmark> {
    const existing = await getBookmark(item.id);
    if (existing && !existing.deletedAt) return existing;
    if (existing && existing.deletedAt) {
      return putBookmark({ ...existing, ...item, id: existing.id, deletedAt: null });
    }
    return putBookmark(item);
  }

  async function putBookmark(item: Bookmark): Promise<Bookmark> {
    const db = await open();
    const tx = db.transaction(STORE_BOOKMARKS, "readwrite");
    const record = withWriteDefaults(item);
    await promisifyRequest(tx.objectStore(STORE_BOOKMARKS).put(record));
    await promisifyTransaction(tx);
    notifyChange([STORE_BOOKMARKS], [record.id]);
    return record;
  }

  async function putBookmarks(items: Bookmark[]): Promise<Bookmark[]> {
    if (!Array.isArray(items) || items.length === 0) return [];
    const db = await open();
    const tx = db.transaction(STORE_BOOKMARKS, "readwrite");
    const store = tx.objectStore(STORE_BOOKMARKS);
    const records = items.map(withWriteDefaults);
    for (const record of records) {
      store.put(record);
    }
    await promisifyTransaction(tx);
    notifyChange([STORE_BOOKMARKS], records.map((r) => r.id));
    return records;
  }

  async function updateBookmark(id: string, patch: Partial<Bookmark>): Promise<Bookmark | null> {
    const db = await open();
    const tx = db.transaction(STORE_BOOKMARKS, "readwrite");
    const store = tx.objectStore(STORE_BOOKMARKS);
    const existing = await promisifyRequest<Bookmark | undefined>(store.get(id));
    if (!existing) {
      await promisifyTransaction(tx);
      return null;
    }
    const record = withUrlKey({ ...existing, ...patch, id, updatedAt: nowIso() });
    await promisifyRequest(store.put(record));
    await promisifyTransaction(tx);
    notifyChange([STORE_BOOKMARKS], [id]);
    return record;
  }

  async function softDeleteBookmark(id: string): Promise<Bookmark | null> {
    return updateBookmark(id, { deletedAt: nowIso() });
  }

  async function softDeleteAllBookmarks(): Promise<string[]> {
    const db = await open();
    const tx = db.transaction(STORE_BOOKMARKS, "readwrite");
    const store = tx.objectStore(STORE_BOOKMARKS);
    const all = await promisifyRequest<Bookmark[]>(store.getAll());
    const ts = nowIso();
    const ids = [];
    for (const item of all) {
      if (item.deletedAt) continue;
      store.put({ ...item, deletedAt: ts, updatedAt: ts });
      ids.push(item.id);
    }
    await promisifyTransaction(tx);
    notifyChange([STORE_BOOKMARKS], ids);
    return ids;
  }

  // -- lists -----------------------------------------------------------------

  async function getAllLists({ includeDeleted = false }: { includeDeleted?: boolean } = {}): Promise<BookmarkList[]> {
    const db = await open();
    const tx = db.transaction(STORE_LISTS, "readonly");
    const all = await promisifyRequest<BookmarkList[]>(tx.objectStore(STORE_LISTS).getAll());
    return includeDeleted ? all : all.filter((list) => !list.deletedAt);
  }

  async function putList(list: BookmarkList): Promise<BookmarkList> {
    const db = await open();
    const tx = db.transaction(STORE_LISTS, "readwrite");
    const record = withWriteDefaults(list);
    await promisifyRequest(tx.objectStore(STORE_LISTS).put(record));
    await promisifyTransaction(tx);
    notifyChange([STORE_LISTS], [record.id]);
    return record;
  }

  // Soft-deletes the list AND clears listId/listName on its bookmarks, in
  // the same transaction, so a crash/close between the two writes can never
  // leave bookmarks pointing at a list that no longer exists.
  async function softDeleteList(id: string): Promise<{ listId: string; clearedBookmarkIds: string[] }> {
    const db = await open();
    const tx = db.transaction([STORE_LISTS, STORE_BOOKMARKS], "readwrite");
    const listStore = tx.objectStore(STORE_LISTS);
    const bookmarkStore = tx.objectStore(STORE_BOOKMARKS);
    const ts = nowIso();

    const existingList = await promisifyRequest<BookmarkList | undefined>(listStore.get(id));
    if (existingList) {
      listStore.put({ ...existingList, deletedAt: ts, updatedAt: ts });
    }

    const affected = await promisifyRequest<Bookmark[]>(bookmarkStore.index("listId").getAll(id));
    const clearedIds = [];
    for (const item of affected) {
      bookmarkStore.put({ ...item, listId: null, listName: null, updatedAt: ts });
      clearedIds.push(item.id);
    }

    await promisifyTransaction(tx);
    notifyChange([STORE_LISTS, STORE_BOOKMARKS], [id, ...clearedIds]);
    return { listId: id, clearedBookmarkIds: clearedIds };
  }

  // -- sync helpers (for a future Postgres + REST backend) --------------------

  // Returns everything (including tombstones) changed strictly after
  // `isoTimestamp`, so a future sync loop can call this repeatedly with the
  // last-seen timestamp and never re-fetch a record it already has.
  async function getChangesSince(isoTimestamp: string | null): Promise<{ bookmarks: Bookmark[]; lists: BookmarkList[] }> {
    const db = await open();
    const tx = db.transaction([STORE_BOOKMARKS, STORE_LISTS], "readonly");
    const range = isoTimestamp ? IDBKeyRange.lowerBound(isoTimestamp, true) : undefined;

    const bookmarks = await promisifyRequest<Bookmark[]>(
      tx.objectStore(STORE_BOOKMARKS).index("updatedAt").getAll(range)
    );
    const lists = await promisifyRequest<BookmarkList[]>(
      tx.objectStore(STORE_LISTS).index("updatedAt").getAll(range)
    );

    return { bookmarks, lists };
  }

  async function getMeta<T = any>(key: string): Promise<T | undefined> {
    const db = await open();
    const tx = db.transaction(STORE_META, "readonly");
    const record = await promisifyRequest<{ key: string; value: T } | undefined>(tx.objectStore(STORE_META).get(key));
    return record ? record.value : undefined;
  }

  async function setMeta<T>(key: string, value: T): Promise<T> {
    const db = await open();
    const tx = db.transaction(STORE_META, "readwrite");
    tx.objectStore(STORE_META).put({ key, value });
    await promisifyTransaction(tx);
    return value;
  }

  // Remote rows keep the server's record timestamps. Using putBookmark/putList
  // here would stamp a new local updatedAt and incorrectly queue an echo write.
  async function applyRemoteRecords(bookmarks: Bookmark[], lists: BookmarkList[]): Promise<void> {
    if (bookmarks.length === 0 && lists.length === 0) return;
    const db = await open();
    const tx = db.transaction([STORE_BOOKMARKS, STORE_LISTS], "readwrite");
    const bookmarkStore = tx.objectStore(STORE_BOOKMARKS);
    const listStore = tx.objectStore(STORE_LISTS);
    for (const item of bookmarks) bookmarkStore.put(withUrlKey(item));
    for (const list of lists) listStore.put(list);
    await promisifyTransaction(tx);
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel("nook-db");
      channel.postMessage({ type: "changed", stores: [STORE_BOOKMARKS, STORE_LISTS], ids: [...bookmarks, ...lists].map((row) => row.id) });
      channel.close();
    }
  }

  // Inserts brand-new items and merges incoming content into existing ones
  // via mergeFn(existing, incoming) => merged|null, all inside ONE
  // readwrite transaction (so a batch from the X bookmarks sync can't
  // interleave with e.g. a concurrent SAVE_ITEM and lose a write the way
  // the old read-modify-write-whole-array chrome.storage.local code could).
  //
  // A soft-deleted existing item is intentionally left alone — neither
  // added nor updated — so an X sync batch can never resurrect a bookmark
  // the user deliberately deleted.
  async function mergeBatch(incomingItems: Bookmark[], mergeFn: (existing: Bookmark, incoming: Bookmark) => Bookmark | null): Promise<{ added: Bookmark[]; updated: Bookmark[] }> {
    const db = await open();
    const tx = db.transaction(STORE_BOOKMARKS, "readwrite");
    const store = tx.objectStore(STORE_BOOKMARKS);
    const now = nowIso();
    const added = [];
    const updated = [];

    for (const incoming of incomingItems || []) {
      if (!incoming || !incoming.id) continue;
      const existing = await promisifyRequest<Bookmark | undefined>(store.get(incoming.id));

      if (!existing) {
        const record = withWriteDefaults(incoming);
        store.put(record);
        added.push(record);
        continue;
      }

      if (existing.deletedAt) {
        // User deleted this on purpose — do not resurrect it from a sync batch.
        continue;
      }

      const merged = mergeFn(existing, incoming);
      if (merged) {
        const record = withUrlKey({ ...merged, updatedAt: now, deletedAt: null });
        store.put(record);
        updated.push(record);
      }
    }

    await promisifyTransaction(tx);
    notifyChange([STORE_BOOKMARKS], [...added, ...updated].map((r) => r.id));
    return { added, updated };
  }

  // Fields of an "x" bookmark that a fresher parse of the same tweet may
  // have picked up (e.g. an older parser missed the quoted tweet or media).
  // Moved here from background.js so it's usable from mergeBatch and unit
  // testable without loading the whole service worker.
  const TWEET_CONTENT_FIELDS = ["title", "shortDescription", "description", "media", "attachments", "creator", "quote", "xSortIndex"];

  // Returns an updated copy of `existing` when `incoming` (freshly parsed
  // from the X API) carries newer tweet content, or null when nothing
  // changed. Used as the mergeFn passed to mergeBatch() for X sync batches.
  // A DOM-parsed save only ever carries a video's poster, never `videoUrl`
  // (the playable MP4 only comes from X's GraphQL API, see
  // entrypoints/content/video-media-registry.ts) — so a later DOM save of
  // the same tweet must not wipe a `videoUrl` a sync already attached to
  // that media item. Fills any gaps in `incomingMedia` from the matching
  // (same `url`, i.e. same poster) item in `existingMedia`.
  function preserveVideoUrls(existingMedia: unknown, incomingMedia: unknown): unknown {
    if (!Array.isArray(existingMedia) || !Array.isArray(incomingMedia)) return incomingMedia;
    return incomingMedia.map((item: Media) => {
      if (!item || item.videoUrl || !item.url) return item;
      const match = (existingMedia as Media[]).find((e) => e && e.url === item.url && e.videoUrl);
      return match ? { ...item, videoUrl: match.videoUrl } : item;
    });
  }

  function mergeTweetContent(existing: Bookmark, incoming: Bookmark): Bookmark | null {
    if (existing.source !== "x") return null;
    let changed = false;
    const merged = { ...existing };
    for (const field of TWEET_CONTENT_FIELDS) {
      if (incoming[field] === undefined) continue;

      let incomingValue: unknown = incoming[field];

      if (field === "media" || field === "attachments") {
        // An incomplete X response must not erase media already captured from
        // the page or restored from an export. X cannot remove media from a
        // tweet while it remains bookmarked, so an empty parse is not newer data.
        if (Array.isArray(existing[field]) && existing[field].length > 0 && Array.isArray(incomingValue) && incomingValue.length === 0) {
          continue;
        }
        incomingValue = preserveVideoUrls(existing[field], incomingValue);
      }

      if (JSON.stringify(existing[field] ?? null) !== JSON.stringify(incomingValue ?? null)) {
        merged[field] = incomingValue;
        changed = true;
      }
    }
    return changed ? merged : null;
  }

  // -- account switch / sign-out --------------------------------------------

  // Clears bookmarks, lists and every `cloud:`-namespaced meta key (token,
  // owner, cached user, sync state — for every server namespace, not just
  // the currently configured one) in this origin's NookDB, keeping every
  // other meta key (appearance preference, device id, the migration flag).
  // Used when switching cloud accounts or signing out of the web app, where
  // the local copy is only a cache of the account and must not bleed into
  // whatever gets bound/synced next.
  async function wipeLocalLibrary(): Promise<void> {
    const db = await open();
    const tx = db.transaction([STORE_BOOKMARKS, STORE_LISTS, STORE_META], "readwrite");
    const metaStore = tx.objectStore(STORE_META);
    const metaKeys = await promisifyRequest<IDBValidKey[]>(metaStore.getAllKeys());
    tx.objectStore(STORE_BOOKMARKS).clear();
    tx.objectStore(STORE_LISTS).clear();
    for (const key of metaKeys) {
      if (typeof key === "string" && key.startsWith("cloud:")) metaStore.delete(key);
    }
    await promisifyTransaction(tx);
    notifyChange([STORE_BOOKMARKS, STORE_LISTS], []);
  }

  // -- migration from chrome.storage.local -----------------------------------

  // One-time bulk import of the old { items: [...], lists: [...] } shape
  // into IndexedDB. Idempotent via the "migratedFromChromeStorage" meta
  // flag. We deliberately do NOT delete the old chrome.storage.local keys —
  // keep them around for one release as a backup in case the migration
  // needs to be re-run or inspected.
  // TODO(nook): once we're confident the IndexedDB migration has shipped
  // safely for a full release, remove the old "items"/"lists" keys from
  // chrome.storage.local (and this migration function).
  async function migrateFromChromeStorage(): Promise<{ migratedAt: string; itemCount: number; listCount: number } | null> {
    const already = await getMeta("migratedFromChromeStorage");
    if (already) return already;

    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) {
      return null;
    }

    const stored = await chrome.storage.local.get(["items", "lists"]);
    const items: Bookmark[] = Array.isArray(stored.items) ? stored.items : [];
    const lists: BookmarkList[] = Array.isArray(stored.lists) ? stored.lists : [];

    if (items.length > 0) {
      const db = await open();
      const tx = db.transaction(STORE_BOOKMARKS, "readwrite");
      const store = tx.objectStore(STORE_BOOKMARKS);
      for (const item of items) {
        if (!item || !item.id) continue;
        store.put(withUrlKey({
          ...item,
          updatedAt: item.savedAt || nowIso(),
          deletedAt: null
        }));
      }
      await promisifyTransaction(tx);
    }

    if (lists.length > 0) {
      const db = await open();
      const tx = db.transaction(STORE_LISTS, "readwrite");
      const store = tx.objectStore(STORE_LISTS);
      for (const list of lists) {
        if (!list || !list.id) continue;
        store.put({
          ...list,
          updatedAt: list.updatedAt || list.createdAt || nowIso(),
          deletedAt: null
        });
      }
      await promisifyTransaction(tx);
    }

    const result = {
      migratedAt: nowIso(),
      itemCount: items.length,
      listCount: lists.length
    };
    await setMeta("migratedFromChromeStorage", result);
    notifyChange([STORE_BOOKMARKS, STORE_LISTS], []);
    return result;
  }

  // Opens the DB and runs the (idempotent) migration, memoized so it only
  // does the work once per background/dashboard/popup context's lifetime.
  function ready(): Promise<unknown> {
    if (!_readyPromise) {
      _readyPromise = open().then(() => migrateFromChromeStorage());
    }
    return _readyPromise;
  }

  // Test-only: point at a fresh, uniquely-named DB and forget memoized
  // promises, so each test starts from a clean slate without leaking state
  // into the next one.
  function _resetForTests(dbName?: string): string {
    _dbName = dbName || `nook-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    _dbPromise = null;
    _readyPromise = null;
    return _dbName;
  }

export {
  open,
  ready,
  getAllBookmarks,
  getBookmark,
  findBookmarkByUrl,
  saveOrRestoreBookmark,
  putBookmark,
  putBookmarks,
  updateBookmark,
  softDeleteBookmark,
  softDeleteAllBookmarks,
  getAllLists,
  putList,
  softDeleteList,
  getChangesSince,
  getMeta,
  setMeta,
  applyRemoteRecords,
  wipeLocalLibrary,
  mergeBatch,
  mergeTweetContent,
  TWEET_CONTENT_FIELDS,
  migrateFromChromeStorage,
  _resetForTests
};
import type { Bookmark, BookmarkList, Media } from "./types";
import { normalizeUrlForDedupe } from "./url";
