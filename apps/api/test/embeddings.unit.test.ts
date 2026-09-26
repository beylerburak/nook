// No network, no database and no API key: everything here is a pure function
// plus one call with an injected fetch. The Turkish folding cases are the ones
// apps/extension/tests/ai-classify.test.ts pins for `foldCase` on the same
// inputs, so the two implementations cannot drift apart without one of the two
// suites going red.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EMBEDDING_BATCH_SIZE,
  contentHash,
  embedTexts,
  embeddedText,
  embeddingAvailability,
  enqueueIndexing,
  foldForSearch,
  planEmbeddingWork,
  type IndexableRecord,
  type IndexedEntry,
} from "../src/embeddings.js";

const DIM = 768;

/** Long enough to clear the 40-character floor, so a fixture built from it is a
 *  record the plan would really embed. */
const BODY = "PostgreSQL indeksleme ve VACUUM davranışları üzerine kapsamlı bir yazı.";

function record(overrides: Record<string, unknown> = {}, id = "b1"): IndexableRecord {
  return { id, data: { id, ...overrides } };
}

/** A row that genuinely matches `record`, so "nothing to do" is proven by the
 *  hash and not by an accident. */
function stored(bookmark: IndexableRecord, overrides: Partial<IndexedEntry> = {}): IndexedEntry {
  return {
    content_hash: contentHash(embeddedText(bookmark)),
    model: "text-embedding-3-small",
    dim: DIM,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPENAI_API_KEY;
  delete process.env.NOOK_EMBEDDING_MODEL;
  delete process.env.NOOK_EMBEDDING_DIM;
});

describe("embeddedText", () => {
  it("takes only the five fields the doc names, and never the url, tags or ai", () => {
    const text = embeddedText(
      record({
        title: "PostgreSQL indeksleme",
        note: "VACUUM'un neden yavaşladığını anlamak istiyorum.",
        description: "Kısa bir açıklama ve birkaç cümle daha.",
        shortDescription: "Kısa bir açıklama.",
        creator: { handle: "@vdb", name: "Veritabanı" },
        // None of the following may reach the model, a hash, or the index.
        url: "https://news.example.com/story?utm_source=newsletter&token=SECRET",
        urls: ["https://second.example.com/SECRET-TOO"],
        tags: ["süreç-arka-planı"],
        media: [{ type: "image", url: "https://cdn.example.com/photo.jpg" }],
        ai: { model: "jev-latest", at: "2026-01-01T00:00:00Z", collectionConfidence: 0.93 },
        listName: "Reading",
        updatedAt: "2026-09-01T00:00:00Z",
      }),
    );

    expect(text).toContain("PostgreSQL indeksleme");
    expect(text).toContain("VACUUM'un neden yavaşladığını anlamak istiyorum.");
    expect(text).toContain("Kısa bir açıklama ve birkaç cümle daha.");
    expect(text).toContain("@vdb");

    // The whole point of the filter, asserted the way a leak would arrive.
    const serialized = JSON.stringify(text);
    for (const forbidden of ["SECRET", "example.com", "süreç-arka-planı", "jev", "0.93", "Reading", "photo.jpg"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("is not fooled by a creator without a handle, or by a creator that is not an object", () => {
    const named = embeddedText(
      record({ title: "Bir başlık", description: "ve burada gövde metni var, yeterince uzun.", creator: { name: "Sadece İsim" } }),
    );
    expect(named).not.toContain("Sadece İsim");

    // Anything a client sends is a possibility, not a promise: these must be
    // dropped rather than stringified into "[object Object]".
    const junk = embeddedText(
      record({ title: "Bir başlık", description: "ve burada gövde metni var, yeterince uzun.", creator: "nobody" }),
    );
    expect(junk).not.toContain("object");
  });

  it("caps a runaway field and caps the whole string", () => {
    const runaway = embeddedText(
      record({
        title: "t".repeat(5_000),
        description: "d".repeat(200_000),
        note: "n".repeat(9_000),
      }),
    );
    expect(runaway.length).toBeLessThanOrEqual(6000);
    // Per-field, not only per-record: a description cannot eat the note.
    expect(embeddedText(record({ title: "t".repeat(5_000), description: "d".repeat(200_000) })).length)
      .toBeLessThanOrEqual(6_000);
  });

  it("drops a record with nothing, or too little, worth embedding", () => {
    expect(embeddedText(record({}))).toBe("");
    expect(embeddedText(record({ title: "   ", description: "\n\n  ", note: "" }))).toBe("");
    // The ai.md floor, on a media-only capture that reduces to a handle.
    expect(embeddedText(record({ creator: { handle: "@someone" } }))).toBe("");
    // ...and one character under it is the same answer.
    const short = "x".repeat(39);
    expect(embeddedText(record({ title: short }))).toBe("");
    const justOver = "x".repeat(40);
    expect(embeddedText(record({ title: justOver }))).toBe(justOver);
  });

  it("keeps both description and shortDescription, because a record may carry only one", () => {
    const full = "Bu tam olarak yeterli uzunlukta bir açıklama metni.";
    const both = embeddedText(record({ title: "Başlık", description: full, shortDescription: full.slice(0, 20) }));
    // Both survive a collision, so a record that only has the short form (some
    // web captures) and one that only has the long form (some X bookmarks) are
    // both indexed rather than half the library.
    expect(both).toContain(full);
    expect(both).toContain(full.slice(0, 20));
    expect(embeddedText(record({ title: "Başlık", description: full }))).toContain(full);
    expect(embeddedText(record({ title: "Başlık", shortDescription: full }))).toContain(full);
  });

  it("reads a tombstone's text like any other record; liveness is the plan's question", () => {
    const gone = record({ title: "Silinmiş bir kayıt", description: "ve yeterince uzun bir gövde metni." });
    gone.data.deletedAt = "2026-09-01T00:00:00Z";
    expect(embeddedText(gone)).toContain("Silinmiş bir kayıt");
  });
});

describe("foldForSearch", () => {
  // `caseFolded` is the value apps/extension/tests/ai-classify.test.ts pins for
  // `foldCase` on that same input. `searchFolded` is that value with the accents
  // removed, which is the only thing this function is allowed to add.
  const shared: Array<[string, string, string]> = [
    // "normalizeTagName does not leave a combining dot on a Turkish dotted I"
    ["İş Akışları", "iş akışları", "is akislari"],
    ["Eğitim İçeriği", "eğitim içeriği", "egitim icerigi"],
    ["İlham Kaynakları", "ilham kaynakları", "ilham kaynaklari"],
    // "normalizeTagName keeps an English initialism intact inside a Turkish name"
    ["UI Tasarımları", "ui tasarımları", "ui tasarimlari"],
    ["AI", "ai", "ai"],
    ["shadcn/ui", "shadcn/ui", "shadcn/ui"],
    // "foldCase is idempotent, so a stored name still matches when typed back"
    ["ÇAĞRI", "çağrı", "cagri"],
    ["çağrı", "çağrı", "cagri"],
    ["Ağ Yapısı", "ağ yapısı", "ag yapisi"],
    ["Türkçe", "türkçe", "turkce"],
    // "foldCase does not conflate the dotless and dotted i where a word is pure ASCII"
    ["ISI", "isi", "isi"],
  ];

  it("folds Turkish the way the extension's foldCase does, and then drops the accents", () => {
    for (const [input, caseFolded, searchFolded] of shared) {
      // The case fold half is identical: the string this function starts from is
      // the string the extension would have produced.
      expect(foldForSearch(caseFolded)).toBe(searchFolded);
      // ...and folding the input lands on exactly the same place, which is the
      // property the shared cases were written to protect.
      expect(foldForSearch(input)).toBe(searchFolded);
    }
  });

  it("leaves no combining mark behind, and is idempotent", () => {
    for (const [input] of shared) {
      const once = foldForSearch(input);
      expect(/\p{M}/u.test(once)).toBe(false);
      expect(foldForSearch(once)).toBe(once);
    }
  });

  it("is idempotent on a mixed string", () => {
    const messy = "İŞ AKIŞLARI  ve\tUI Tasarımları — Çağrı/ÇağRI, Ğ ı ÖşÜ";
    const once = foldForSearch(messy);
    expect(once).toBe("is akislari ve ui tasarimlari — cagri/cagri, g i osu");
    expect(foldForSearch(once)).toBe(once);
    // Whitespace runs collapse rather than surviving as empty words, so a folded
    // column cannot end up with a double space nothing can match.
    expect(foldForSearch("a  b")).toBe("a b");
  });

  it("conflates the dotless i onto the dotted i, which a search index wants and a tag key does not", () => {
    // Documented difference from foldCase: a user who types "isi" has to find
    // "ısı", and the query and the column are folded by this same function, so
    // the conflation can only add recall.
    expect(foldForSearch("ısı")).toBe("isi");
    expect(foldForSearch("İŞ")).toBe("is");
    // ...and the European letters NFD cannot decompose are folded too, for a
    // library that is not purely Turkish.
    expect(foldForSearch("Straße Ærø Đör")).toBe("strasse aero dor");
  });

  it("is total, and does not choke on a string with no words in it", () => {
    expect(foldForSearch("")).toBe("");
    expect(foldForSearch("   ")).toBe("");
    expect(foldForSearch("\n\n")).toBe("");
  });
});

describe("contentHash", () => {
  it("is stable for the same text, including across calls", () => {
    const text = "Veritabanı performans sorunu";
    expect(contentHash(text)).toBe(contentHash(text));
    expect(contentHash(text)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs when the text differs at all", () => {
    const base = contentHash("Veritabanı performans sorunu");
    expect(contentHash("Veritabanı performan sorunu")).not.toBe(base);
    expect(contentHash("Veritabanı performans sorunu ")).not.toBe(base);
    expect(contentHash("")).not.toBe(base);
    // Folding must not change it: the hash gates re-embedding, and a fold change
    // must not cost a request for every bookmark in the library.
    expect(contentHash(foldForSearch("Veritabanı performans sorunu")))
      .not.toBe(contentHash("Veritabanı Performans Sorunu"));
  });
});

describe("planEmbeddingWork", () => {
  const bookmark = record({ title: "Veritabanı performans sorunu", description: BODY });

  it("skips a record whose text, model and dim all match the stored hash", () => {
    const plan = planEmbeddingWork([bookmark], new Map([["b1", stored(bookmark)]]));
    expect(plan).toEqual({ embed: [], remove: [], skip: ["b1"] });
  });

  it("re-embeds a record whose text changed", () => {
    const changed = record({ title: "Farklı bir başlık", description: BODY });
    const plan = planEmbeddingWork([changed], new Map([["b1", stored(bookmark)]]));
    expect(plan.embed).toEqual(["b1"]);
    expect(plan.remove).toEqual([]);
  });

  it("re-embeds when the model or the dim differs, which is how a change is discovered", () => {
    const modelChanged = planEmbeddingWork([bookmark], new Map([["b1", stored(bookmark, { model: "some-old-model" })]]));
    expect(modelChanged.embed).toEqual(["b1"]);

    const dimChanged = planEmbeddingWork([bookmark], new Map([["b1", stored(bookmark, { dim: 1536 })]]));
    expect(dimChanged.embed).toEqual(["b1"]);

    // The hash matches in both cases, so the model/dim comparison is the only
    // thing that could have caught either of them.
    const entry = stored(bookmark, { model: "some-old-model", dim: 1536 });
    expect(entry.content_hash).toBe(contentHash(embeddedText(bookmark)));
  });

  it("re-embeds anything the index has never seen", () => {
    const plan = planEmbeddingWork([record({ title: "Yeni bir kayıt", description: BODY }, "b9")], new Map());
    expect(plan.embed).toEqual(["b9"]);
  });

  it("schedules a delete for a deleted record, never a skip", () => {
    const deleted = record({ title: "Silinmiş", description: BODY });
    deleted.data.deletedAt = "2026-09-01T00:00:00Z";
    const plan = planEmbeddingWork([deleted], new Map([["b1", stored(deleted)]]));
    expect(plan.remove).toEqual(["b1"]);
    expect(plan.embed).toEqual([]);
    expect(plan.skip).toEqual([]);

    // The reconciler's own signal for the same thing, from nook_records.deleted_at.
    const fromColumn: IndexableRecord = { id: "b1", data: { ...deleted.data }, deletedAt: "2026-09-01T00:00:00Z" };
    delete fromColumn.data.deletedAt;
    expect(planEmbeddingWork([fromColumn], new Map([["b1", stored(bookmark)]])).remove).toEqual(["b1"]);
  });

  it("schedules a delete for a record that has become too short to embed", () => {
    const stub = record({ title: "   " });
    const plan = planEmbeddingWork([stub], new Map([["b1", stored(bookmark)]]));
    expect(plan.remove).toEqual(["b1"]);
    expect(plan.embed).toEqual([]);

    // Nothing stored, nothing to delete: a tombstone for a bookmark that was
    // never indexed is a no-op, not a pointless DELETE.
    expect(planEmbeddingWork([stub], new Map()).remove).toEqual([]);
  });

  it("ignores records with no usable id, and never mutates its inputs", () => {
    const records = [record({ title: "Geçerli bir başlık", description: BODY })];
    const before = JSON.stringify(records[0].data);
    const plan = planEmbeddingWork(records, new Map<string, IndexedEntry>());
    expect(plan.embed).toEqual(["b1"]);
    expect(JSON.stringify(records[0].data)).toBe(before);
    expect(planEmbeddingWork([{ id: "", data: {} }], new Map()).embed).toEqual([]);
  });

  it("defaults the model and dim from the environment, read at call time", () => {
    // A model change is invisible in the map the reconciler builds - it filters
    // on the active model - so this is the shape it actually sees.
    process.env.NOOK_EMBEDDING_MODEL = "text-embedding-3-large";
    process.env.NOOK_EMBEDDING_DIM = "256";
    const plan = planEmbeddingWork([bookmark], new Map([["b1", stored(bookmark)]]));
    expect(plan.embed).toEqual(["b1"]);

    // ...and a nonsense dim falls back to the documented default rather than
    // asking the provider for zero-dimension vectors.
    process.env.NOOK_EMBEDDING_DIM = "not-a-number";
    expect(embeddingAvailability().dim).toBe(768);
    expect(embeddingAvailability().model).toBe("text-embedding-3-large");
  });
});

describe("embedTexts", () => {
  const vector = (dim: number) => Array.from({ length: dim }, () => 0.25);

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  function recordingFetch(seen: number[]): (input: string, init: RequestInit) => Promise<Response> {
    return async (_input, init) => {
      const body = JSON.parse(String(init.body)) as { input: string[]; dimensions: number };
      seen.push(body.input.length);
      return jsonResponse({
        data: body.input.map((_text, index) => ({ index, embedding: vector(body.dimensions) })),
        usage: { prompt_tokens: 11, total_tokens: 13 },
        model: "text-embedding-3-small",
      });
    };
  }

  it("batches the library into requests of at most the batch size", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const seen: number[] = [];
    const texts = Array.from({ length: EMBEDDING_BATCH_SIZE * 2 + 44 }, (_, i) => `metin ${i}`);
    const result = await embedTexts(texts, { fetch: recordingFetch(seen) });

    // Not one call per text, and not one call for the lot: three requests,
    // 128 + 128 + 44.
    expect(seen).toEqual([EMBEDDING_BATCH_SIZE, EMBEDDING_BATCH_SIZE, 44]);
    expect(seen.every((size) => size <= EMBEDDING_BATCH_SIZE)).toBe(true);
    expect(result.batches).toBe(3);
    expect(result.failedBatches).toBe(0);
    expect(result.vectors).toHaveLength(texts.length);
  });

  it("pairs every vector with the text it was made from, across batch boundaries", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const seen: number[] = [];
    const texts = Array.from({ length: EMBEDDING_BATCH_SIZE + 5 }, (_, i) => `metin ${i}`);
    // A distinct value per position, so a mis-offset would be visible rather than
    // merely plausible.
    const result = await embedTexts(texts, {
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init.body)) as { input: string[]; dimensions: number };
        seen.push(body.input.length);
        return jsonResponse({
          data: body.input.map((_text, index) => ({
            index,
            embedding: Array.from({ length: body.dimensions }, () => body.input.indexOf(_text)),
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      },
    });
    expect(seen).toEqual([EMBEDDING_BATCH_SIZE, 5]);
    expect(result.vectors.map((entry) => entry.index)).toEqual(texts.map((_text, index) => index));
    // A batch that dies must not shift its neighbours along by one.
    expect(result.vectors[0].vector[0]).toBe(0);
    expect(result.vectors[EMBEDDING_BATCH_SIZE].vector[0]).toBe(0);
  });

  it("reports the provider's real token usage rather than estimating it", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const result = await embedTexts(["bir metin"], { fetch: recordingFetch([]) });
    expect(result.usage).toEqual({ promptTokens: 11, totalTokens: 13 });
  });

  it("returns an empty result on a failed fetch, without throwing", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const texts = ["bir metin", "başka bir metin"];

    // Network-level failure.
    const offline = await embedTexts(texts, {
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    expect(offline.vectors).toEqual([]);
    expect(offline.usage).toEqual({ promptTokens: 0, totalTokens: 0 });
    expect(offline.failedBatches).toBe(1);

    // Server error, and a 200 whose body is not JSON.
    const erroring = await embedTexts(texts, { fetch: async () => jsonResponse({ error: "boom" }, 500) });
    expect(erroring.vectors).toEqual([]);
    expect(erroring.failedBatches).toBe(1);

    const garbled = await embedTexts(texts, { fetch: async () => new Response("<html>502</html>", { status: 200 }) });
    expect(garbled.vectors).toEqual([]);
    expect(garbled.failedBatches).toBe(1);

    // A 200 with no embeddings in it is a failed batch, not an empty library.
    const emptyBody = await embedTexts(texts, { fetch: async () => jsonResponse({ data: [] }) });
    expect(emptyBody.vectors).toEqual([]);
    expect(emptyBody.failedBatches).toBe(1);
  });

  it("discards a batch whose vectors are the wrong length instead of writing them", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const result = await embedTexts(["bir metin"], {
      fetch: async () =>
        jsonResponse({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }], usage: { prompt_tokens: 1, total_tokens: 1 } }),
    });
    // A 3-dimension vector is not a smaller index, it is a different space.
    expect(result.vectors).toEqual([]);
    expect(result.failedBatches).toBe(1);
  });

  it("degrades to nothing when no key is configured, without calling out", async () => {
    const fetchSpy = vi.fn();
    const result = await embedTexts(["bir metin"], { fetch: fetchSpy as never });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.vectors).toEqual([]);
    expect(result.failedBatches).toBe(1);
  });

  it("does nothing at all for an empty list, keyed or not", async () => {
    const fetchSpy = vi.fn();
    expect(await embedTexts([], { fetch: fetchSpy as never })).toEqual({
      vectors: [],
      usage: { promptTokens: 0, totalTokens: 0 },
      batches: 0,
      failedBatches: 0,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("enqueueIndexing", () => {
  it("returns immediately without touching the database when no key is configured", () => {
    // The sync hook's whole contract: nothing here may be on the path between a
    // COMMIT and a response, and a server with no key has no work to queue.
    const query = vi.fn();
    expect(enqueueIndexing({ query } as never, "u1", [record({ title: "Başlık", description: BODY })])).toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });
});
