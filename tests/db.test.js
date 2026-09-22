// Uses fake-indexeddb to exercise db.js's IndexedDB wrapper in Node, the
// same way it runs inside a chrome-extension page. Each test resets to a
// fresh, uniquely-named database via NookDB._resetForTests() so no state
// leaks between tests.
require("fake-indexeddb/auto");

const test = require("node:test");
const assert = require("node:assert/strict");

const NookDB = require("../apps/extension/db.js");

function freshDb() {
  NookDB._resetForTests();
}

test("putBookmark / getBookmark round-trip and sets updatedAt", async () => {
  freshDb();
  const before = Date.now();
  const saved = await NookDB.putBookmark({ id: "x:1", source: "x", title: "Hello" });

  assert.equal(saved.id, "x:1");
  assert.equal(saved.deletedAt, null);
  assert.ok(saved.updatedAt);
  assert.ok(new Date(saved.updatedAt).getTime() >= before);

  const fetched = await NookDB.getBookmark("x:1");
  assert.equal(fetched.title, "Hello");
  assert.equal(fetched.deletedAt, null);
});

test("updateBookmark refreshes updatedAt on every write", async () => {
  freshDb();
  const first = await NookDB.putBookmark({ id: "x:1", source: "x", title: "A" });
  await new Promise((r) => setTimeout(r, 5));
  const second = await NookDB.updateBookmark("x:1", { title: "B" });

  assert.equal(second.title, "B");
  assert.notEqual(second.updatedAt, first.updatedAt);
});

test("soft delete hides a bookmark from getAllBookmarks but keeps it in getChangesSince", async () => {
  freshDb();
  await NookDB.putBookmark({ id: "x:1", source: "x", title: "A" });
  await NookDB.putBookmark({ id: "x:2", source: "x", title: "B" });

  await NookDB.softDeleteBookmark("x:1");

  const visible = await NookDB.getAllBookmarks();
  assert.deepEqual(visible.map((i) => i.id).sort(), ["x:2"]);

  const withDeleted = await NookDB.getAllBookmarks({ includeDeleted: true });
  assert.equal(withDeleted.length, 2);

  const changes = await NookDB.getChangesSince(null);
  const tombstone = changes.bookmarks.find((i) => i.id === "x:1");
  assert.ok(tombstone);
  assert.ok(tombstone.deletedAt);
});

test("softDeleteAllBookmarks tombstones every non-deleted bookmark", async () => {
  freshDb();
  await NookDB.putBookmark({ id: "x:1", source: "x" });
  await NookDB.putBookmark({ id: "x:2", source: "x" });

  await NookDB.softDeleteAllBookmarks();

  const visible = await NookDB.getAllBookmarks();
  assert.equal(visible.length, 0);

  const all = await NookDB.getAllBookmarks({ includeDeleted: true });
  assert.ok(all.every((i) => i.deletedAt));
});

test("softDeleteList clears listId/listName on its bookmarks in the same transaction", async () => {
  freshDb();
  await NookDB.putList({ id: "l1", name: "Reading", icon: "📚" });
  await NookDB.putBookmark({ id: "x:1", source: "x", listId: "l1", listName: "Reading" });
  await NookDB.putBookmark({ id: "x:2", source: "x", listId: "l2", listName: "Other" });

  const result = await NookDB.softDeleteList("l1");
  assert.deepEqual(result.clearedBookmarkIds, ["x:1"]);

  const lists = await NookDB.getAllLists();
  assert.equal(lists.length, 0);

  const item1 = await NookDB.getBookmark("x:1");
  assert.equal(item1.listId, null);
  assert.equal(item1.listName, null);

  const item2 = await NookDB.getBookmark("x:2");
  assert.equal(item2.listId, "l2");
});

test("mergeBatch adds new items, updates changed content, ignores unchanged, and never resurrects a soft-deleted item", async () => {
  freshDb();
  await NookDB.putBookmark({
    id: "x:1",
    source: "x",
    title: "old title",
    quote: null
  });
  await NookDB.putBookmark({ id: "x:2", source: "x", title: "unchanged" });
  await NookDB.putBookmark({ id: "x:3", source: "x", title: "deleted one" });
  await NookDB.softDeleteBookmark("x:3");

  const incoming = [
    { id: "x:1", source: "x", title: "old title", quote: { text: "a quote now" } },
    { id: "x:2", source: "x", title: "unchanged" },
    { id: "x:3", source: "x", title: "deleted one - should not resurrect" },
    { id: "x:4", source: "x", title: "brand new" }
  ];

  const { added, updated } = await NookDB.mergeBatch(incoming, NookDB.mergeTweetContent);

  assert.deepEqual(added.map((i) => i.id), ["x:4"]);
  assert.deepEqual(updated.map((i) => i.id), ["x:1"]);

  const item1 = await NookDB.getBookmark("x:1");
  assert.equal(item1.quote.text, "a quote now");

  const item3 = await NookDB.getBookmark("x:3");
  assert.ok(item3.deletedAt, "soft-deleted item must stay deleted, not be resurrected");

  const visible = await NookDB.getAllBookmarks();
  assert.deepEqual(visible.map((i) => i.id).sort(), ["x:1", "x:2", "x:4"]);
});

test("getChangesSince filters by timestamp", async () => {
  freshDb();
  await NookDB.putBookmark({ id: "x:1", source: "x" });
  const cutoff = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  await NookDB.putBookmark({ id: "x:2", source: "x" });

  const changes = await NookDB.getChangesSince(cutoff);
  assert.deepEqual(changes.bookmarks.map((i) => i.id), ["x:2"]);
});

test("findBookmarkByUrl ignores deleted bookmarks", async () => {
  freshDb();
  await NookDB.putBookmark({ id: "chrome:1", source: "chrome", url: "https://example.com" });
  assert.ok(await NookDB.findBookmarkByUrl("https://example.com"));

  await NookDB.softDeleteBookmark("chrome:1");
  assert.equal(await NookDB.findBookmarkByUrl("https://example.com"), null);
});

test("migrateFromChromeStorage imports legacy items/lists and is idempotent", async () => {
  freshDb();

  const legacyItems = [
    { id: "x:1", source: "x", title: "Legacy tweet", savedAt: "2024-01-01T00:00:00.000Z" },
    { id: "chrome:1", source: "chrome", title: "Legacy page", url: "https://example.com" }
  ];
  const legacyLists = [{ id: "l1", name: "Reading", icon: "📚" }];

  global.chrome = {
    storage: {
      local: {
        get: async (keys) => {
          const result = {};
          const wanted = Array.isArray(keys) ? keys : [keys];
          if (wanted.includes("items")) result.items = legacyItems;
          if (wanted.includes("lists")) result.lists = legacyLists;
          return result;
        }
      }
    }
  };

  try {
    const result = await NookDB.migrateFromChromeStorage();
    assert.equal(result.itemCount, 2);
    assert.equal(result.listCount, 1);

    const bookmarks = await NookDB.getAllBookmarks();
    assert.equal(bookmarks.length, 2);
    const legacyTweet = bookmarks.find((i) => i.id === "x:1");
    assert.equal(legacyTweet.updatedAt, "2024-01-01T00:00:00.000Z");

    const lists = await NookDB.getAllLists();
    assert.equal(lists.length, 1);

    // Second run should be a no-op (idempotent via the meta flag) — add an
    // extra legacy item to chrome.storage.local and confirm it's ignored.
    legacyItems.push({ id: "x:2", source: "x", title: "Should not be imported" });
    const secondResult = await NookDB.migrateFromChromeStorage();
    assert.equal(secondResult.itemCount, 2); // returns the original stored result
    const bookmarksAfter = await NookDB.getAllBookmarks();
    assert.equal(bookmarksAfter.length, 2);
    assert.ok(!bookmarksAfter.some((i) => i.id === "x:2"));
  } finally {
    delete global.chrome;
  }
});
