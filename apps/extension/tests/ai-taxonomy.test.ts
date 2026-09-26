import "fake-indexeddb/auto";
import { beforeEach, expect, test } from "vitest";
import { AI_TAXONOMY_META_KEY, runClassification } from "../lib/ai-runner";
import {
  MAX_TAXONOMY_TAGS,
  PROPOSAL_MAX_COLLECTIONS,
  TAXONOMY_SAMPLE_SIZE,
  acceptProposals,
  dropTakenProposals,
  isTagCoveredByCollection,
  planLists,
  planTags,
  readStoredTaxonomy,
  requestProposals,
  selectSample,
  toAcceptedTaxonomy,
  type AcceptedTaxonomy,
  type AiTaxonomyDeps,
  type ProposalOutcome,
  type TaxonomyProposal,
} from "../lib/ai-taxonomy";
import { DEFAULT_AI_SETTINGS } from "../lib/ai-settings";
import { saveCloudSession } from "../lib/cloud-sync";
import * as NookDB from "../lib/db";
import type { Bookmark, BookmarkList } from "../lib/types";

// -- fixtures ---------------------------------------------------------------

const AT = "2026-09-26T12:00:00.000Z";

/** A title long enough to clear the sample floor on its own. */
const FILLER = "A page about something worth filing, with enough text to be a real sample entry";

function bookmark(overrides: Partial<Bookmark> & { id: string }): Bookmark {
  return { source: "web", url: "https://example.com/post", title: FILLER, ...overrides };
}

function library(count: number, make: (index: number) => Partial<Bookmark> = () => ({})): Bookmark[] {
  return Array.from({ length: count }, (_, index) => bookmark({ id: `b-${String(index).padStart(4, "0")}`, ...make(index) }));
}

function proposal(name: string, why = "Because it holds a theme your library keeps returning to."): TaxonomyProposal {
  return { name, why };
}

function list(id: string, name: string): BookmarkList {
  return { id, name };
}

function deps(overrides: Partial<AiTaxonomyDeps> = {}): AiTaxonomyDeps {
  return { session: async () => ({ token: "test-token", ownerId: "user-1" }), ...overrides };
}

// -- sampling ---------------------------------------------------------------

test("the same library always yields the same sample", () => {
  const bookmarks = library(500);
  const first = selectSample(bookmarks, 50).map((item) => item.id);
  const second = selectSample(bookmarks, 50).map((item) => item.id);

  expect(first).toEqual(second);
  expect(first).toHaveLength(50);
  expect(new Set(first).size).toBe(50);
});

test("the sample is spread across the library, not taken from the front", () => {
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

test("a sample smaller than the library is not the first N", () => {
  const bookmarks = library(100);
  const sample = selectSample(bookmarks, 10).map((item) => item.id);

  expect(sample).not.toEqual(bookmarks.slice(0, 10).map((item) => item.id));
  // Every tenth item, so the last pick is 90% of the way in — nowhere near the
  // front 10 a slice would have given.
  expect(sample).toEqual(["b-0000", "b-0010", "b-0020", "b-0030", "b-0040", "b-0050", "b-0060", "b-0070", "b-0080", "b-0090"]);
});

test("the sample order does not depend on the order the store handed back", () => {
  const bookmarks = library(60);
  const forward = selectSample(bookmarks, 10).map((item) => item.id);
  const reversed = selectSample([...bookmarks].reverse(), 10).map((item) => item.id);

  expect(reversed).toEqual(forward);
});

test("filed, already-decided and soft-deleted bookmarks are never sampled", () => {
  const bookmarks = [
    bookmark({ id: "b-filed", listId: "l1", listName: "Reading" }),
    bookmark({ id: "b-decided", ai: { model: "jev-1.13.0", at: AT } }),
    bookmark({ id: "b-deleted", deletedAt: AT }),
    bookmark({ id: "b-live" }),
  ];

  expect(selectSample(bookmarks, 10).map((item) => item.id)).toEqual(["b-live"]);
});

test("near-empty items are left out, the way the classify route leaves them out", () => {
  // 39 of the real 1,061-item library fall under the floor, and 15 of those
  // under 20 characters — media-only bookmarks that reduce to an emoji or a
  // handle. A sample full of them teaches the proposer nothing.
  const bookmarks = [
    bookmark({ id: "b-emoji", title: "🙃", url: "" }),
    bookmark({ id: "b-handle", title: "@someone", url: "https://x.com" }),
    bookmark({ id: "b-short", title: "Dark mode" }),
    bookmark({ id: "b-real", title: FILLER }),
  ];

  const sample = selectSample(bookmarks, 10).map((item) => item.id);
  expect(sample).toEqual(["b-real"]);
});

test("the floor counts the site as well as the title", () => {
  // A sample entry is {title, site}, so that is what the floor measures: the
  // question is whether there is anything to read, not how much of it is a
  // title. "Kurulum" alone is three words and teaches the proposer nothing; the
  // same title on a long host is a real, identifiable save.
  const short = [bookmark({ id: "b-1", title: "Kurulum", url: "https://ex.co" })];
  const readable = [bookmark({ id: "b-2", title: "Kurulum adımı", url: "https://www.kurulumrehberi.example.co.uk/blog" })];

  expect(selectSample(short, 10)).toEqual([]);
  expect(selectSample(readable, 10)).toHaveLength(1);
});

test("asking for more than the server accepts is clamped rather than silently truncated", () => {
  expect(selectSample(library(400), 5000)).toHaveLength(TAXONOMY_SAMPLE_SIZE);
});

test("a library with nothing eligible produces no sample", () => {
  expect(selectSample(library(10, (index) => ({ listId: `l${index}` })), 10)).toEqual([]);
  expect(selectSample([], 10)).toEqual([]);
  expect(selectSample(library(10), 0)).toEqual([]);
});

// -- the record -------------------------------------------------------------

test("a proposal colliding with an existing collection is dropped, and that list is untouched", () => {
  const existing = [list("l1", "Reading")];
  const kept = dropTakenProposals([proposal("reading"), proposal("Tasarım")], existing);

  expect(kept.map((entry) => entry.name)).toEqual(["Tasarım"]);
  // The plan builds nothing for the collision, so there is no write that could
  // rewrite the collection the user files into by hand.
  const planned = planLists([proposal("Reading"), proposal("Tasarım")], existing, AT);
  expect(planned.map((entry) => entry.name)).toEqual(["Tasarım"]);
  expect(planned.some((entry) => entry.id === "l1")).toBe(false);
});

test("a collision is found through the same cleanup a tag name gets", () => {
  const existing = [list("l1", "#Reading  List")];
  const kept = dropTakenProposals([proposal("reading list"), proposal("Other")], existing);

  expect(kept.map((entry) => entry.name)).toEqual(["Other"]);
});

test("a soft-deleted collection does not block the name again", () => {
  // getAllLists() leaves tombstones out, and this filter is handed what it
  // returns, so a name the user deliberately removed can be proposed — and
  // created — a second time.
  const live: BookmarkList[] = [];
  expect(dropTakenProposals([proposal("Reading")], live)).toHaveLength(1);
  expect(dropTakenProposals([proposal("Reading")], [list("l1", "Reading")])).toHaveLength(0);
});

test("two proposals that differ only in case collapse to one", () => {
  expect(dropTakenProposals([proposal("Tasarım"), proposal("tasarım")], [])).toHaveLength(1);
});

test("planLists produces a valid BookmarkList per accepted proposal", () => {
  const planned = planLists([proposal("Tasarım"), proposal("Sistem ve Altyapı")], [], AT);

  expect(planned).toHaveLength(2);
  for (const entry of planned) {
    expect(typeof entry.id).toBe("string");
    expect(entry.id).not.toBe("");
    expect(entry.createdAt).toBe(AT);
    expect(entry.updatedAt).toBe(AT);
    expect(entry.deletedAt).toBeNull();
  }
  // Fresh ids: two proposals must never share one list.
  expect(new Set(planned.map((entry) => entry.id)).size).toBe(2);
});

test("the record names every accepted collection and dates the acceptance", () => {
  const taxonomy = toAcceptedTaxonomy([proposal("Tasarım")], library(3), AT);

  expect(taxonomy.acceptedAt).toBe(AT);
  expect(taxonomy.collections).toHaveLength(1);
  expect(taxonomy.collections[0]?.name).toBe("Tasarım");
  expect(taxonomy.collections[0]?.id).toBe("tasarım");
});

test("a collection's samples are the sample items that actually talk about it", () => {
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

test("a collection nothing in the sample shares a word with gets no digest", () => {
  const taxonomy = toAcceptedTaxonomy([proposal("Yapay Zeka")], [bookmark({ id: "b-1", title: FILLER })], AT);

  // Name-only is the honest state for a brand-new empty collection, and the
  // runner already offers one (see its buildCollectionOptions).
  expect(taxonomy.collections[0]?.samples).toEqual([]);
});

test("matching ignores diacritics, because the library this was measured on is Turkish", () => {
  const samples = [
    bookmark({ id: "b-1", title: "Ücretsiz bir Türkçe kaynak listesi" }),
    bookmark({ id: "b-2", title: "A paid English newsletter roundup" }),
  ];

  const taxonomy = toAcceptedTaxonomy([proposal("Ucretsiz Turkce")], samples, AT);

  expect(taxonomy.collections[0]?.samples).toEqual(["Ücretsiz bir Türkçe kaynak listesi"]);
});

test("a digest is capped, so one very long sample cannot fill the record", () => {
  const samples = Array.from({ length: 9 }, (_, index) =>
    bookmark({ id: `b-${index}`, title: `Tasarım çalışması ${index}` }),
  );

  const taxonomy = toAcceptedTaxonomy([proposal("Tasarım")], samples, AT);

  // The runner trims to AI_COLLECTION_SAMPLES on every read, so carrying more
  // than that only grows a meta record read on every tick.
  expect(taxonomy.collections[0]?.samples).toHaveLength(5);
});

test("every accepted collection gets its own digest, never a shared one", () => {
  const samples = library(4, (index) => ({ title: `Tasarım notları ${index}` }));
  const taxonomy = toAcceptedTaxonomy([proposal("Tasarım"), proposal("Sistem")], samples, AT);

  expect(taxonomy.collections[0]?.samples).toHaveLength(4);
  expect(taxonomy.collections[1]?.samples).toEqual([]);
});

test("a second acceptance keeps the collections accepted by the first", () => {
  const first = toAcceptedTaxonomy([proposal("Tasarım")], library(2), AT);
  const second = toAcceptedTaxonomy([proposal("Sistem")], library(2), "2026-10-01T00:00:00.000Z", first.collections);

  expect(second.collections.map((entry) => entry.name)).toEqual(["Tasarım", "Sistem"]);
  expect(second.collections[0]?.samples).toEqual(first.collections[0]?.samples);
  expect(second.acceptedAt).toBe("2026-10-01T00:00:00.000Z");
});

test("a re-proposed name replaces its earlier entry rather than duplicating it", () => {
  const first = toAcceptedTaxonomy([proposal("Tasarım")], library(2), AT);
  const second = toAcceptedTaxonomy([proposal("tasarım")], library(2), AT, first.collections);

  expect(second.collections).toHaveLength(1);
  expect(second.collections[0]?.name).toBe("tasarım");
});

// -- persistence ------------------------------------------------------------

beforeEach(async () => {
  NookDB._resetForTests();
  await NookDB.ready();
  await saveCloudSession("test-token", "user-1");
  await NookDB.setMeta("ai.settings", { ...DEFAULT_AI_SETTINGS, autoTaxonomy: true });
});

test("accepting creates the lists and writes ai.taxonomy", async () => {
  const samples = library(3, (index) => ({ title: `Tasarım çalışması ${index}` }));

  const result = await acceptProposals({ proposals: [proposal("Tasarım")], samples, existing: [] }, AT);

  const stored = await NookDB.getAllLists();
  expect(stored.map((entry) => entry.name)).toEqual(["Tasarım"]);
  expect(result.created).toHaveLength(1);
  expect(result.dropped).toEqual([]);
  // The list on disk is the one the record points at, by name.
  const record = (await NookDB.getMeta<AcceptedTaxonomy>(AI_TAXONOMY_META_KEY)) as AcceptedTaxonomy;
  expect(record.collections[0]?.name).toBe("Tasarım");
  expect(stored.some((entry) => entry.name === record.collections[0]?.name)).toBe(true);
});

test("the written record is the shape readTaxonomy() in ai-runner.ts reads", async () => {
  // readTaxonomy() is module-private in ai-runner.ts (that module is a consumer,
  // not a client of this one), so the contract is asserted against the same
  // library the runner actually consumes: an object with a `collections` array
  // of `{ id, name, samples }`, and an `acceptedAt` it can Date.parse. Anything
  // else and the runner degrades to "no extra sample titles" silently.
  await acceptProposals({ proposals: [proposal("Tasarım")], samples: library(3), existing: [] }, AT);

  const raw = await NookDB.getMeta<Record<string, unknown>>(AI_TAXONOMY_META_KEY);

  expect(Array.isArray(raw)).toBe(false);
  expect(Array.isArray(raw?.collections)).toBe(true);
  expect(Number.isNaN(Date.parse(String(raw?.acceptedAt)))).toBe(false);
  const option = (raw?.collections as Array<Record<string, unknown>>)[0] ?? {};
  expect(typeof option.id).toBe("string");
  expect(typeof option.name).toBe("string");
  expect(Array.isArray(option.samples)).toBe(true);
  for (const sample of option.samples as unknown[]) expect(typeof sample).toBe("string");
  // readTaxonomy() keys options on the lowercased name, so the two must agree.
  expect(String(option.id)).toBe(String(option.name).toLowerCase());
});

test("the runner reads the record back and offers the new collection by its samples", async () => {
  // The real end-to-end round trip, through the only consumer there is: accept a
  // proposal, then let runClassification() build its `Choice` options. If the
  // record were the wrong shape, `readTaxonomy()` would return no samples and
  // the new collection would go out as a bare name — a silent downgrade to the
  // 66.7%-top-1 "names only" arm rather than a failure.
  const samples = [bookmark({ id: "b-1", title: "Figma ile tasarım sistemi kurmak" })];
  await acceptProposals({ proposals: [proposal("Tasarım")], samples, existing: [] }, AT);
  await NookDB.setMeta("ai.settings", { ...DEFAULT_AI_SETTINGS, autoClassify: true });
  await NookDB.putBookmark(bookmark({ id: "b-2", title: "CSS container queries rehberi" }));

  const requests: Array<{ collections: Array<{ id: string; name: string; samples: string[] }> }> = [];
  const [list] = await NookDB.getAllLists();
  await runClassification({
    fetch: async (_url, init) => {
      requests.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          collection: { assign: true, id: list?.id, name: "Tasarım", confidence: 0.9, probabilities: {} },
          tags: [],
        }),
        { status: 200 },
      );
    },
  });

  expect(requests).toHaveLength(1);
  expect(requests[0]?.collections).toEqual([
    // Keyed on the list the acceptance created, with the evidence attached by
    // name — which is how the runner finds an option whose id is not a list id.
    { id: list?.id, name: "Tasarım", samples: ["Figma ile tasarım sistemi kurmak"] },
  ]);
  // And the accepted date is the one stamped at acceptance, not the run's time.
  const attribution = (await NookDB.getBookmark("b-2"))?.ai as { taxonomyAt?: string } | undefined;
  expect(attribution?.taxonomyAt).toBe(AT);
});

test("a collision is dropped from the write as well as from the plan", async () => {
  await NookDB.putList({ id: "l1", name: "Reading" });

  const result = await acceptProposals(
    { proposals: [proposal("Reading"), proposal("Tasarım")], samples: library(2), existing: await NookDB.getAllLists() },
    AT,
  );

  expect(result.created.map((entry) => entry.name)).toEqual(["Tasarım"]);
  expect(result.dropped).toEqual(["Reading"]);
  const lists = await NookDB.getAllLists();
  expect(lists).toHaveLength(2);
  // The pre-existing list is byte-for-byte what it was, minus the write stamp
  // NookDB applies to every row.
  const original = lists.find((entry) => entry.id === "l1");
  expect(original?.name).toBe("Reading");
  expect(original?.createdAt).toBeUndefined();
});

test("re-accepting merges into the record already on disk", async () => {
  await acceptProposals({ proposals: [proposal("Tasarım")], samples: library(2), existing: [] }, AT);
  await acceptProposals({ proposals: [proposal("Sistem")], samples: library(2), existing: await NookDB.getAllLists() }, AT);

  const record = await readStoredTaxonomy();
  expect(record.collections.map((entry) => entry.name)).toEqual(["Tasarım", "Sistem"]);
});

test("a record written by an older build is read back, not treated as corruption", async () => {
  // The runner tolerates a bare array as well as the wrapped object, so the
  // writer has to: refusing here would drop an accepted taxonomy on the floor
  // the first time a user ran a second proposal.
  await NookDB.setMeta(AI_TAXONOMY_META_KEY, [{ id: "l1", name: "Reading", samples: ["A sample"] }]);

  const before = await readStoredTaxonomy();
  expect(before.collections.map((entry) => entry.name)).toEqual(["Reading"]);
  // An unreadable date is left off rather than invented, exactly as the runner
  // leaves `ai.taxonomyAt` off.
  expect(before.acceptedAt).toBeUndefined();

  await acceptProposals({ proposals: [proposal("Tasarım")], samples: library(2), existing: [] }, AT);

  const after = await readStoredTaxonomy();
  expect(after.collections.map((entry) => entry.name)).toEqual(["Reading", "Tasarım"]);
  expect(after.acceptedAt).toBe(AT);
});

// -- the call ---------------------------------------------------------------

/** One unfiled, text-bearing bookmark, so a request is possible at all. */
async function seedEligible(): Promise<void> {
  await NookDB.putBookmark(bookmark({ id: "b-seed", title: FILLER }));
}

/** A server that answers one proposal, and records what it was asked. */
function proposer(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, fetch };
}

test("a proposal posts the sample, the existing names and the caps", async () => {
  await NookDB.putList({ id: "l1", name: "Reading" });
  await seedEligible();
  await NookDB.putBookmark(bookmark({ id: "b-1", title: "Tasarım notları ve CSS grid rehberi" }));
  const server = proposer({ collections: [{ name: "Tasarım", why: "Design work." }], tags: [] });

  const outcome = await requestProposals(deps({ fetch: server.fetch, apiUrl: "https://api.example.com" }));

  expect(server.calls).toHaveLength(1);
  expect(server.calls[0]?.url).toBe("https://api.example.com/api/ai/propose-taxonomy");
  expect((server.calls[0]?.init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
  const body = JSON.parse(String(server.calls[0]?.init.body)) as {
    sample: Array<{ title: string; site: string }>;
    existingCollections: string[];
    maxCollections: number;
    maxTags: number;
  };
  // Both unfiled bookmarks, in id order — the sample is deterministic, so the
  // order the model sees them in is the order it saw last time.
  expect(body.sample).toEqual([
    { title: "Tasarım notları ve CSS grid rehberi", site: "example.com" },
    { title: FILLER, site: "example.com" },
  ]);
  expect(body.existingCollections).toEqual(["Reading"]);
  expect(body.maxCollections).toBe(PROPOSAL_MAX_COLLECTIONS);
  expect(outcome.kind).toBe("proposals");
});

test("a signed-out host is reported as signed out, without a request", async () => {
  const server = proposer({ collections: [] });

  const outcome = await requestProposals(deps({ session: async () => null, fetch: server.fetch }));

  expect(outcome).toEqual({ kind: "signed-out" });
  expect(server.calls).toHaveLength(0);
});

test("a 401 mid-request is the same state as no session at all", async () => {
  await seedEligible();
  const server = proposer({}, 401);

  expect((await requestProposals(deps({ fetch: server.fetch }))).kind).toBe("signed-out");
});

test("a 503 is reported as unconfigured, not as a generic failure", async () => {
  await seedEligible();
  const server = proposer({ error: "AI classification is not configured" }, 503);

  expect((await requestProposals(deps({ fetch: server.fetch }))).kind).toBe("unavailable");
});

test.each([429, 529])("%i is reported as throttled", async (status) => {
  await seedEligible();
  const server = proposer({}, status);

  expect((await requestProposals(deps({ fetch: server.fetch }))).kind).toBe("throttled");
});

test("an unreachable server is a failure, and the only state a retry fixes", async () => {
  await seedEligible();
  const throwing: AiTaxonomyDeps["fetch"] = async () => {
    throw new TypeError("Failed to fetch");
  };

  const outcome = await requestProposals(deps({ fetch: throwing }));

  expect(outcome.kind).toBe("failed");
  expect(outcome.kind === "failed" ? outcome.message : "").toMatch(/could not reach/i);
});

test("an empty proposal list is a valid answer, not a failure", async () => {
  await NookDB.putBookmark(bookmark({ id: "b-1" }));
  const server = proposer({ collections: [], tags: [] });

  const outcome = await requestProposals(deps({ fetch: server.fetch }));

  expect(outcome.kind).toBe("proposals");
  expect(outcome.kind === "proposals" ? outcome.proposals : null).toEqual([]);
});

test("an unreadable body proposes nothing rather than throwing", async () => {
  await NookDB.putBookmark(bookmark({ id: "b-1" }));
  const garbage: AiTaxonomyDeps["fetch"] = async () => new Response("<html>", { status: 200 });

  const outcome: ProposalOutcome = await requestProposals(deps({ fetch: garbage }));

  expect(outcome.kind).toBe("proposals");
  expect(outcome.kind === "proposals" ? outcome.proposals : null).toEqual([]);
});

test("a proposal with no reason is dropped rather than shown as a bare name", async () => {
  await NookDB.putBookmark(bookmark({ id: "b-1" }));
  const server = proposer({ collections: [{ name: "Tasarım" }, { name: "Sistem", why: "Servers." }] });

  const outcome = await requestProposals(deps({ fetch: server.fetch }));

  expect(outcome.kind === "proposals" ? outcome.proposals.map((entry) => entry.name) : []).toEqual(["Sistem"]);
});

test("a library with nothing unfiled makes no request at all", async () => {
  await NookDB.putBookmark(bookmark({ id: "b-1", listId: "l1" }));
  const server = proposer({ collections: [{ name: "Tasarım", why: "Design." }] });

  const outcome = await requestProposals(deps({ fetch: server.fetch }));

  expect(outcome).toEqual({ kind: "nothing-to-read" });
  expect(server.calls).toHaveLength(0);
});

// -- the tag vocabulary -----------------------------------------------------

test("planTags normalises, dedupes, and drops names the library already uses", () => {
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

test("planTags keeps a tag whose definition is missing, asked about by name alone", () => {
  // Better than dropping it: a tag with no definition is still a name the user
  // agreed to, and a bare name is what the first version asked about for every
  // tag in the library.
  expect(planTags([{ name: "web" }], [])).toEqual([{ name: "web" }]);
});

test("planTags caps the vocabulary at what one request can actually ask about", () => {
  const many = Array.from({ length: 40 }, (_, i) => ({ name: `tag ${i}` }));
  const planned = planTags(many, []);
  expect(planned).toHaveLength(MAX_TAXONOMY_TAGS);
  // Exactly the ask budget, not less. It used to be 12, on the theory that a
  // smaller vocabulary would leave room for the library's own tags — but
  // buildTagOptions already puts those first and slices, so they were never
  // crowded out, and 12 meant that ticking 13 of the 20 tags the proposer
  // offered silently discarded one. Nothing the user ticks should vanish here.
  expect(MAX_TAXONOMY_TAGS).toBe(20);
});

test("planTags survives a missing or malformed list", () => {
  expect(planTags(undefined as never, [])).toEqual([]);
  expect(planTags([{ name: "ok" }], undefined as never)).toEqual([{ name: "ok" }]);
});

test("toAcceptedTaxonomy carries an earlier vocabulary forward instead of replacing it", () => {
  const first = toAcceptedTaxonomy([], [], "2026-01-01T00:00:00.000Z", [], [{ name: "tasarım" }]);
  const second = toAcceptedTaxonomy([], [], "2026-02-01T00:00:00.000Z", [], [{ name: "geliştirme" }], first.tags);
  // Same discipline as the collections: a run today must not empty one from
  // last spring, or every tag would lose its first chance at a member.
  expect(second.tags).toEqual([{ name: "tasarım" }, { name: "geliştirme" }]);
  expect(second.acceptedAt).toBe("2026-02-01T00:00:00.000Z");
});

test("toAcceptedTaxonomy normalises what it stores and never repeats a name", () => {
  const record = toAcceptedTaxonomy(
    [],
    [],
    "2026-01-01T00:00:00.000Z",
    [],
    [{ name: "#Tasarım" }, { name: "tasarım" }, { name: "  Tasarım  " }, { name: "UX", definition: "Arayüz." }],
  );
  expect(record.tags).toEqual([{ name: "tasarım" }, { name: "ux", definition: "Arayüz." }]);
});

test("a record written before tags existed reads back with none, not as broken", async () => {
  NookDB._resetForTests();
  await NookDB.setMeta(AI_TAXONOMY_META_KEY, { acceptedAt: "2026-01-01T00:00:00.000Z", collections: [] });
  expect((await readStoredTaxonomy()).tags).toEqual([]);
});

test("acceptProposals stores the ticked tags with their definitions, and reports which were new", async () => {
  NookDB._resetForTests();
  const result = await acceptProposals({
    proposals: [],
    samples: [],
    existing: [],
    tags: [{ name: "Tasarım", why: "Tasarım sistemleri." }, { name: "ücretsiz", why: "Ücretsiz araçlar." }],
    existingTags: ["tasarım"],
  });
  // "tasarım" is already in use, so it is not news; only "ücretsiz" is.
  expect(result.addedTags).toEqual(["ücretsiz"]);
  // The definition is the whole reason a member-less tag is askable, so it has
  // to survive acceptance, not just the review list.
  expect((await readStoredTaxonomy()).tags).toEqual([{ name: "ücretsiz", definition: "Ücretsiz araçlar." }]);
});

test("a vocabulary stored before definitions existed still reads", async () => {
  NookDB._resetForTests();
  await NookDB.setMeta(AI_TAXONOMY_META_KEY, {
    acceptedAt: "2026-01-01T00:00:00.000Z",
    collections: [],
    tags: ["eski tag", { name: "yeni tag", definition: "Tanım." }],
  });
  expect((await readStoredTaxonomy()).tags).toEqual([{ name: "eski tag" }, { name: "yeni tag", definition: "Tanım." }]);
});

test("isTagCoveredByCollection matches a tag inside a collection's own words", () => {
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
  // Over-generous is the safe direction: it only starts a tag unticked.
  expect(isTagCoveredByCollection("ui", names)).toBe(true);
});
