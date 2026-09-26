// lib/ai-classify.ts is pure, so most of this runs with no harness at all; the
// settings section at the bottom borrows fake-indexeddb the way tests/db.test.ts
// does, because ai-settings.ts is the one piece of the feature that touches a DB.
import "fake-indexeddb/auto";
import { expect, test, vi } from "vitest";
import {
  applyClassification,
  bookmarkNeedsClassification,
  foldCase,
  normalizeTagName,
  selectCandidates,
  toClassifyRequest,
  type AiTaxonomyOption,
  type ClassifyResponse,
} from "../lib/ai-classify";
import {
  AI_SETTINGS_META_KEY,
  DEFAULT_AI_SETTINGS,
  _resetAiSettingsCacheForTests,
  loadAiSettings,
  saveAiSettings,
  subscribeToAiSettings,
  type AiSettings,
} from "../lib/ai-settings";
import { saveCloudSession } from "../lib/cloud-sync";
import type { Bookmark } from "../lib/types";
import * as NookDB from "../lib/db";

/**
 * A minimal stand-in for PUT /api/ai/settings — merge-on-write, like the real
 * route (apps/api/src/ai-settings.ts). `saveAiSettings` is a server call now
 * (docs/ai.md, "Settings surface"), so the two tests below that exercise a
 * write need both a session (`saveCloudSession`) and something to answer it;
 * the read-only tests above them don't, since a signed-out `loadAiSettings()`
 * falls back to the local cache without ever reaching the network.
 */
function stubSettingsServer(): { settings: AiSettings } {
  const state = { settings: { ...DEFAULT_AI_SETTINGS } };
  vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "PUT") {
      state.settings = { ...state.settings, ...(JSON.parse(String(init?.body)) as Partial<AiSettings>) };
    }
    return new Response(JSON.stringify(state.settings), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  return state;
}

const NO_ASSIGNMENT: ClassifyResponse = {
  model: "jev-1.13.0",
  collection: { assign: false, id: null, name: null, confidence: 0.2, probabilities: {} },
  tags: [],
};

function response(overrides: Partial<ClassifyResponse> = {}): ClassifyResponse {
  return { ...NO_ASSIGNMENT, ...overrides };
}

function assigned(id: string, name: string, confidence = 0.93): ClassifyResponse {
  return response({
    collection: { assign: true, id, name, confidence, probabilities: { [id]: confidence, __none__: 0.04 } },
  });
}

// -- eligibility -----------------------------------------------------------

test("a bookmark in a collection is never a candidate, however it got there", () => {
  expect(bookmarkNeedsClassification({ id: "1", source: "x" })).toBe(true);
  expect(bookmarkNeedsClassification({ id: "1", source: "x", listId: "L1", listName: "Reading" })).toBe(false);
  // A cleared assignment (deleted collection, "Remove from collection") is a
  // candidate again; only a live listId protects a bookmark.
  expect(bookmarkNeedsClassification({ id: "1", source: "x", listId: null, listName: null })).toBe(true);
  expect(bookmarkNeedsClassification({ id: "1", source: "x", ai: null })).toBe(true);
});

test("an already-classified bookmark is never a candidate again", () => {
  const classified: Bookmark = { id: "1", source: "x", ai: { model: "jev-1.13.0", at: "2026-01-01T00:00:00Z" } };
  expect(bookmarkNeedsClassification(classified)).toBe(false);
  // Even after the user removed the collection: re-filing it would be a second
  // charge for a decision that was already made and already overruled.
  expect(bookmarkNeedsClassification({ ...classified, listId: null, listName: null })).toBe(false);
});

test("selectCandidates skips manual and classified bookmarks, and soft-deleted ones", () => {
  const bookmarks: Bookmark[] = [
    { id: "plain", source: "x", savedAt: "2026-03-01T00:00:00Z" },
    { id: "manual", source: "x", savedAt: "2026-03-02T00:00:00Z", listId: "L1", listName: "Reading" },
    { id: "done", source: "x", savedAt: "2026-03-03T00:00:00Z", ai: { model: "jev-1.13.0", at: "2026-01-01T00:00:00Z" } },
    { id: "gone", source: "x", savedAt: "2026-03-04T00:00:00Z", deletedAt: "2026-03-05T00:00:00Z" },
  ];
  expect(selectCandidates(bookmarks, 10).map((b) => b.id)).toEqual(["plain"]);
});

test("selectCandidates is newest first, respects limit, and tolerates missing timestamps", () => {
  const bookmarks: Bookmark[] = [
    { id: "old", source: "x", savedAt: "2026-01-01T00:00:00Z" },
    { id: "newest", source: "x", savedAt: "2026-03-01T00:00:00Z" },
    { id: "middle", source: "x", savedAt: "2026-02-01T00:00:00Z" },
    { id: "no-timestamps", source: "x" },
    { id: "created-only", source: "x", createdAt: "2026-02-15T00:00:00Z" },
    { id: "updated-only", source: "x", updatedAt: "2026-02-20T00:00:00Z" },
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

// -- request ---------------------------------------------------------------

const COLLECTIONS: AiTaxonomyOption[] = [{ id: "L1", name: "Reading", samples: ["a", "b"] }];
const TAGS: AiTaxonomyOption[] = [{ id: "typescript", name: "typescript", samples: ["c"] }];

test("toClassifyRequest sends the host, never the URL with its path or query", () => {
  const bookmark: Bookmark = {
    id: "web:1",
    source: "web",
    title: "  A page  ",
    shortDescription: "Short.",
    note: "My note",
    url: "https://news.example.com/2026/03/story?utm_source=newsletter&token=SECRET",
    creator: { name: "Real Name", handle: "@someone" },
  };
  const request = toClassifyRequest(bookmark, COLLECTIONS, TAGS, DEFAULT_AI_SETTINGS);
  expect(request.bookmark.site).toBe("news.example.com");
  const serialized = JSON.stringify(request);
  expect(serialized).not.toContain("SECRET");
  expect(serialized).not.toContain("/2026/03/story");
  expect(request.bookmark.title).toBe("A page");
  expect(request.bookmark.author).toBe("@someone");
  expect(request.bookmark.note).toBe("My note");

  // A URL we can't parse contributes nothing rather than a guess, and creator
  // name is the fallback when there's no handle.
  const bare = toClassifyRequest(
    { id: "x:1", source: "x", url: "not a url", creator: { name: "Real Name" } },
    COLLECTIONS,
    TAGS,
    DEFAULT_AI_SETTINGS
  );
  expect("site" in bare.bookmark).toBe(false);
  expect(bare.bookmark.author).toBe("Real Name");
});

test("toClassifyRequest never sends the full description and truncates a long summary", () => {
  const secret = "FULL-DESCRIPTION-MARKER";
  const bookmark: Bookmark = {
    id: "web:2",
    source: "web",
    title: "T",
    shortDescription: "s".repeat(400),
    description: `${secret} ${"d".repeat(1000)}`,
  };
  const request = toClassifyRequest(bookmark, COLLECTIONS, TAGS, DEFAULT_AI_SETTINGS);
  expect(JSON.stringify(request)).not.toContain(secret);
  expect(request.bookmark.summary!.length).toBeLessThanOrEqual(301);
  expect(request.bookmark.summary!.startsWith("sss")).toBe(true);
  // summary comes from shortDescription, never from description.
  expect(request.bookmark.summary).not.toBe(bookmark.shortDescription);

  const empty = toClassifyRequest({ id: "web:3", source: "web", title: "   " }, [], [], DEFAULT_AI_SETTINGS);
  expect("title" in empty.bookmark).toBe(false);
  expect("summary" in empty.bookmark).toBe(false);
  expect(empty.bookmark).toEqual({ id: "web:3" });
});

test("toClassifyRequest passes the three thresholds and the options it was handed", () => {
  const request = toClassifyRequest(
    { id: "1", source: "x" },
    COLLECTIONS,
    TAGS,
    { ...DEFAULT_AI_SETTINGS, collectionMinConfidence: 0.9, tagMinNoul: 0.7, maxTags: 5 }
  );
  expect(request.settings).toEqual({ collectionMinConfidence: 0.9, tagMinNoul: 0.7, maxTags: 5 });
  expect(request.collections).toEqual(COLLECTIONS);
  // A tag's member-title digest is deliberately not sent: it halved tag recall
  // when it was (docs/ai-calibration.md). What does go out is a definition.
  expect(request.tags).toEqual([{ name: "typescript", samples: [] }]);
});

test("toClassifyRequest forwards a tag's definition, and omits the key when there is none", () => {
  const withDefinition = toClassifyRequest(
    { id: "b1" } as never,
    [],
    [{ id: "tag:web", name: "web", samples: [], definition: "Ön yüz işleri." }],
    DEFAULT_AI_SETTINGS,
  );
  expect(withDefinition.tags).toEqual([{ name: "web", samples: [], definition: "Ön yüz işleri." }]);

  // Omitted rather than sent as undefined, so the server cannot mistake an
  // absent definition for a reason to build a digest.
  const without = toClassifyRequest(
    { id: "b1" } as never,
    [],
    [{ id: "tag:web", name: "web", samples: [] }],
    DEFAULT_AI_SETTINGS,
  );
  expect("definition" in without.tags[0]).toBe(false);
});

// -- response --------------------------------------------------------------

test("applyClassification returns null when nothing was assigned and no tag is new", () => {
  expect(applyClassification({ id: "1", source: "x" }, NO_ASSIGNMENT, {})).toBeNull();
  // A response whose only tag is one the record already has changes nothing,
  // so there is nothing to write and no updatedAt bump to spend.
  const alreadyTagged: Bookmark = { id: "1", source: "x", tags: ["typescript"] };
  expect(applyClassification(alreadyTagged, response({ tags: [{ name: "typescript", noul: 0.95 }] }), {})).toBeNull();
  // `skipped` is the server telling us it declined; nothing to apply.
  expect(applyClassification({ id: "1", source: "x" }, response({ skipped: "low-confidence" }), {})).toBeNull();
});

test("applyClassification sets listId and listName together, preferring the local name", () => {
  const patch = applyClassification({ id: "1", source: "x" }, assigned("L1", "Reading"), new Map([["L1", "Reading list"]]));
  expect(patch).not.toBeNull();
  expect(patch!.listId).toBe("L1");
  expect(patch!.listName).toBe("Reading list");

  // Unknown locally: fall back to the name the model echoed, then to the id -
  // a listId with no name renders as an empty chip, which is worse than a
  // duplicated label.
  expect(applyClassification({ id: "1", source: "x" }, assigned("L2", "Later"), {})!.listName).toBe("Later");
  const bareId = response({ collection: { assign: true, id: "L3", name: null, confidence: 0.9, probabilities: {} } });
  const barePatch = applyClassification({ id: "1", source: "x" }, bareId, {});
  expect(barePatch!.listId).toBe("L3");
  expect(barePatch!.listName).toBe("L3");

  // A record-style lookup works the same as the Map.
  expect(applyClassification({ id: "1", source: "x" }, assigned("L1", "Reading"), { L1: "From record" })!.listName).toBe(
    "From record"
  );
  // Tags-only decisions never invent a collection.
  const tagsOnly = applyClassification({ id: "1", source: "x" }, response({ tags: [{ name: "rust", noul: 0.9 }] }), {});
  expect(tagsOnly!.listId).toBeUndefined();
  expect(tagsOnly!.listName).toBeUndefined();
  expect(tagsOnly!.tags).toEqual(["rust"]);
});

test("applyClassification attaches attribution, and only for a decision it actually applied", () => {
  const patch = applyClassification(
    { id: "1", source: "x" },
    assigned("L1", "Reading", 0.91),
    {}
  );
  expect(patch!.ai).toMatchObject({ model: "jev-1.13.0", collectionConfidence: 0.91 });
  expect(typeof patch!.ai!.at).toBe("string");
  expect(new Date(patch!.ai!.at).toString()).not.toBe("Invalid Date");
  // Nothing was tagged, so there is no tag confidence to claim.
  expect(patch!.ai!.tagConfidence).toBeUndefined();

  const tagsOnly = applyClassification(
    { id: "1", source: "x" },
    response({ tags: [{ name: "rust", noul: 0.88 }, { name: "wasm", noul: 0.81 }] }),
    {}
  );
  expect(tagsOnly!.ai!.collectionConfidence).toBeUndefined();
  expect(tagsOnly!.ai!.tagConfidence).toEqual({ rust: 0.88, wasm: 0.81 });

  // The written patch is enough to flip eligibility, which is what stops a
  // second charge for the same bookmark.
  expect(bookmarkNeedsClassification({ id: "1", source: "x", ...patch! })).toBe(false);
});

test("applyClassification preserves the user's existing tags and never duplicates", () => {
  const bookmark: Bookmark = { id: "1", source: "x", tags: ["TypeScript", "reading-list"] };
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
    {}
  );
  // The user's spelling survives, their tags are all still there, and the only
  // addition is the one genuinely new tag - normalized.
  expect(patch!.tags).toEqual(["TypeScript", "reading-list", "rust"]);
  expect(bookmark.tags).toEqual(["TypeScript", "reading-list"]); // input not mutated
});

test("applyClassification never drops the user's own tags when capping at maxTags", () => {
  const bookmark: Bookmark = { id: "1", source: "x", tags: ["one", "two", "three", "four", "five"] };
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
    2
  );
  // maxTags bounds what the model adds, never the merged total: a user with
  // five tags of their own is not silently down to two.
  expect(patch!.tags).toEqual(["one", "two", "three", "four", "five", "ai", "ml"]);
  expect(patch!.ai!.tagConfidence).toEqual({ ai: 0.99, ml: 0.95 });

  // The cap is the response order (already noul-sorted by the server), so the
  // least confident suggestions are the ones that don't land. A zero budget
  // leaves nothing to write at all, so the runner skips the bookmark entirely.
  const zeroBudget = applyClassification(bookmark, response({ tags: [{ name: "ai", noul: 0.99 }] }), {}, 0);
  expect(zeroBudget).toBeNull();

  // Without an explicit budget the documented default applies; a nonsense one
  // can't turn into "unlimited".
  const defaulted = applyClassification(
    { id: "2", source: "x" },
    response({ tags: [{ name: "a", noul: 0.9 }, { name: "b", noul: 0.9 }, { name: "c", noul: 0.9 }, { name: "d", noul: 0.9 }] }),
    {}
  );
  expect(defaulted!.tags).toEqual(["a", "b", "c"]);
});

test("normalizeTagName trims, strips one leading hash and lowercases", () => {
  expect(normalizeTagName("  #TypeScript ")).toBe("typescript");
  expect(normalizeTagName("#rust")).toBe("rust");
  expect(normalizeTagName("##double")).toBe("#double");
  expect(normalizeTagName("Machine Learning")).toBe("machine learning");
  expect(normalizeTagName("")).toBe("");
  expect(normalizeTagName("   ")).toBe("");
  expect(normalizeTagName("#")).toBe("");
});

// -- settings --------------------------------------------------------------

test("loadAiSettings returns the measured defaults when nothing is stored", async () => {
  NookDB._resetForTests();
  expect(await loadAiSettings()).toEqual(DEFAULT_AI_SETTINGS);
  expect(DEFAULT_AI_SETTINGS.autoClassify).toBe(false);
  expect(DEFAULT_AI_SETTINGS.autoTaxonomy).toBe(false);
});

test("loadAiSettings is total: partial, corrupt and out-of-range values all resolve", async () => {
  NookDB._resetForTests();
  await NookDB.setMeta(AI_SETTINGS_META_KEY, { autoClassify: true });
  expect(await loadAiSettings()).toEqual({ ...DEFAULT_AI_SETTINGS, autoClassify: true });

  await NookDB.setMeta(AI_SETTINGS_META_KEY, {
    autoClassify: "yes",
    autoTaxonomy: 1,
    collectionMinConfidence: 4.2,
    tagMinNoul: -1,
    maxTags: 9999,
    taxonomyLanguage: "klingon",
  });
  expect(await loadAiSettings()).toEqual({
    ...DEFAULT_AI_SETTINGS,
    // Clamped, because these are probabilities and a count, not free text.
    collectionMinConfidence: 1,
    tagMinNoul: 0,
    maxTags: 10,
    // A language this build does not know falls back rather than failing.
    taxonomyLanguage: "auto",
  });

  await NookDB.setMeta(AI_SETTINGS_META_KEY, "corrupt");
  expect(await loadAiSettings()).toEqual(DEFAULT_AI_SETTINGS);
  await NookDB.setMeta(AI_SETTINGS_META_KEY, null);
  expect(await loadAiSettings()).toEqual(DEFAULT_AI_SETTINGS);
});

test("saveAiSettings merges over the stored value, so one field is enough", async () => {
  NookDB._resetForTests();
  _resetAiSettingsCacheForTests();
  stubSettingsServer();
  await saveCloudSession("test-token", "user-1");
  try {
    const first = await saveAiSettings({ autoClassify: true, collectionMinConfidence: 0.9 });
    expect(first).toEqual({ ...DEFAULT_AI_SETTINGS, autoClassify: true, collectionMinConfidence: 0.9 });

    const second = await saveAiSettings({ maxTags: 5 });
    expect(second).toEqual({ ...first, maxTags: 5 });
    expect(await loadAiSettings()).toEqual(second);
    expect(await NookDB.getMeta(AI_SETTINGS_META_KEY)).toEqual(second);

    // Out-of-range input is normalized on the way in, not just on the way out.
    expect(await saveAiSettings({ tagMinNoul: 7 })).toMatchObject({ tagMinNoul: 1, autoClassify: true });
  } finally {
    vi.unstubAllGlobals();
  }
});

test("subscribeToAiSettings picks up a settings write from another context", async () => {
  NookDB._resetForTests();
  _resetAiSettingsCacheForTests();
  stubSettingsServer();
  await saveCloudSession("test-token", "user-1");
  try {
    const seen: AiSettings[] = [];
    const stop = subscribeToAiSettings((settings) => seen.push(settings));
    // The first emission is asynchronous - it reads the server, like the
    // panel's own initial load - so a listener is never called with a guess.
    expect(seen).toEqual([]);
    await vi.waitFor(() => expect(seen).toEqual([DEFAULT_AI_SETTINGS]));

    // A settings surface writes; a panel in the same context hears it directly,
    // because a BroadcastChannel never posts back to its own sender. This is the
    // only cross-context path there is: NookDB.setMeta doesn't broadcast.
    await saveAiSettings({ autoClassify: true, maxTags: 4 });
    expect(seen[seen.length - 1]).toEqual({ ...DEFAULT_AI_SETTINGS, autoClassify: true, maxTags: 4 });

    // ...and a panel in another context hears it through "nook-db".
    const remote: AiSettings[] = [];
    const other = new BroadcastChannel("nook-db");
    other.onmessage = () => void loadAiSettings().then((settings) => remote.push(settings));
    await saveAiSettings({ autoTaxonomy: true });
    await vi.waitFor(() => expect(remote[remote.length - 1]?.autoTaxonomy).toBe(true));
    other.close();

    // Unsubscribed means unsubscribed: the channel is closed, not just ignored.
    stop();
    const count = seen.length;
    await saveAiSettings({ maxTags: 1 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(seen).toHaveLength(count);
  } finally {
    vi.unstubAllGlobals();
  }
});

// Turkish casing. Both of these were found by running the proposer against the
// real library, not by reading the code: the first produced a tag called
// "i̇ş yönetimi ve crm", with an invisible combining dot that no user can type
// back and no comparison downstream can match.
test("normalizeTagName does not leave a combining dot on a Turkish dotted I", () => {
  expect(normalizeTagName("İş Akışları")).toBe("iş akışları");
  expect(normalizeTagName("Eğitim İçeriği")).toBe("eğitim içeriği");
  expect(normalizeTagName("İlham Kaynakları")).toBe("ilham kaynakları");
  for (const name of ["İş Akışları", "Eğitim İçeriği", "İlham Kaynakları"]) {
    expect(/[̀-ͯ]/.test(normalizeTagName(name))).toBe(false);
  }
});

test("normalizeTagName keeps an English initialism intact inside a Turkish name", () => {
  // The per-word fold exists for this: under a whole-string Turkish locale "UI"
  // becomes "uı", which then fails to match the "ui" a user would type.
  expect(normalizeTagName("UI Tasarımları")).toBe("ui tasarımları");
  expect(normalizeTagName("AI")).toBe("ai");
  expect(normalizeTagName("shadcn/ui")).toBe("shadcn/ui");
});

test("foldCase is idempotent, so a stored name still matches when typed back", () => {
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

test("foldCase does not conflate the dotless and dotted i where a word is pure ASCII", () => {
  // Documented limit: "ISI" is Turkish for "heat" and folds to "isi", which is
  // not the Turkish answer. It is self-consistent, so a tag stored and retyped
  // still matches — which is the property that actually matters here.
  expect(foldCase("ISI")).toBe("isi");
  expect(foldCase(foldCase("ISI"))).toBe("isi");
});
