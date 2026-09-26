import { expect, test } from "vitest";
import type { Bookmark, BookmarkList } from "../lib/types";
import {
  canonicalJson,
  mergeBookmarks,
  mergeLists,
  planUrlDuplicateMerge,
  sameRecord,
  sameRecordIgnoringTimestamps,
} from "../lib/cloud-merge";

// -- canonicalJson --------------------------------------------------------

test("canonicalJson sorts object keys recursively at every depth", () => {
  const a = { b: 1, a: { d: 2, c: 3 } };
  const b = { a: { c: 3, d: 2 }, b: 1 };
  expect(canonicalJson(a)).toBe(canonicalJson(b));
  expect(canonicalJson(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
});

test("canonicalJson sorts keys inside array items but keeps array order", () => {
  const value = [
    { y: 1, x: 2 },
    { b: 1, a: 2 },
  ];
  expect(canonicalJson(value)).toBe('[{"x":2,"y":1},{"a":2,"b":1}]');
  expect(canonicalJson([1, 2, 3])).not.toBe(canonicalJson([3, 2, 1]));
});

test("canonicalJson drops undefined object values and turns undefined array items into null", () => {
  expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  expect(canonicalJson([1, undefined, 3])).toBe("[1,null,3]");
});

test("canonicalJson: key order never affects equality", () => {
  const record1 = { id: "1", title: "Hi", tags: ["a", "b"], nested: { z: 1, a: 2 } };
  const record2 = { nested: { a: 2, z: 1 }, tags: ["a", "b"], title: "Hi", id: "1" };
  expect(canonicalJson(record1)).toBe(canonicalJson(record2));
});

// -- sameRecord / sameRecordIgnoringTimestamps -----------------------------

test("sameRecord is true for identical content in different key order", () => {
  expect(sameRecord({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  expect(sameRecord({ a: 1, b: 2 }, { b: 2, a: 3 })).toBe(false);
});

test("sameRecordIgnoringTimestamps ignores updatedAt and urlKey but nothing else", () => {
  const a = { id: "1", title: "Hi", updatedAt: "2024-01-01T00:00:00Z", urlKey: "k1" };
  const b = { id: "1", title: "Hi", updatedAt: "2024-06-01T00:00:00Z", urlKey: "k2" };
  expect(sameRecordIgnoringTimestamps(a, b)).toBe(true);
  expect(sameRecord(a, b)).toBe(false);

  const c = { id: "1", title: "Bye", updatedAt: "2024-01-01T00:00:00Z" };
  expect(sameRecordIgnoringTimestamps(a, c)).toBe(false);
});

// -- mergeBookmarks ---------------------------------------------------------

test("mergeBookmarks keeps the shared id", () => {
  const local: Bookmark = { id: "shared", source: "x", updatedAt: "2024-01-01T00:00:00Z" };
  const remote: Bookmark = { id: "shared", source: "x", updatedAt: "2024-01-02T00:00:00Z" };
  expect(mergeBookmarks(local, remote).id).toBe("shared");
});

test("mergeBookmarks: note is newer's when non-empty, else older's", () => {
  const local: Bookmark = { id: "1", source: "x", note: "local note", updatedAt: "2024-01-02T00:00:00Z" };
  const remote: Bookmark = { id: "1", source: "x", note: "remote note", updatedAt: "2024-01-01T00:00:00Z" };
  const merged = mergeBookmarks(local, remote);
  expect(merged.note).toBe("local note");
  expect(mergeBookmarks(remote, local)).toEqual(merged);

  const blankLocal: Bookmark = { id: "1", source: "x", note: "   ", updatedAt: "2024-01-02T00:00:00Z" };
  expect(mergeBookmarks(blankLocal, remote).note).toBe("remote note");
});

test("mergeBookmarks: tags union with newer's order first, omitted when neither side has tags", () => {
  const local: Bookmark = { id: "1", source: "x", tags: ["b", "a"], updatedAt: "2024-01-02T00:00:00Z" };
  const remote: Bookmark = { id: "1", source: "x", tags: ["a", "c"], updatedAt: "2024-01-01T00:00:00Z" };
  const merged = mergeBookmarks(local, remote);
  expect(merged.tags).toEqual(["b", "a", "c"]);
  expect(mergeBookmarks(remote, local).tags).toEqual(["b", "a", "c"]);

  const noTagsLocal: Bookmark = { id: "1", source: "x", updatedAt: "t1" };
  const noTagsRemote: Bookmark = { id: "1", source: "x", updatedAt: "t2" };
  expect(mergeBookmarks(noTagsLocal, noTagsRemote).tags).toBeUndefined();
});

test("mergeBookmarks: listId/listName travel together, falling back to older's pair when newer's listId is null", () => {
  const local: Bookmark = { id: "1", source: "x", listId: "L1", listName: "Reading", updatedAt: "2024-01-02T00:00:00Z" };
  const remote: Bookmark = { id: "1", source: "x", listId: "L2", listName: "Later", updatedAt: "2024-01-01T00:00:00Z" };
  expect(mergeBookmarks(local, remote)).toMatchObject({ listId: "L1", listName: "Reading" });

  const nullListLocal: Bookmark = { id: "1", source: "x", listId: null, listName: null, updatedAt: "2024-01-02T00:00:00Z" };
  expect(mergeBookmarks(nullListLocal, remote)).toMatchObject({ listId: "L2", listName: "Later" });
});

test("mergeBookmarks: savedAt/createdAt take the earliest value, updatedAt the max", () => {
  const local: Bookmark = {
    id: "1", source: "x",
    savedAt: "2024-01-05T00:00:00Z", createdAt: "2024-01-05T00:00:00Z", updatedAt: "2024-01-10T00:00:00Z",
  };
  const remote: Bookmark = {
    id: "1", source: "x",
    savedAt: "2024-01-01T00:00:00Z", createdAt: "2024-01-02T00:00:00Z", updatedAt: "2024-01-03T00:00:00Z",
  };
  const merged = mergeBookmarks(local, remote);
  expect(merged.savedAt).toBe("2024-01-01T00:00:00Z");
  expect(merged.createdAt).toBe("2024-01-02T00:00:00Z");
  expect(merged.updatedAt).toBe("2024-01-10T00:00:00Z");
  expect(mergeBookmarks(remote, local)).toEqual(merged);
});

test("mergeBookmarks: deletedAt always follows the newer side, null included (deletion decided by recency)", () => {
  const deletedLocal: Bookmark = { id: "1", source: "x", deletedAt: "2024-01-05T00:00:00Z", updatedAt: "2024-01-05T00:00:00Z" };
  const liveRemote: Bookmark = { id: "1", source: "x", deletedAt: null, updatedAt: "2024-01-01T00:00:00Z" };
  expect(mergeBookmarks(deletedLocal, liveRemote).deletedAt).toBe("2024-01-05T00:00:00Z");
  expect(mergeBookmarks(liveRemote, deletedLocal).deletedAt).toBe("2024-01-05T00:00:00Z");

  // A newer restore (deletedAt: null) wins over an older deletion.
  const restoredLocal: Bookmark = { id: "1", source: "x", deletedAt: null, updatedAt: "2024-01-10T00:00:00Z" };
  const deletedRemote: Bookmark = { id: "1", source: "x", deletedAt: "2024-01-05T00:00:00Z", updatedAt: "2024-01-05T00:00:00Z" };
  expect(mergeBookmarks(restoredLocal, deletedRemote).deletedAt).toBeNull();
  expect(mergeBookmarks(deletedRemote, restoredLocal).deletedAt).toBeNull();
});

test("mergeBookmarks: equal updatedAt ties break on canonicalJson and stay commutative", () => {
  const a: Bookmark = { id: "1", source: "x", title: "Zeta", updatedAt: "2024-01-01T00:00:00Z" };
  const b: Bookmark = { id: "1", source: "x", title: "Alpha", updatedAt: "2024-01-01T00:00:00Z" };
  const ab = mergeBookmarks(a, b);
  const ba = mergeBookmarks(b, a);
  expect(ab).toEqual(ba);
  // canonicalJson({...title:"Zeta"}) > canonicalJson({...title:"Alpha"}) lexically, so `a` is "newer" on the tie.
  expect(ab.title).toBe("Zeta");
});

test("mergeBookmarks: media/attachments pick the newer non-empty array, else the older's", () => {
  const older: Bookmark = {
    id: "1", source: "x", updatedAt: "2024-01-01T00:00:00Z",
    attachments: [{ type: "image", url: "a.jpg" }],
  };
  const newerEmpty: Bookmark = { id: "1", source: "x", updatedAt: "2024-01-02T00:00:00Z", attachments: [] };
  expect(mergeBookmarks(newerEmpty, older).attachments).toEqual([{ type: "image", url: "a.jpg" }]);
});

test("mergeBookmarks: media backfills videoUrl from the other side's matching item (DOM re-save must not wipe it)", () => {
  const withVideo: Bookmark = {
    id: "1", source: "x", updatedAt: "2024-01-01T00:00:00Z",
    media: [{ type: "video", url: "poster.jpg", videoUrl: "video.mp4" }],
  };
  const domResave: Bookmark = {
    id: "1", source: "x", updatedAt: "2024-01-02T00:00:00Z",
    media: [{ type: "video", url: "poster.jpg" }],
  };
  const merged = mergeBookmarks(domResave, withVideo);
  expect(merged.media).toEqual([{ type: "video", url: "poster.jpg", videoUrl: "video.mp4" }]);
  expect(mergeBookmarks(withVideo, domResave)).toEqual(merged);
});

test("mergeBookmarks: quote.media also backfills videoUrl", () => {
  const withVideo: Bookmark = {
    id: "1", source: "x", updatedAt: "2024-01-01T00:00:00Z",
    quote: { id: "q1", media: [{ type: "video", url: "qposter.jpg", videoUrl: "qvideo.mp4" }] },
  };
  const domResave: Bookmark = {
    id: "1", source: "x", updatedAt: "2024-01-02T00:00:00Z",
    quote: { id: "q1", media: [{ type: "video", url: "qposter.jpg" }] },
  };
  const merged = mergeBookmarks(domResave, withVideo);
  expect(merged.quote).toEqual({ id: "q1", media: [{ type: "video", url: "qposter.jpg", videoUrl: "qvideo.mp4" }] });
});

test("mergeBookmarks: every other field falls back to older's when newer's is empty", () => {
  const local: Bookmark = { id: "1", source: "x", title: "", updatedAt: "2024-01-02T00:00:00Z" };
  const remote: Bookmark = { id: "1", source: "x", title: "Remote title", shortDescription: "desc", updatedAt: "2024-01-01T00:00:00Z" };
  const merged = mergeBookmarks(local, remote);
  expect(merged.title).toBe("Remote title");
  expect(merged.shortDescription).toBe("desc");
});

test("mergeBookmarks: ai attribution is taken from the side that supplied the listId", () => {
  const filedByAi: Bookmark = {
    id: "1", source: "x", updatedAt: "2024-01-01T00:00:00Z",
    listId: "L1", listName: "Reading",
    ai: { model: "jev-1.13.0", at: "2024-01-01T00:00:00Z", collectionConfidence: 0.91 },
  };
  // Newer side filed it by hand: the assignment is the newer side's, so the
  // model's attribution must not survive to badge a manual filing as its work.
  const filedByHand: Bookmark = { id: "1", source: "x", listId: "L2", listName: "Later", updatedAt: "2024-01-02T00:00:00Z" };
  const merged = mergeBookmarks(filedByAi, filedByHand);
  expect(merged).toMatchObject({ listId: "L2", listName: "Later" });
  expect(merged.ai).toBeUndefined();
  expect(mergeBookmarks(filedByHand, filedByAi)).toEqual(merged);

  // Both sides filed with the model, different collections: attribution follows
  // the assignment rather than winning on its own recency.
  const otherAi: Bookmark = {
    id: "1", source: "x", listId: "L2", listName: "Later", updatedAt: "2024-01-02T00:00:00Z",
    ai: { model: "jev-1.13.1", at: "2024-01-02T00:00:00Z", collectionConfidence: 0.77 },
  };
  expect(mergeBookmarks(filedByAi, otherAi).ai).toEqual(otherAi.ai);
  expect(mergeBookmarks(otherAi, filedByAi).ai).toEqual(otherAi.ai);

  // The older side's assignment wins when only it has one, and its attribution
  // comes along: a confidence whose assignment was just resurrected is not stale.
  const unfiled: Bookmark = { id: "1", source: "x", updatedAt: "2024-01-05T00:00:00Z", listId: null, listName: null };
  const resurrected = mergeBookmarks(filedByAi, unfiled);
  expect(resurrected).toMatchObject({ listId: "L1", listName: "Reading" });
  expect(resurrected.ai).toEqual(filedByAi.ai);
  expect(mergeBookmarks(unfiled, filedByAi)).toEqual(resurrected);
});

test("mergeBookmarks: a tags-only attribution survives even when no side has a collection", () => {
  // applyClassification writes an attribution with no listId whenever the model
  // tagged a bookmark but filed nothing, so "no collection" must never mean
  // "drop the attribution": that would turn an already-classified record back
  // into a candidate and re-bill it on every single run.
  const taggedOnly: Bookmark = {
    id: "1", source: "x", tags: ["rust"], updatedAt: "2024-01-01T00:00:00Z",
    ai: { model: "jev-1.13.0", at: "2024-01-01T00:00:00Z", tagConfidence: { rust: 0.9 } },
  };
  const unfiled: Bookmark = { id: "1", source: "x", updatedAt: "2024-01-05T00:00:00Z" };

  const forward = mergeBookmarks(taggedOnly, unfiled);
  expect(forward.listId).toBeUndefined();
  expect(forward.ai).toEqual(taggedOnly.ai);
  expect(mergeBookmarks(unfiled, taggedOnly)).toEqual(forward);
  expect(forward.ai!.collectionConfidence).toBeUndefined();
});

test("mergeBookmarks: ai never survives as a generic newer-wins field", () => {
  // A plain field would take the newer side's value and fall back to the older
  // one's; `ai` is excluded from that loop and re-derived from listSource, so a
  // manual filing on the newer side can't inherit the older side's model
  // attribution. The key is always present (so a stale value is overwritten
  // rather than left in place), never the other side's.
  const older: Bookmark = {
    id: "1", source: "x", updatedAt: "2024-01-01T00:00:00Z",
    listId: "L1", listName: "Reading",
    ai: { model: "jev-1.13.0", at: "2024-01-01T00:00:00Z", collectionConfidence: 0.91 },
  };
  const newer: Bookmark = { id: "1", source: "x", listId: "L9", listName: "Kept", updatedAt: "2024-01-09T00:00:00Z" };
  const merged = mergeBookmarks(older, newer);
  expect(merged).toMatchObject({ listId: "L9", listName: "Kept" });
  expect(merged.ai).toBeUndefined();
  expect(Object.keys(merged)).toContain("ai");
});

test("mergeBookmarks is commutative across a variety of record pairs", () => {
  const pairs: Array<[Bookmark, Bookmark]> = [
    [
      { id: "1", source: "x", note: "n1", tags: ["a"], updatedAt: "2024-01-01T00:00:00Z" },
      { id: "1", source: "x", note: "n2", tags: ["b"], updatedAt: "2024-01-02T00:00:00Z" },
    ],
    [
      { id: "2", source: "x", deletedAt: "2024-02-01T00:00:00Z", updatedAt: "2024-02-01T00:00:00Z" },
      { id: "2", source: "x", deletedAt: null, updatedAt: "2024-02-01T00:00:00Z" },
    ],
    [
      { id: "3", source: "web", listId: "L1", listName: "A", updatedAt: "2024-03-01T00:00:00Z" },
      { id: "3", source: "web", listId: null, listName: null, updatedAt: "2024-03-05T00:00:00Z" },
    ],
    [
      { id: "4", source: "x", media: [{ type: "video", url: "p.jpg", videoUrl: "v.mp4" }], updatedAt: "2024-04-01T00:00:00Z" },
      { id: "4", source: "x", media: [{ type: "video", url: "p.jpg" }], updatedAt: "2024-04-02T00:00:00Z" },
    ],
  ];
  for (const [a, b] of pairs) {
    expect(mergeBookmarks(a, b)).toEqual(mergeBookmarks(b, a));
  }
});

// -- mergeLists ---------------------------------------------------------

test("mergeLists: fills empty fields of the newer side from the older, earliest createdAt, max updatedAt", () => {
  const local: BookmarkList = { id: "L1", name: "", icon: "book", createdAt: "2024-01-05T00:00:00Z", updatedAt: "2024-01-10T00:00:00Z", deletedAt: null };
  const remote: BookmarkList = { id: "L1", name: "Reading", icon: "star", createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-01-02T00:00:00Z", deletedAt: null };
  const merged = mergeLists(local, remote);
  expect(merged.name).toBe("Reading");
  expect(merged.icon).toBe("book");
  expect(merged.createdAt).toBe("2024-01-01T00:00:00Z");
  expect(merged.updatedAt).toBe("2024-01-10T00:00:00Z");
  expect(mergeLists(remote, local)).toEqual(merged);
});

test("mergeLists: deletedAt follows the newer side", () => {
  const local: BookmarkList = { id: "L1", name: "A", deletedAt: "2024-01-05T00:00:00Z", updatedAt: "2024-01-05T00:00:00Z" };
  const remote: BookmarkList = { id: "L1", name: "A", deletedAt: null, updatedAt: "2024-01-01T00:00:00Z" };
  expect(mergeLists(local, remote).deletedAt).toBe("2024-01-05T00:00:00Z");
  expect(mergeLists(remote, local).deletedAt).toBe("2024-01-05T00:00:00Z");
});

// -- planUrlDuplicateMerge --------------------------------------------------

test("planUrlDuplicateMerge: fewer than 2 records returns the single item unchanged", () => {
  const only: Bookmark = { id: "1", source: "x" };
  expect(planUrlDuplicateMerge([only])).toEqual({ survivor: only, changed: false, duplicateIds: [] });
});

test("planUrlDuplicateMerge: survivor is earliest savedAt, ties break on id, and it's order independent", () => {
  const a: Bookmark = { id: "b", source: "x", savedAt: "2024-01-01T00:00:00Z" };
  const b: Bookmark = { id: "a", source: "x", savedAt: "2024-01-01T00:00:00Z" };
  const c: Bookmark = { id: "c", source: "x", savedAt: "2024-01-05T00:00:00Z" };
  const forward = planUrlDuplicateMerge([a, b, c]);
  const backward = planUrlDuplicateMerge([c, b, a]);
  expect(forward.survivor.id).toBe("a");
  expect(forward).toEqual(backward);
  expect(forward.duplicateIds).toEqual(["b", "c"]);
});

test("planUrlDuplicateMerge: falls back to createdAt then updatedAt; missing timestamps sort last", () => {
  const noTimestamps: Bookmark = { id: "z", source: "x" };
  const withCreated: Bookmark = { id: "y", source: "x", createdAt: "2024-01-01T00:00:00Z" };
  expect(planUrlDuplicateMerge([noTimestamps, withCreated]).survivor.id).toBe("y");
  expect(planUrlDuplicateMerge([withCreated, noTimestamps]).survivor.id).toBe("y");
});

test("planUrlDuplicateMerge: absorbs note/tags/list from the others, order independent", () => {
  const survivorSeed: Bookmark = { id: "a", source: "x", savedAt: "2024-01-01T00:00:00Z", title: "Kept title" };
  const dup1: Bookmark = { id: "b", source: "x", savedAt: "2024-01-02T00:00:00Z", note: "from dup1", tags: ["x", "y"] };
  const dup2: Bookmark = { id: "c", source: "x", savedAt: "2024-01-03T00:00:00Z", tags: ["y", "z"], listId: "L1", listName: "Later" };

  const result = planUrlDuplicateMerge([survivorSeed, dup1, dup2]);
  expect(result.survivor.id).toBe("a");
  expect(result.survivor.title).toBe("Kept title");
  expect(result.survivor.note).toBe("from dup1");
  expect(result.survivor.tags).toEqual(["x", "y", "z"]);
  expect(result.survivor.listId).toBe("L1");
  expect(result.survivor.listName).toBe("Later");
  expect(result.changed).toBe(true);
  expect(result.duplicateIds).toEqual(["b", "c"]);

  const shuffled = planUrlDuplicateMerge([dup2, survivorSeed, dup1]);
  expect(shuffled).toEqual(result);
});

test("planUrlDuplicateMerge: changed is false when the survivor already has everything the others offer", () => {
  const survivorSeed: Bookmark = { id: "a", source: "x", savedAt: "2024-01-01T00:00:00Z", note: "own note", tags: ["x"], listId: "L1", listName: "Later" };
  const dup: Bookmark = { id: "b", source: "x", savedAt: "2024-01-02T00:00:00Z", note: "dup note", tags: ["x"], listId: "L2", listName: "Other" };
  const result = planUrlDuplicateMerge([survivorSeed, dup]);
  expect(result.survivor.note).toBe("own note");
  expect(result.survivor.tags).toEqual(["x"]);
  expect(result.survivor.listId).toBe("L1");
  expect(result.changed).toBe(false);
  expect(result.duplicateIds).toEqual(["b"]);
});
