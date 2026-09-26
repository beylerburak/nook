// The pure half of taxonomy growth: no database, no network, no proposer. Every
// case here is a decision the server makes about a name the user was shown, so
// the suite is also the argument that none of them needs a browser.
import { describe, expect, it } from "vitest";
import {
  MAX_OPTION_SAMPLES,
  MAX_TAXONOMY_TAGS,
  PROPOSAL_MAX_COLLECTIONS,
  PROPOSAL_MAX_TAGS,
  TAXONOMY_SAMPLE_SIZE,
  dropTakenProposals,
  isTagCoveredByCollection,
  normalizeAcceptedTaxonomy,
  planLists,
  planTags,
  readProposedTags,
  readProposals,
  selectSample,
  toAcceptedTaxonomy,
  type TaxonomyProposal,
} from "../src/ai-taxonomy.js";
import type { ClassifiableBookmark, ClassifiableList } from "../src/ai-classify.js";

// -- fixtures ---------------------------------------------------------------

const AT = "2026-09-26T12:00:00.000Z";
const LATER = "2026-10-01T00:00:00.000Z";

/** A title long enough to clear the sample floor on its own. */
const FILLER = "A page about something worth filing, with enough text to be a real sample entry";

function bookmark(overrides: Partial<ClassifiableBookmark> & { id: string }): ClassifiableBookmark {
  return { url: "https://example.com/post", title: FILLER, ...overrides };
}

function library(count: number, make: (index: number) => Partial<ClassifiableBookmark> = () => ({})): ClassifiableBookmark[] {
  return Array.from({ length: count }, (_, index) =>
    bookmark({ id: `b-${String(index).padStart(4, "0")}`, ...make(index) }),
  );
}

function proposal(name: string, why = "Because it holds a theme your library keeps returning to."): TaxonomyProposal {
  return { name, why };
}

function list(id: string, name: string): ClassifiableList {
  return { id, name };
}

// -- sampling ---------------------------------------------------------------

describe("selectSample", () => {
  it("yields the same sample from the same library every time", () => {
    const bookmarks = library(500);
    const first = selectSample(bookmarks, 50).map((item) => item.id);
    const second = selectSample(bookmarks, 50).map((item) => item.id);

    expect(first).toEqual(second);
    expect(first).toHaveLength(50);
    expect(new Set(first).size).toBe(50);
  });

  it("is spread across the library, not taken from the front", () => {
    // 1,061 is the real library size docs/ai-calibration.md measured on: a stride
    // over it has to reach the oldest saves, or a proposal only ever describes
    // what the user saved most recently.
    const bookmarks = library(1061);
    const sample = selectSample(bookmarks, 200);

    expect(sample).toHaveLength(200);
    expect(sample[0]?.id).toBe("b-0000");
    // The last pick is ~99% of the way through, not the 200th item.
    const positions = sample.map((item) => bookmarks.findIndex((entry) => entry.id === item.id));
    expect(positions[positions.length - 1]).toBeGreaterThan(1000);
    // Roughly even, which is the whole point of the stride.
    const gaps = positions.slice(1).map((position, index) => position - positions[index]!);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(5);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(6);
  });

  it("is not the first N of a smaller library", () => {
    const bookmarks = library(100);
    const sample = selectSample(bookmarks, 10).map((item) => item.id);

    expect(sample).not.toEqual(bookmarks.slice(0, 10).map((item) => item.id));
    // Every tenth item, so the last pick is 90% of the way in — nowhere near the
    // front 10 a slice would have given.
    expect(sample).toEqual([
      "b-0000",
      "b-0010",
      "b-0020",
      "b-0030",
      "b-0040",
      "b-0050",
      "b-0060",
      "b-0070",
      "b-0080",
      "b-0090",
    ]);
  });

  it("does not depend on the order the rows came back in", () => {
    const bookmarks = library(60);
    const forward = selectSample(bookmarks, 10).map((item) => item.id);
    const reversed = selectSample([...bookmarks].reverse(), 10).map((item) => item.id);

    expect(reversed).toEqual(forward);
  });

  it("never samples a filed, already-decided or soft-deleted bookmark", () => {
    // Eligibility is the classifier's, so the sample is drawn from exactly the
    // set a pass still has to file: a bookmark in a collection is there because a
    // human put it there, and one the model has ruled on is by construction one it
    // had an opinion about. Neither is evidence about what is still unorganised.
    const bookmarks = [
      bookmark({ id: "b-filed", listId: "l1", listName: "Reading" }),
      bookmark({ id: "b-decided", ai: { model: "jev-1.13.0", at: AT } }),
      bookmark({ id: "b-deleted", deletedAt: AT }),
      bookmark({ id: "b-live" }),
    ];

    expect(selectSample(bookmarks, 10).map((item) => item.id)).toEqual(["b-live"]);
  });

  it("leaves out near-empty items, the way the classify route leaves them out", () => {
    // 39 of the real 1,061-item library fall under the 40-character floor, and 15
    // of those under 20 characters — media-only bookmarks that reduce to an emoji
    // or a handle. A sample full of them teaches the proposer nothing.
    const bookmarks = [
      bookmark({ id: "b-emoji", title: "🙃", url: "" }),
      bookmark({ id: "b-handle", title: "@someone", url: "https://x.com" }),
      bookmark({ id: "b-short", title: "Dark mode" }),
      bookmark({ id: "b-real", title: FILLER }),
    ];

    expect(selectSample(bookmarks, 10).map((item) => item.id)).toEqual(["b-real"]);
  });

  it("counts the site as well as the title, because that is what the model is shown", () => {
    // A sample entry is {title, site}, so that is what the floor measures: the
    // question is whether there is anything to read, not how much of it is a
    // title. "Kurulum" alone teaches the proposer nothing; the same title on a
    // long host is a real, identifiable save.
    const short = [bookmark({ id: "b-1", title: "Kurulum", url: "https://ex.co" })];
    const readable = [bookmark({ id: "b-2", title: "Kurulum adımı", url: "https://www.kurulumrehberi.example.co.uk/blog" })];

    expect(selectSample(short, 10)).toEqual([]);
    expect(selectSample(readable, 10)).toHaveLength(1);
  });

  it("clamps an over-large ask rather than looking like it worked", () => {
    // MAX_SAMPLE_ITEMS on the parse side stops at 200 and drops the rest, so a
    // bigger number would silently propose from half the evidence.
    expect(selectSample(library(400), 5000)).toHaveLength(TAXONOMY_SAMPLE_SIZE);
  });

  it("produces no sample at all when there is nothing eligible to read", () => {
    expect(selectSample(library(10, (index) => ({ listId: `l${index}` })), 10)).toEqual([]);
    expect(selectSample([], 10)).toEqual([]);
    expect(selectSample(library(10), 0)).toEqual([]);
    expect(selectSample(library(10), -1)).toEqual([]);
    expect(selectSample(library(10), Number.NaN)).toEqual([]);
  });
});

// -- the record -------------------------------------------------------------

describe("toAcceptedTaxonomy", () => {
  it("names every accepted collection and dates the acceptance", () => {
    const taxonomy = toAcceptedTaxonomy([proposal("Tasarım")], library(3), AT);

    expect(taxonomy.acceptedAt).toBe(AT);
    expect(taxonomy.collections).toHaveLength(1);
    expect(taxonomy.collections[0]?.name).toBe("Tasarım");
    expect(taxonomy.collections[0]?.id).toBe("tasarım");
  });

  it("backs a collection with the sample items that actually talk about it", () => {
    const samples = [
      bookmark({ id: "b-1", title: "CSS grid and container queries in practice" }),
      bookmark({ id: "b-2", title: "Figma ile tasarım sistemi kurmak" }),
      bookmark({ id: "b-3", title: "An unrelated recipe for bread" }),
    ];

    const taxonomy = toAcceptedTaxonomy([proposal("Tasarım")], samples, AT);

    // Only b-2 says anything about design; handing the model a digest of the
    // other two would tell it the collection holds bread and CSS.
    expect(taxonomy.collections[0]?.samples).toEqual(["Figma ile tasarım sistemi kurmak"]);
  });

  it("gives a collection nothing in the sample shares a word with an empty digest", () => {
    const taxonomy = toAcceptedTaxonomy([proposal("Yapay Zeka")], [bookmark({ id: "b-1", title: FILLER })], AT);

    // Name-only is the honest state for a brand-new empty collection, and the
    // classifier already offers one (a `Choice` criterion falls back to the name).
    expect(taxonomy.collections[0]?.samples).toEqual([]);
  });

  it("ignores diacritics, because the library this was measured on is Turkish", () => {
    const samples = [
      bookmark({ id: "b-1", title: "Ücretsiz bir Türkçe kaynak listesi" }),
      bookmark({ id: "b-2", title: "A paid English newsletter roundup" }),
    ];

    const taxonomy = toAcceptedTaxonomy([proposal("Ucretsiz Turkce")], samples, AT);

    expect(taxonomy.collections[0]?.samples).toEqual(["Ücretsiz bir Türkçe kaynak listesi"]);
  });

  it("caps a digest, so one very long sample cannot fill the record", () => {
    const samples = Array.from({ length: 9 }, (_, index) =>
      bookmark({ id: `b-${index}`, title: `Tasarım çalışması ${index}` }),
    );

    const taxonomy = toAcceptedTaxonomy([proposal("Tasarım")], samples, AT);

    // The worker trims to this many on every read, so carrying more only grows a
    // record that is read on every tick.
    expect(taxonomy.collections[0]?.samples).toHaveLength(MAX_OPTION_SAMPLES);
    expect(MAX_OPTION_SAMPLES).toBe(5);
  });

  it("gives every accepted collection its own digest, never a shared one", () => {
    const samples = library(4, (index) => ({ title: `Tasarım notları ${index}` }));
    const taxonomy = toAcceptedTaxonomy([proposal("Tasarım"), proposal("Sistem")], samples, AT);

    expect(taxonomy.collections[0]?.samples).toHaveLength(4);
    expect(taxonomy.collections[1]?.samples).toEqual([]);
  });

  it("keeps the collections accepted by an earlier batch", () => {
    // This runs a handful of times a year and each run accepts a different
    // handful of names, so a record that only ever described the newest batch
    // would strip the evidence from every collection accepted before it.
    const first = toAcceptedTaxonomy([proposal("Tasarım")], library(2), AT);
    const second = toAcceptedTaxonomy([proposal("Sistem")], library(2), LATER, first.collections);

    expect(second.collections.map((entry) => entry.name)).toEqual(["Tasarım", "Sistem"]);
    expect(second.collections[0]?.samples).toEqual(first.collections[0]?.samples);
    expect(second.acceptedAt).toBe(LATER);
  });

  it("replaces a re-proposed name's earlier entry rather than duplicating it", () => {
    const first = toAcceptedTaxonomy([proposal("Tasarım")], library(2), AT);
    const second = toAcceptedTaxonomy([proposal("tasarım")], library(2), AT, first.collections);

    expect(second.collections).toHaveLength(1);
    expect(second.collections[0]?.name).toBe("tasarım");
  });

  it("carries an earlier tag vocabulary forward instead of replacing it", () => {
    const first = toAcceptedTaxonomy([], [], "2026-01-01T00:00:00.000Z", [], [{ name: "tasarım" }]);
    const second = toAcceptedTaxonomy([], [], LATER, [], [{ name: "geliştirme" }], first.tags);
    // Same discipline as the collections: a run today must not empty one from
    // last spring, or every tag would lose its first chance at a member.
    expect(second.tags).toEqual([{ name: "tasarım" }, { name: "geliştirme" }]);
    expect(second.acceptedAt).toBe(LATER);
  });

  it("normalises what it stores and never repeats a name", () => {
    const record = toAcceptedTaxonomy([], [], AT, [], [
      { name: "#Tasarım" },
      { name: "tasarım" },
      { name: "  Tasarım  " },
      { name: "UX", definition: "Arayüz." },
    ]);
    expect(record.tags).toEqual([{ name: "tasarım" }, { name: "ux", definition: "Arayüz." }]);
  });

  it("caps the stored vocabulary at what one classification can ask about", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ name: `tag ${index}` }));
    const record = toAcceptedTaxonomy([], [], AT, [], many);
    // Exactly the ask budget, not less. It used to be 12, on the theory that a
    // smaller vocabulary would leave room for the library's own tags — but those
    // are already built first and sliced, so they were never crowded out, and 12
    // meant that ticking 13 of the 20 tags the proposer offered silently discarded
    // one. Nothing the user ticks should vanish at acceptance.
    expect(record.tags).toHaveLength(MAX_TAXONOMY_TAGS);
    expect(MAX_TAXONOMY_TAGS).toBe(20);
  });
});

// -- reading a stored record ------------------------------------------------

describe("normalizeAcceptedTaxonomy", () => {
  it("reads back exactly what was written", () => {
    const written = toAcceptedTaxonomy(
      [proposal("Tasarım")],
      [bookmark({ id: "b-1", title: "Figma ile tasarım sistemi kurmak" })],
      AT,
      [],
      [{ name: "web", definition: "Ön yüz işleri." }],
    );
    expect(normalizeAcceptedTaxonomy(written)).toEqual(written);
  });

  it("reads a bare array, the early shape, rather than treating it as corruption", () => {
    // The writer must not "fix" a record the reader can still make sense of:
    // refusing here would drop an accepted taxonomy on the floor the first time a
    // user ran a second proposal.
    const stored = normalizeAcceptedTaxonomy([{ id: "l1", name: "Reading", samples: ["A sample"] }]);
    expect(stored.collections.map((entry) => entry.name)).toEqual(["Reading"]);
    // An unreadable date is left null rather than invented, exactly as the
    // extension's reader left `ai.taxonomyAt` off.
    expect(stored.acceptedAt).toBeNull();
  });

  it("reads a bare-string tag, the pre-definition shape", () => {
    const stored = normalizeAcceptedTaxonomy({
      acceptedAt: AT,
      collections: [],
      tags: ["eski tag", { name: "yeni tag", definition: "Tanım." }],
    });
    // A tag stored before definitions existed keeps working, asked about by name.
    expect(stored.tags).toEqual([{ name: "eski tag" }, { name: "yeni tag", definition: "Tanım." }]);
  });

  it("survives a half-written value, and null is an empty taxonomy rather than an error", () => {
    const half = normalizeAcceptedTaxonomy({ acceptedAt: "not a date", collections: "nope", tags: 3 });
    expect(half).toEqual({ acceptedAt: null, collections: [], tags: [] });
    expect(normalizeAcceptedTaxonomy(null)).toEqual({ acceptedAt: null, collections: [], tags: [] });
    expect(normalizeAcceptedTaxonomy(undefined)).toEqual({ acceptedAt: null, collections: [], tags: [] });
    // A record written before tags existed carries none, which is a normal state.
    expect(normalizeAcceptedTaxonomy({ acceptedAt: AT, collections: [] }).tags).toEqual([]);
  });

  it("keeps a stored id, drops empty samples, and collapses a duplicate", () => {
    const stored = normalizeAcceptedTaxonomy({
      acceptedAt: AT,
      collections: [
        { id: "uuid-1", name: "Reading", samples: ["A sample", "", 3] },
        // No id: the lowercased name is the fallback, which is the key the
        // classifier matches an option by when no row backs it.
        { name: "Tasarım" },
        // The same collection twice would make the model choose between two
        // identical keys, and one of them would win for no reason.
        { name: "reading" },
      ],
    });
    expect(stored.collections).toEqual([
      { id: "uuid-1", name: "Reading", samples: ["A sample"] },
      { id: "tasarım", name: "Tasarım", samples: [] },
    ]);
  });
});

// -- creating the collections ----------------------------------------------

describe("dropTakenProposals", () => {
  it("drops a colliding proposal and leaves that collection untouched", () => {
    const existing = [list("l1", "Reading")];
    const kept = dropTakenProposals([proposal("reading"), proposal("Tasarım")], existing);

    expect(kept.map((entry) => entry.name)).toEqual(["Tasarım"]);
    // The plan builds nothing for the collision, so there is no write that could
    // rewrite the collection the user files into by hand.
    const planned = planLists([proposal("Reading"), proposal("Tasarım")], existing, AT);
    expect(planned.map((entry) => entry.name)).toEqual(["Tasarım"]);
    expect(planned.some((entry) => entry.id === "l1")).toBe(false);
  });

  it("finds a collision through the same cleanup a tag name gets", () => {
    const existing = [list("l1", "#Reading  List")];
    const kept = dropTakenProposals([proposal("reading list"), proposal("Other")], existing);

    expect(kept.map((entry) => entry.name)).toEqual(["Other"]);
  });

  it("lets a deliberately removed name be proposed again", () => {
    // The query leaves tombstones out and this is handed what it returns, so a
    // name the user removed is free — and creatable — a second time.
    expect(dropTakenProposals([proposal("Reading")], [])).toHaveLength(1);
    expect(dropTakenProposals([proposal("Reading")], [list("l1", "Reading")])).toHaveLength(0);
  });

  it("collapses two proposals that differ only in case", () => {
    expect(dropTakenProposals([proposal("Tasarım"), proposal("tasarım")], [])).toHaveLength(1);
  });
});

describe("planLists", () => {
  it("produces one valid list record per accepted proposal", () => {
    let counter = 0;
    const planned = planLists([proposal("Tasarım"), proposal("Sistem ve Altyapı")], [], AT, () => `list-${++counter}`);

    expect(planned).toEqual([
      { id: "list-1", name: "Tasarım", createdAt: AT, updatedAt: AT, deletedAt: null },
      { id: "list-2", name: "Sistem ve Altyapı", createdAt: AT, updatedAt: AT, deletedAt: null },
    ]);
    // No icon or emoji, so the dashboard falls back to its own default rather than
    // inventing a look the user never chose.
    expect(planned.every((entry) => !("icon" in entry) && !("emoji" in entry))).toBe(true);
  });

  it("gives every list a distinct id from the platform generator by default", () => {
    // Two proposals must never share one list. The default is the real generator,
    // so this only pins that the injection has a working fallback.
    const planned = planLists([proposal("Tasarım"), proposal("Sistem")], [], AT);
    expect(new Set(planned.map((entry) => entry.id)).size).toBe(2);
    for (const entry of planned) expect(entry.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
  });
});

// -- the tag vocabulary -----------------------------------------------------

describe("planTags", () => {
  it("normalises, dedupes, and drops names the library already uses", () => {
    expect(
      planTags(
        [
          { name: "  #TypeScript  ", why: "Derinlik." },
          { name: "typescript" },
          { name: "Web", why: "Ön yüz." },
          { name: "web" },
          { name: "" },
          { name: "Rust", why: "Sistem dili." },
        ],
        ["WEB"],
      ),
    ).toEqual([
      { name: "typescript", definition: "Derinlik." },
      { name: "rust", definition: "Sistem dili." },
    ]);
  });

  it("keeps a tag whose definition is missing, asked about by name alone", () => {
    // Better than dropping it: a tag with no definition is still a name the user
    // agreed to, and a bare name is what the first version asked about for every
    // tag in the library.
    expect(planTags([{ name: "web" }], [])).toEqual([{ name: "web" }]);
  });

  it("keeps a tag that echoes a collection, because a collection is exclusive and a tag is not", () => {
    // The proposer names one theme twice; only the collection is a real duplicate
    // of anything. Dropping the tag here would lose a vocabulary entry for no
    // reason — the review list is where the overlap belongs.
    expect(planTags([{ name: "açık kaynak" }], [])).toEqual([{ name: "açık kaynak" }]);
  });

  it("caps the vocabulary at what one request can actually ask about", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({ name: `tag ${index}` }));
    const planned = planTags(many, []);
    expect(planned).toHaveLength(MAX_TAXONOMY_TAGS);
    // Nothing ticked should vanish at acceptance, so an explicit limit is honoured
    // rather than rounded up to the ceiling.
    expect(planTags(many, [], 3)).toHaveLength(3);
    expect(planTags(many, [], 0)).toEqual([]);
  });

  it("survives a missing or malformed list", () => {
    expect(planTags(undefined as never, [])).toEqual([]);
    expect(planTags([{ name: "ok" }], undefined as never)).toEqual([{ name: "ok" }]);
  });
});

// -- the response -----------------------------------------------------------

describe("readProposals", () => {
  it("reads a clean body", () => {
    expect(
      readProposals({
        collections: [{ name: "Tasarım  notları", why: "Design work." }, { name: "Sistem", why: "Servers." }],
      }),
    ).toEqual([
      { name: "Tasarım notları", why: "Design work." },
      { name: "Sistem", why: "Servers." },
    ]);
  });

  it("drops a proposal with no reason rather than showing a bare name", () => {
    // The review list has nowhere to show a name with no reason, and a name with
    // no reason is the one thing a user should never be asked to accept.
    expect(
      readProposals({ collections: [{ name: "Tasarım" }, { name: "Sistem", why: "Servers." }, { why: "no name" }] }).map(
        (entry) => entry.name,
      ),
    ).toEqual(["Sistem"]);
  });

  it("proposes nothing from an unreadable body instead of throwing", () => {
    expect(readProposals(null)).toEqual([]);
    expect(readProposals("<html>")).toEqual([]);
    expect(readProposals({ collections: [null, 3, "nope"] })).toEqual([]);
    // Duplicates collapse on the same key the writer uses, so the review list
    // cannot offer the same name twice in two spellings.
    expect(readProposals({ collections: [{ name: "Tasarım", why: "a" }, { name: "tasarım", why: "b" }] })).toHaveLength(1);
  });
});

describe("readProposedTags", () => {
  const NAMES = ["Açık Kaynak Projeleri", "Etkileşimli UI Tasarımları"];

  it("keeps each tag's one-liner, which is the only evidence a member-less tag has", () => {
    expect(
      readProposedTags({ tags: [{ name: "Yazılım Geliştirme", why: "Kod yazan içerik." }, { name: "rust" }] }, []),
    ).toEqual([
      { name: "yazılım geliştirme", why: "Kod yazan içerik.", coveredBy: [] },
      { name: "rust", coveredBy: [] },
    ]);
  });

  it("names the collections in the same response that already cover the tag", () => {
    // This is the client-side comparison the server used to make the panel do. It
    // is the reason a covered tag is unticked by default and re-ticked live when
    // the matching collection is unticked: the two must not arrive fighting.
    const tags = readProposedTags({ tags: [{ name: "Açık Kaynak" }, { name: "ui tasarımı" }, { name: "güvenlik" }] }, NAMES);
    expect(tags).toEqual([
      { name: "açık kaynak", coveredBy: ["Açık Kaynak Projeleri"] },
      // Matched on a stem: "ui tasarımı" appears in "Etkileşimli UI Tasarımları"
      // only as a prefix, which is what Turkish agglutination makes of it.
      { name: "ui tasarımı", coveredBy: ["Etkileşimli UI Tasarımları"] },
      { name: "güvenlik", coveredBy: [] },
    ]);
  });

  it("reads a bare string tag, dedupes, and drops an empty name", () => {
    expect(readProposedTags({ tags: ["Web", { name: "web" }, { name: "" }, null] }, NAMES)).toEqual([
      { name: "web", coveredBy: [] },
    ]);
  });

  it("proposes nothing from an unreadable body", () => {
    expect(readProposedTags(null, NAMES)).toEqual([]);
    expect(readProposedTags({ tags: "nope" }, NAMES)).toEqual([]);
    // A missing collection list is an empty coverage set, not a crash: the
    // collection half of the response is parsed by its own function.
    expect(readProposedTags({ tags: [{ name: "web" }] }, undefined as never)).toEqual([
      { name: "web", coveredBy: [] },
    ]);
  });
});

describe("isTagCoveredByCollection", () => {
  it("matches a tag inside a collection's own words", () => {
    const names = ["Açık Kaynak Projeleri", "Etkileşimli UI Tasarımları"];
    // The proposer's own double-proposals: one theme, named twice.
    expect(isTagCoveredByCollection("açık kaynak", names)).toBe(true);
    // Matched on a stem, because "UI Tasarımları" contains "tasarımı" only as a
    // prefix — Turkish puts its endings on the stem, and an exact comparison
    // would miss nearly every real case this exists to catch.
    expect(isTagCoveredByCollection("ui tasarımı", names)).toBe(true);
    expect(isTagCoveredByCollection("tasarım", names)).toBe(true);
    // A different theme that shares no stem.
    expect(isTagCoveredByCollection("güvenlik", names)).toBe(false);
    expect(isTagCoveredByCollection("ücretsiz", names)).toBe(false);
    expect(isTagCoveredByCollection("", names)).toBe(false);
    expect(isTagCoveredByCollection("web", [])).toBe(false);
  });

  it("is generous by design, because over-covering only starts a tag unticked", () => {
    const names = ["Açık Kaynak Projeleri", "Etkileşimli UI Tasarımları"];
    // A false positive costs one click; a false negative leaves it on, which is the
    // status quo. So the threshold is deliberately loose.
    expect(isTagCoveredByCollection("ui", names)).toBe(true);
    // Two tag words cannot both match one collection word, though.
    expect(isTagCoveredByCollection("ui tasarımı", ["UI Tasarımı"])).toBe(true);
    expect(isTagCoveredByCollection("ui tasarımı", ["Tasarımı"])).toBe(false);
  });
});

describe("the caps the request sends", () => {
  it("states what it wants rather than inheriting whatever the server decides", () => {
    // MAX_SAMPLE_ITEMS on the server side is 200, which is also this sample size;
    // anything larger would look like it worked and propose from half the library.
    expect(TAXONOMY_SAMPLE_SIZE).toBe(200);
    expect([PROPOSAL_MAX_COLLECTIONS, PROPOSAL_MAX_TAGS]).toEqual([8, 20]);
  });
});
