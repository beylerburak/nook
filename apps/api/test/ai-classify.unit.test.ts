// Pure module, pure tests: no database, no network, no harness. Everything here
// is what a `nook_records` row can be and what a decision can turn it into, so
// the suite doubles as the argument that classification needs nothing the browser
// had (docs/ai-cloud-contract.md, "Why nothing browser-only is needed").
import { describe, expect, it } from "vitest";
import {
  MAX_NOTE_CHARS,
  MAX_SUMMARY_CHARS,
  applyClassification,
  attribution,
  bookmarkNeedsClassification,
  foldCase,
  normalizeTagName,
  patchChangesSomething,
  selectCandidates,
  toClassifiable,
  toClassifyRequest,
  withTaxonomyAt,
  type AiTaxonomyOption,
  type ClassifiableBookmark,
  type ClassifyResponse,
} from "../src/ai-classify.js";

/** The measured defaults (docs/ai-calibration.md): 0.75 files 22 of 57 against
 *  0.85's 15, for the same count of 2 wrong assignments. */
const SETTINGS = { collectionMinConfidence: 0.75, tagMinNoul: 0.8, maxTags: 3 };

const COLLECTIONS: AiTaxonomyOption[] = [{ id: "L1", name: "Reading", samples: ["a", "b"] }];
const TAGS: AiTaxonomyOption[] = [{ id: "typescript", name: "typescript", samples: ["c"] }];

const NO_ASSIGNMENT: ClassifyResponse = {
  model: "jev-1.13.0",
  collection: { assign: false, id: null, name: null, confidence: 0.2, probabilities: {} },
  tags: [],
};

const AT = "2026-09-28T09:00:00.000Z";

function response(overrides: Partial<ClassifyResponse> = {}): ClassifyResponse {
  return { ...NO_ASSIGNMENT, ...overrides };
}

function assigned(id: string, name: string, confidence = 0.93): ClassifyResponse {
  return response({
    collection: { assign: true, id, name, confidence, probabilities: { [id]: confidence, __none__: 0.04 } },
  });
}

describe("toClassifiable", () => {
  it("reads a record as the decision logic needs it", () => {
    const bookmark = toClassifiable({
      id: "web:1",
      title: "A page",
      shortDescription: "Short.",
      note: "My note",
      url: "https://news.example.com/story",
      tags: ["typescript"],
      listId: "L1",
      listName: "Reading",
      creator: { handle: "@someone", name: "Real Name" },
      savedAt: "2026-03-01T00:00:00Z",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-02T00:00:00Z",
    });
    expect(bookmark).toEqual({
      id: "web:1",
      title: "A page",
      shortDescription: "Short.",
      note: "My note",
      url: "https://news.example.com/story",
      tags: ["typescript"],
      listId: "L1",
      listName: "Reading",
      creator: { handle: "@someone", name: "Real Name" },
      savedAt: "2026-03-01T00:00:00Z",
      createdAt: "2026-02-01T00:00:00Z",
      updatedAt: "2026-02-02T00:00:00Z",
    });
  });

  // A record's `data` is whatever a client last sent, and no client has ever
  // been on the hook for keeping it well-typed. Coercing a wrong-typed field
  // into a plausible value is the dangerous direction: a `tags` string would
  // become a tag called "a,b,c" and a creator that arrived as a string would
  // become an author with that name.
  it("drops a wrong-typed field rather than coercing it", () => {
    const bookmark = toClassifiable({
      id: "x:1",
      title: 42,
      tags: "typescript,rust",
      listId: 7,
      creator: "nobody",
      note: { text: "not a note" },
    });
    expect(bookmark).toEqual({ id: "x:1" });
    expect(bookmark.tags).toBeUndefined();
    expect(bookmark.creator).toBeUndefined();
  });

  it("keeps the nulls that are real answers", () => {
    // `listId: null` is a cleared assignment and `deletedAt: null` is what a live
    // row carries; both mean something a missing field does not.
    const cleared = toClassifiable({ id: "1", listId: null, listName: null });
    expect(cleared.listId).toBeNull();
    expect("listName" in cleared).toBe(true);
    expect(toClassifiable({ id: "1", deletedAt: null }).deletedAt).toBeNull();
    // A creator that is an object but carries nothing usable still comes back as
    // an object, so `creator?.handle` stays a read rather than a guess.
    expect(toClassifiable({ id: "1", creator: {} }).creator).toEqual({});
  });

  it("passes the attribution through untouched, because only its absence is read", () => {
    const decided = toClassifiable({ id: "1", ai: { model: "jev-1.13.0", at: AT } });
    expect(decided.ai).toEqual({ model: "jev-1.13.0", at: AT });
    // Present-but-null is how most of the library arrives, and it must read as
    // "never classified".
    expect(toClassifiable({ id: "1", ai: null }).ai).toBeNull();
    expect("ai" in toClassifiable({ id: "1" })).toBe(false);
  });

  it("reads a record with nothing but an id, which is a record a client can send", () => {
    expect(toClassifiable({})).toEqual({ id: "" });
  });
});

describe("bookmarkNeedsClassification", () => {
  it("never offers a bookmark a human put in a collection, however it got there", () => {
    expect(bookmarkNeedsClassification({ id: "1" })).toBe(true);
    expect(bookmarkNeedsClassification({ id: "1", listId: "L1", listName: "Reading" })).toBe(false);
    // A cleared assignment (deleted collection, "Remove from collection") is a
    // candidate again; only a live listId protects a bookmark.
    expect(bookmarkNeedsClassification({ id: "1", listId: null, listName: null })).toBe(true);
  });

  it("never offers an already-classified bookmark again", () => {
    const classified: ClassifiableBookmark = { id: "1", ai: { model: "jev-1.13.0", at: AT } };
    expect(bookmarkNeedsClassification(classified)).toBe(false);
    // Even after the user removed the collection: re-filing it would be a second
    // charge for a decision that was already made and already overruled.
    expect(bookmarkNeedsClassification({ ...classified, listId: null, listName: null })).toBe(false);
  });

  it("treats a present-but-null ai as never classified, which is how jsonb arrives", () => {
    // `ai: null` is the shape every record in the library that the model has not
    // ruled on carries. Reading that as "already classified" would classify
    // nothing at all.
    expect(bookmarkNeedsClassification(toClassifiable({ id: "1", ai: null }))).toBe(true);
  });
});

describe("selectCandidates", () => {
  it("skips manually filed, already-decided and soft-deleted bookmarks", () => {
    const bookmarks: ClassifiableBookmark[] = [
      { id: "plain", savedAt: "2026-03-01T00:00:00Z" },
      { id: "manual", savedAt: "2026-03-02T00:00:00Z", listId: "L1", listName: "Reading" },
      { id: "done", savedAt: "2026-03-03T00:00:00Z", ai: { model: "jev-1.13.0", at: AT } },
      { id: "gone", savedAt: "2026-03-04T00:00:00Z", deletedAt: "2026-03-05T00:00:00Z" },
    ];
    expect(selectCandidates(bookmarks, 10).map((b) => b.id)).toEqual(["plain"]);
  });

  it("is newest first, respects limit, and tolerates missing timestamps", () => {
    const bookmarks: ClassifiableBookmark[] = [
      { id: "old", savedAt: "2026-01-01T00:00:00Z" },
      { id: "newest", savedAt: "2026-03-01T00:00:00Z" },
      { id: "middle", savedAt: "2026-02-01T00:00:00Z" },
      { id: "no-timestamps" },
      { id: "created-only", createdAt: "2026-02-15T00:00:00Z" },
      { id: "updated-only", updatedAt: "2026-02-20T00:00:00Z" },
    ];
    expect(selectCandidates(bookmarks, 10).map((b) => b.id)).toEqual([
      "newest",
      "updated-only",
      "created-only",
      "middle",
      "old",
      "no-timestamps",
    ]);
    expect(selectCandidates(bookmarks, 2).map((b) => b.id)).toEqual(["newest", "updated-only"]);
    expect(selectCandidates(bookmarks, 0)).toEqual([]);
    expect(selectCandidates(bookmarks, -5)).toEqual([]);
    expect(selectCandidates(bookmarks, Number.NaN)).toEqual([]);
    expect(selectCandidates(bookmarks, 2.7).map((b) => b.id)).toEqual(["newest", "updated-only"]);
    // Same library in, same batch out: a re-run can't re-order the queue.
    expect(selectCandidates([...bookmarks].reverse(), 3)).toEqual(selectCandidates(bookmarks, 3));
  });

  it("breaks a recency tie on the id, so equal timestamps are still deterministic", () => {
    const same = "2026-03-01T00:00:00Z";
    const bookmarks: ClassifiableBookmark[] = [
      { id: "b", savedAt: same },
      { id: "a", savedAt: same },
      { id: "c", savedAt: same },
    ];
    expect(selectCandidates(bookmarks, 10).map((b) => b.id)).toEqual(["a", "b", "c"]);
  });
});

describe("toClassifyRequest", () => {
  it("sends the host, never the URL with its path or query", () => {
    const bookmark = toClassifiable({
      id: "web:1",
      title: "  A page  ",
      shortDescription: "Short.",
      note: "My note",
      url: "https://news.example.com/2026/03/story?utm_source=newsletter&token=SECRET",
      creator: { name: "Real Name", handle: "@someone" },
    });
    const request = toClassifyRequest(bookmark, COLLECTIONS, TAGS, SETTINGS);
    expect(request.bookmark.site).toBe("news.example.com");
    const serialized = JSON.stringify(request);
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("/2026/03/story");
    expect(request.bookmark.title).toBe("A page");
    expect(request.bookmark.note).toBe("My note");
    // The handle is the account, the name is the display name, and the account is
    // the more stable of the two.
    expect(request.bookmark.author).toBe("@someone");
  });

  it("builds the same request from a raw jsonb row, which is the whole migration", () => {
    // The contract table: title, shortDescription, note, url -> hostname and the
    // creator are the only fields classification needs, and every one of them is
    // something POST /api/sync has always carried. So a row is enough.
    const row = {
      id: "web:9",
      title: "A page about containers",
      shortDescription: "A long enough description to be worth classifying.",
      note: "read twice",
      url: "https://blog.example.com/2026/03/post?token=SECRET",
      creator: { handle: "@someone" },
      // None of the following may reach the model.
      description: "FULL-DESCRIPTION-MARKER",
      tags: ["secret-topic"],
      ai: { model: "jev-1.13.0", at: AT },
      listName: "Reading",
      listId: "L1",
    };
    const request = toClassifyRequest(toClassifiable(row), [], [], SETTINGS);
    expect(request.bookmark).toEqual({
      id: "web:9",
      title: "A page about containers",
      summary: "A long enough description to be worth classifying.",
      note: "read twice",
      site: "blog.example.com",
      author: "@someone",
    });
    const serialized = JSON.stringify(request);
    for (const forbidden of ["SECRET", "FULL-DESCRIPTION-MARKER", "secret-topic", "jev", "Reading", "L1"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("omits an empty field rather than sending it as undefined", () => {
    // A field with nothing in it must be absent from the serialized body, not
    // present-and-empty: the server's state filter would otherwise have to
    // decide what a blank title means.
    const empty = toClassifyRequest(toClassifiable({ id: "web:3", title: "   ", note: "" }), [], [], SETTINGS);
    expect(empty.bookmark).toEqual({ id: "web:3" });
    expect(JSON.stringify(empty.bookmark)).not.toContain("undefined");

    // A url it cannot parse contributes nothing rather than a guess, and the
    // creator's display name is the fallback when there is no handle.
    const bare = toClassifyRequest(
      toClassifiable({ id: "x:1", url: "not a url", creator: { name: "Real Name" } }),
      [],
      [],
      SETTINGS,
    );
    expect("site" in bare.bookmark).toBe(false);
    expect(bare.bookmark.author).toBe("Real Name");
  });

  it("never sends the full description and truncates a long summary", () => {
    const bookmark = toClassifiable({
      id: "web:2",
      title: "T",
      shortDescription: "s".repeat(400),
      description: "FULL-DESCRIPTION-MARKER",
    });
    const request = toClassifyRequest(bookmark, COLLECTIONS, TAGS, SETTINGS);
    expect(JSON.stringify(request)).not.toContain("FULL-DESCRIPTION-MARKER");
    // 300 characters plus the ellipsis that says the text was cut. The state
    // budget is shared by every question in the call, and the tail of a wall of
    // pasted text is worth exactly as much as the collection question it would
    // crowd out.
    expect(request.bookmark.summary).toHaveLength(MAX_SUMMARY_CHARS + 1);
    expect(request.bookmark.summary?.startsWith("sss")).toBe(true);
    expect(request.bookmark.summary?.endsWith("…")).toBe(true);
    // summary comes from shortDescription, never from description.
    expect(request.bookmark.summary).not.toBe(bookmark.shortDescription);
  });

  it("truncates a pasted note at its own, larger, limit", () => {
    const request = toClassifyRequest(
      toClassifiable({ id: "web:4", note: "n".repeat(600) }),
      [],
      [],
      SETTINGS,
    );
    expect(request.bookmark.note).toHaveLength(MAX_NOTE_CHARS + 1);
    expect(request.bookmark.note?.endsWith("…")).toBe(true);
  });

  it("passes the three thresholds and the options it was handed", () => {
    const request = toClassifyRequest(
      { id: "1" },
      COLLECTIONS,
      TAGS,
      { collectionMinConfidence: 0.9, tagMinNoul: 0.7, maxTags: 5 },
    );
    expect(request.settings).toEqual({ collectionMinConfidence: 0.9, tagMinNoul: 0.7, maxTags: 5 });
    expect(request.collections).toEqual(COLLECTIONS);
    // A tag's member-title digest is deliberately not sent: it cost 58% of the
    // request's tokens and halved tag recall (81.7% -> 47.9%) when it was there
    // (docs/ai-calibration.md). What does go out is a definition.
    expect(request.tags).toEqual([{ name: "typescript", samples: [] }]);
  });

  it("forwards a tag's definition, and omits the key when there is none", () => {
    const withDefinition = toClassifyRequest(
      { id: "b1" },
      [],
      [{ id: "tag:web", name: "web", samples: [], definition: "Ön yüz işleri." }],
      SETTINGS,
    );
    expect(withDefinition.tags).toEqual([{ name: "web", samples: [], definition: "Ön yüz işleri." }]);

    // Omitted rather than sent as undefined, so the server cannot mistake an
    // absent definition for a reason to build a digest.
    const without = toClassifyRequest({ id: "b1" }, [], [{ id: "tag:web", name: "web", samples: [] }], SETTINGS);
    expect("definition" in without.tags[0]).toBe(false);
  });
});

describe("applyClassification", () => {
  it("returns null when nothing was assigned and no tag is new", () => {
    expect(applyClassification({ id: "1" }, NO_ASSIGNMENT, {}, undefined, AT)).toBeNull();
    // A response whose only tag is one the record already has changes nothing,
    // so there is nothing to write and no version bump to spend.
    expect(
      applyClassification({ id: "1", tags: ["typescript"] }, response({ tags: [{ name: "typescript", noul: 0.95 }] }), {}, undefined, AT),
    ).toBeNull();
    // `skipped` is the server telling us it declined; nothing to apply.
    expect(applyClassification({ id: "1" }, response({ skipped: "low-confidence" }), {}, undefined, AT)).toBeNull();
  });

  it("never honours an id from a response that declined", () => {
    // `assign: false` with a stray id is the model declining *and* naming a
    // collection. Taking the id would be doing exactly what it said not to do.
    const declinedWithId = response({ collection: { assign: false, id: "L9", name: "Nope", confidence: 0.99, probabilities: {} } });
    expect(applyClassification({ id: "1" }, declinedWithId, {}, undefined, AT)).toBeNull();
    // An assign with no id cannot be written either.
    const noId = response({ collection: { assign: true, id: null, name: "Reading", confidence: 0.99, probabilities: {} } });
    expect(applyClassification({ id: "1" }, noId, {}, undefined, AT)).toBeNull();
  });

  it("sets listId and listName together, preferring the local name", () => {
    const patch = applyClassification({ id: "1" }, assigned("L1", "Reading"), new Map([["L1", "Reading list"]]), undefined, AT);
    expect(patch).not.toBeNull();
    expect(patch?.listId).toBe("L1");
    expect(patch?.listName).toBe("Reading list");

    // Unknown locally: fall back to the name the model echoed, then to the id —
    // a listId with no name renders as an empty chip, which is worse than a
    // duplicated label.
    expect(applyClassification({ id: "1" }, assigned("L2", "Later"), {}, undefined, AT)?.listName).toBe("Later");
    const bareId = response({ collection: { assign: true, id: "L3", name: null, confidence: 0.9, probabilities: {} } });
    const barePatch = applyClassification({ id: "1" }, bareId, {}, undefined, AT);
    expect(barePatch?.listId).toBe("L3");
    expect(barePatch?.listName).toBe("L3");

    // A record-style lookup works the same as the Map.
    expect(applyClassification({ id: "1" }, assigned("L1", "Reading"), { L1: "From record" }, undefined, AT)?.listName).toBe(
      "From record",
    );
    // Tags-only decisions never invent a collection.
    const tagsOnly = applyClassification({ id: "1" }, response({ tags: [{ name: "rust", noul: 0.9 }] }), {}, undefined, AT);
    expect(tagsOnly?.listId).toBeUndefined();
    expect(tagsOnly?.listName).toBeUndefined();
    expect(tagsOnly?.tags).toEqual(["rust"]);
  });

  it("attaches attribution only for a decision it actually applied", () => {
    const patch = applyClassification({ id: "1" }, assigned("L1", "Reading", 0.91), {}, undefined, AT);
    expect(patch?.ai).toEqual({ model: "jev-1.13.0", at: AT, collectionConfidence: 0.91 });
    // The stamp is the injected instant, so a whole pass can date its decisions
    // the same way and a test never has to read a clock.
    expect((patch?.ai as { at: string }).at).toBe(AT);
    // Nothing was tagged, so there is no tag confidence to claim.
    expect((patch?.ai as Record<string, unknown>).tagConfidence).toBeUndefined();

    const tagsOnly = applyClassification(
      { id: "1" },
      response({ tags: [{ name: "rust", noul: 0.88 }, { name: "wasm", noul: 0.81 }] }),
      {},
      undefined,
      AT,
    );
    expect((tagsOnly?.ai as Record<string, unknown>).collectionConfidence).toBeUndefined();
    expect((tagsOnly?.ai as Record<string, unknown>).tagConfidence).toEqual({ rust: 0.88, wasm: 0.81 });

    // The written patch is enough to flip eligibility, which is what stops a
    // second charge for the same bookmark.
    expect(bookmarkNeedsClassification({ id: "1", ...patch! })).toBe(false);
  });

  it("stamps the current time when no instant is injected", () => {
    const patch = applyClassification({ id: "1" }, assigned("L1", "Reading"), {}, undefined);
    const at = (patch?.ai as { at: string }).at;
    expect(new Date(at).toString()).not.toBe("Invalid Date");
  });

  it("preserves the user's existing tags and never duplicates", () => {
    const bookmark: ClassifiableBookmark = { id: "1", tags: ["TypeScript", "reading-list"] };
    const patch = applyClassification(
      bookmark,
      response({
        tags: [
          { name: "typescript", noul: 0.9 }, // same tag, different case
          { name: "#Reading-List", noul: 0.88 }, // same tag, hash and case
          { name: " Rust ", noul: 0.86 },
          { name: "rust", noul: 0.85 }, // duplicate of the previous entry
        ],
      }),
      {},
      undefined,
      AT,
    );
    // The user's spelling survives, their tags are all still there, and the only
    // addition is the one genuinely new tag - normalized.
    expect(patch?.tags).toEqual(["TypeScript", "reading-list", "rust"]);
    expect(bookmark.tags).toEqual(["TypeScript", "reading-list"]); // input not mutated
  });

  it("never drops the user's own tags when capping at maxTags", () => {
    const bookmark: ClassifiableBookmark = { id: "1", tags: ["one", "two", "three", "four", "five"] };
    const patch = applyClassification(
      bookmark,
      response({
        tags: [
          { name: "ai", noul: 0.99 },
          { name: "ml", noul: 0.95 },
          { name: "paper", noul: 0.9 },
          { name: "search", noul: 0.85 },
        ],
      }),
      {},
      2,
      AT,
    );
    // maxTags bounds what the model adds, never the merged total: a user with
    // five tags of their own is not silently down to two.
    expect(patch?.tags).toEqual(["one", "two", "three", "four", "five", "ai", "ml"]);
    expect((patch?.ai as Record<string, unknown>).tagConfidence).toEqual({ ai: 0.99, ml: 0.95 });

    // The cap is the response order (already noul-sorted by the server), so the
    // least confident suggestions are the ones that don't land. A zero budget
    // leaves nothing to write at all, so the worker skips the bookmark entirely.
    expect(applyClassification(bookmark, response({ tags: [{ name: "ai", noul: 0.99 }] }), {}, 0, AT)).toBeNull();

    // Without an explicit budget the documented default applies; a nonsense one
    // can't turn into "unlimited".
    const defaulted = applyClassification(
      { id: "2" },
      response({ tags: [{ name: "a", noul: 0.9 }, { name: "b", noul: 0.9 }, { name: "c", noul: 0.9 }, { name: "d", noul: 0.9 }] }),
      {},
      undefined,
      AT,
    );
    expect(defaulted?.tags).toEqual(["a", "b", "c"]);
  });
});

describe("attribution", () => {
  it("records the model and the instant, and nothing else", () => {
    expect(attribution(assigned("L1", "Reading", 0.9), false, [], AT)).toEqual({ model: "jev-1.13.0", at: AT });
  });

  it("records a confidence only for a decision that happened", () => {
    // A `collectionConfidence` on a record with no collection is the stale claim
    // docs/ai.md's merge rules exist to prevent: attribution is taken from the
    // same side as the assignment, so the two must never disagree.
    expect(attribution(NO_ASSIGNMENT, false, [{ name: "rust", noul: 0.9 }], AT)).toEqual({
      model: "jev-1.13.0",
      at: AT,
      tagConfidence: { rust: 0.9 },
    });
    expect(attribution(assigned("L1", "Reading", 0.9), true, [], AT).collectionConfidence).toBe(0.9);
    // And a decision that tagged nothing claims no tag confidences.
    expect(attribution(assigned("L1", "Reading", 0.9), true, [], AT).tagConfidence).toBeUndefined();
  });
});

describe("withTaxonomyAt", () => {
  it("adds the accepted-taxonomy date, which dates the taxonomy rather than the decision", () => {
    const patch = { listId: "L1", ai: { model: "jev-1.13.0", at: AT } };
    expect(withTaxonomyAt(patch, "2026-09-01T00:00:00.000Z").ai).toEqual({
      model: "jev-1.13.0",
      at: AT,
      taxonomyAt: "2026-09-01T00:00:00.000Z",
    });
  });

  it("leaves the patch alone when there is no accepted taxonomy, or no decision", () => {
    const patch = { listId: "L1", ai: { model: "jev-1.13.0", at: AT } };
    // Never guessed at: a made-up date would claim a taxonomy was accepted in
    // 1970, which is a claim about a record the user may never have created. An
    // account that has never accepted one carries `acceptedAt: null`, and the
    // worker turns that into this call by not passing a date at all.
    expect(withTaxonomyAt(patch, undefined)).toBe(patch);
    expect(withTaxonomyAt({ listId: "L1" }, "2026-09-01T00:00:00.000Z")).toEqual({ listId: "L1" });
  });
});

describe("patchChangesSomething", () => {
  it("sees a change in a scalar, a new array and a shorter array", () => {
    const bookmark: ClassifiableBookmark = { id: "1", listId: "L1", tags: ["a", "b"] };
    expect(patchChangesSomething(bookmark, { listId: "L2" })).toBe(true);
    expect(patchChangesSomething(bookmark, { tags: ["a", "b", "c"] })).toBe(true);
    expect(patchChangesSomething(bookmark, { ai: { model: "jev-1.13.0" } })).toBe(true);
  });

  it("sees nothing in a patch that restates what is already there", () => {
    // Every write stamps `updatedAt` and takes a sync version, so a patch that
    // changes nothing would push a no-op record to every device and resurface the
    // bookmark as freshly updated in the dashboard.
    const bookmark: ClassifiableBookmark = { id: "1", listId: "L1", tags: ["a", "b"] };
    // Arrays compare element-wise, not by identity: the merge always builds a new
    // one, so only this comparison can see that it equals what is stored.
    expect(patchChangesSomething(bookmark, { tags: ["a", "b"] })).toBe(false);
    expect(patchChangesSomething(bookmark, { listId: "L1" })).toBe(false);
    expect(patchChangesSomething(bookmark, {})).toBe(false);
  });

  it("reads a tombstone as a change, so a filed record is never left filed", () => {
    // listId and deletedAt are read as they are: `null` is a real value and
    // `Object.is` is the only comparison that tells it from `undefined`.
    const bookmark: ClassifiableBookmark = { id: "1", listId: null };
    expect(patchChangesSomething(bookmark, { listId: "L1" })).toBe(true);
    expect(patchChangesSomething({ id: "1" }, { listId: null })).toBe(true);
  });
});

describe("normalizeTagName", () => {
  it("trims, strips one leading hash and lowercases", () => {
    expect(normalizeTagName("  #TypeScript ")).toBe("typescript");
    expect(normalizeTagName("#rust")).toBe("rust");
    expect(normalizeTagName("##double")).toBe("#double");
    expect(normalizeTagName("Machine Learning")).toBe("machine learning");
    expect(normalizeTagName("")).toBe("");
    expect(normalizeTagName("   ")).toBe("");
    expect(normalizeTagName("#")).toBe("");
  });

  // Turkish casing. Both of these were found by running the proposer against the
  // real library, not by reading the code: the first produced a tag called
  // "i̇ş yönetimi ve crm", with an invisible combining dot that no user can type
  // back and no comparison downstream can match.
  it("does not leave a combining dot on a Turkish dotted I", () => {
    expect(normalizeTagName("İş Akışları")).toBe("iş akışları");
    expect(normalizeTagName("Eğitim İçeriği")).toBe("eğitim içeriği");
    expect(normalizeTagName("İlham Kaynakları")).toBe("ilham kaynakları");
    for (const name of ["İş Akışları", "Eğitim İçeriği", "İlham Kaynakları"]) {
      expect(/\p{M}/u.test(normalizeTagName(name))).toBe(false);
    }
  });

  it("keeps an English initialism intact inside a Turkish name", () => {
    // The per-word fold exists for this: under a whole-string Turkish locale "UI"
    // becomes "uı", which then fails to match the "ui" a user would type.
    expect(normalizeTagName("UI Tasarımları")).toBe("ui tasarımları");
    expect(normalizeTagName("AI")).toBe("ai");
    expect(normalizeTagName("shadcn/ui")).toBe("shadcn/ui");
  });
});

describe("foldCase", () => {
  it("is idempotent, so a stored name still matches when typed back", () => {
    // The failure this prevents is subtle and silent: "ÇAĞRI" and "çağrı" fold to
    // "çağrı" and "çağrı" under a per-word fold, but to "çağri" and "çağrı" under a
    // whole-string one, and those two never match each other.
    for (const name of ["İş Akışları", "UI Tasarımları", "ÇAĞRI", "çağrı", "Ağ Yapısı", "Türkçe", "AI"]) {
      const once = foldCase(name);
      expect(foldCase(once)).toBe(once);
    }
    expect(foldCase("ÇAĞRI")).toBe(foldCase("çağrı"));
    expect(foldCase("İş Akışları")).toBe(foldCase("iş akışları"));
  });

  it("does not conflate the dotless and dotted i where a word is pure ASCII", () => {
    // Documented limit: "ISI" is Turkish for "heat" and folds to "isi", which is
    // not the Turkish answer. It is self-consistent, so a tag stored and retyped
    // still matches — which is the property that actually matters here.
    expect(foldCase("ISI")).toBe("isi");
    expect(foldCase(foldCase("ISI"))).toBe("isi");
  });
});
