// No network, no database and no API key: the pure half is exercised directly
// and the impure half runs against a hand-rolled Pool and an injected `fetch`.
// The cases that will actually occur are the ones pinned here — a Turkish
// "Bu bir özet:" preamble, a fenced or bulleted answer, an X post whose
// `description` *is* the 180-character truncation — because those are what the
// prompt fights and what `cleanSummary` has to finish off.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import {
  SUMMARY_SYSTEM_PROMPT,
  UNAVAILABLE_MODEL,
  buildSummaryPrompt,
  cleanSummary,
  isWorthSummarising,
  planSummaries,
  summarizeAvailability,
  summarizeRecords,
  summarySkipReason,
  type SummaryRecord,
} from "../src/summarize.js";

// -- fixtures --

/** A real X post, and longer than 180 characters so the slice below is a real
 *  truncation. The extension stores the tweet text as `description` *and* as
 *  `shortDescription`, both sliced at 180 (lib/x-parser.ts), so this is the
 *  shape most of a real library has. */
const TURKISH_TWEET =
  "Veritabanı indeksleme davranışlarını incelerken VACUUM'in neden yavaşladığını anlamak istedim; " +
  "PostgreSQL'in autovacuum ayarlarının buna nasıl etki ettiğini de öğrenmek istiyorum, yoksa yavaşlık kalıcı mı.";

/** Exactly the truncation, so "the description IS the preview" is a fact about
 *  the fixture rather than an assumption. */
const TRUNCATED = TURKISH_TWEET.slice(0, 180);

/** A page capture, built the way lib/page-capture.ts builds one: the full
 *  article, of which the library row shows the first 180 characters. */
const ARTICLE =
  TURKISH_TWEET +
  " Yazının devamında çok kolonlu indekslerde arama planlarının neden bozulduğu ölçülüyor, istatistik " +
  "hedeflerinin ne sıklıkla yükseltilmesi gerektiği hesaplanıyor ve üretimde kademeli bir geçiş öneriliyor.";

function record(overrides: Record<string, unknown> = {}, id = "b1"): SummaryRecord {
  return { id, data: { id, ...overrides } };
}

/** A record the gate would really accept, so "skipped" is proven by the gate and
 *  not by a fixture that was too short all along. */
function articleRecord(id = "b1", overrides: Record<string, unknown> = {}): SummaryRecord {
  return record({ title: "Çok kolonlu indekslerde arama planları", description: ARTICLE, ...overrides }, id);
}

/** Stands in for a `pg` Pool: returns canned rows and records every statement, so
 *  a test can assert what did and did not reach the database. */
function fakePool(rows: Array<{ id: string; data?: Record<string, unknown>; deleted_at?: string | null }>): Pool & {
  statements: Array<{ sql: string; values: unknown[] }>;
} {
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  return {
    statements,
    query: async (sql: string, values: unknown[] = []) => {
      statements.push({ sql, values });
      return {
        rows: rows.map((row) => ({ id: row.id, data: row.data ?? {}, deleted_at: row.deleted_at ?? null })),
        rowCount: rows.length,
        command: "SELECT",
        fields: [],
        oid: 0,
      };
    },
  } as unknown as Pool & { statements: Array<{ sql: string; values: unknown[] }> };
}

/** A chat-completions reply, which is the shape both a label-stripping test and
 *  a clean one need. */
function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/** A proposer that is configured but does nothing, so no test can reach the
 *  network by accident. Returns the call count and a setter for the answer. */
function stubProposer(answer: string | (() => Response | Promise<Response>)) {
  const state = { calls: 0, bodies: [] as string[] };
  const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
    state.calls++;
    state.bodies.push(String(init.body ?? ""));
    return typeof answer === "function" ? await answer() : completion(answer);
  });
  return { state, fetch: fetchStub, sleep: async () => {} };
}

function configureOpenAI(): void {
  process.env.NOOK_AI_PROPOSER = "openai";
  process.env.OPENAI_API_KEY = "test-key";
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NOOK_AI_PROPOSER;
  delete process.env.OPENAI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  delete process.env.NOOK_AI_MODEL;
  delete process.env.NOOK_SUMMARY_MODEL;
});

// -- isWorthSummarising --

describe("isWorthSummarising", () => {
  it("rejects the X-post shape, where the description IS the 180-character preview", () => {
    expect(TRUNCATED).toHaveLength(180);
    const tweet = record({ title: "vdb", shortDescription: TRUNCATED, description: TRUNCATED });
    // The whole point of the gate: a summary here is the same 180 characters the
    // library row already shows, paid for a second time.
    expect(isWorthSummarising(tweet)).toBe(false);
  });

  it("accepts a page capture whose full description runs well past the truncation", () => {
    expect(ARTICLE.length).toBeGreaterThan(400);
    // The relationship the gate is built on, stated as a fact about the
    // fixture: a capture's `shortDescription` is its `description` sliced.
    expect(ARTICLE.startsWith(TRUNCATED)).toBe(true);
    const capture = record({ title: "Planlar", shortDescription: TRUNCATED, description: ARTICLE });
    expect(isWorthSummarising(capture)).toBe(true);
  });

  it("cuts at 400 characters, and says so in one place", () => {
    // Documented as a judgement about unseen text rather than a measured number,
    // so the boundary is pinned here: at exactly the gate the description is
    // still mostly preview, and one more character is enough to summarise.
    expect(isWorthSummarising(record({ description: "a".repeat(400) }))).toBe(false);
    expect(isWorthSummarising(record({ description: "a".repeat(401) }))).toBe(true);
  });

  it("rejects a record with no description, rather than falling back to the preview", () => {
    expect(isWorthSummarising(record({ shortDescription: ARTICLE }))).toBe(false);
    expect(isWorthSummarising(record({ description: "" }))).toBe(false);
    expect(isWorthSummarising(record({ description: "   \n " }))).toBe(false);
    expect(isWorthSummarising(record({ description: 42 as unknown as string }))).toBe(false);
  });

  it("ignores the summary it may already be carrying", () => {
    // Being summarised is not a reason to be worth summarising; the caller asks
    // that question separately, and conflating the two would skip every record
    // that already has one forever.
    expect(isWorthSummarising(articleRecord("b1", { summary: "Var olan bir özet." }))).toBe(true);
  });
});

// -- cleanSummary --

describe("cleanSummary", () => {
  it("strips the Turkish preamble the prompt is written to fight", () => {
    expect(cleanSummary("Bu bir özet: Veritabanı indeksleri çok kolonlu tablolarda yavaşlar.")).toBe(
      "Veritabanı indeksleri çok kolonlu tablolarda yavaşlar.",
    );
  });

  it("strips the English equivalent, and a double-labelled answer", () => {
    expect(cleanSummary("Summary: Search plans degrade as the table grows.")).toBe("Search plans degrade as the table grows.");
    expect(cleanSummary("Özet: Summary: Search plans degrade.")).toBe("Search plans degrade.");
    expect(cleanSummary("TL;DR: Search plans degrade.")).toBe("Search plans degrade.");
  });

  it("leaves a sentence that merely starts with a label word", () => {
    // "Özetlemekte fayda var" opens with the same letters and no separator, and
    // decapitating it would leave the user with "lemekte fayda var".
    expect(cleanSummary("Özetlemekte fayda var: planlar bozuluyor.")).toBe("Özetlemekte fayda var: planlar bozuluyor.");
    expect(cleanSummary("In short, the plan gets worse.")).toBe("In short, the plan gets worse.");
  });

  it("strips quotes the model wrapped the whole answer in", () => {
    expect(cleanSummary('"Search plans degrade as the table grows."')).toBe("Search plans degrade as the table grows.");
    expect(cleanSummary("«Search plans degrade as the table grows.»")).toBe("Search plans degrade as the table grows.");
    expect(cleanSummary("“Search plans degrade.”")).toBe("Search plans degrade.");
  });

  it("strips a code fence, which is what a model does when told 'no markdown'", () => {
    expect(cleanSummary("```\nSearch plans degrade as the table grows.\n```")).toBe(
      "Search plans degrade as the table grows.",
    );
  });

  it("strips bullets and headings, and collapses the list into one line", () => {
    expect(cleanSummary("- Planlar bozuluyor.\n- Planlar yeniden kurulmalı.")).toBe(
      "Planlar bozuluyor. Planlar yeniden kurulmalı.",
    );
    // The heading form needs the "#" gone before the line reads as a bare
    // label, which is why this is a second pass rather than a second pattern.
    expect(cleanSummary("## Özet\nPlanlar bozuluyor.")).toBe("Planlar bozuluyor.");
    expect(cleanSummary("Summary\nPlanlar bozuluyor.")).toBe("Planlar bozuluyor.");
  });

  it("strips emphasis without eating interior punctuation", () => {
    expect(cleanSummary("**Önemli** bir bulgu var.")).toBe("Önemli bir bulgu var.");
    expect(cleanSummary("Planlar *gerçekten* bozuluyor.")).toBe("Planlar gerçekten bozuluyor.");
    expect(cleanSummary("__Önemli__ bir bulgu.")).toBe("Önemli bir bulgu.");
    // A summary is prose, and over-eager stripping is its own bug: a table name,
    // a flag and a multiplication are all things a sentence can contain.
    expect(cleanSummary("search_plan_timeout süresi 2 * 3 saniyedir.")).toBe(
      "search_plan_timeout süresi 2 * 3 saniyedir.",
    );
  });

  it("strips a label that only appears once the markdown around it is gone", () => {
    expect(cleanSummary("**Özet:** Planlar bozuluyor.")).toBe("Planlar bozuluyor.");
  });

  it("returns nothing usable as an empty string", () => {
    // Every one of these is a real way a model can answer "summarise this", and
    // storing any of them would put the decoration on a bookmark in the library.
    for (const raw of ["", "   ", "\n\n", "***", "---", "—", "Özet:", "Summary:", "###", "```\n```", "..."]) {
      expect(cleanSummary(raw)).toBe("");
    }
    expect(cleanSummary(undefined)).toBe("");
    expect(cleanSummary(null)).toBe("");
    expect(cleanSummary(42)).toBe("");
    expect(cleanSummary({ content: "nope" })).toBe("");
  });

  it("caps the length, cutting at a sentence end where it can", () => {
    const twoSentences = `${"Planlar bozuluyor. ".repeat(30)}Son cümle önemli.`;
    expect(twoSentences.length).toBeGreaterThan(400);
    const capped = cleanSummary(twoSentences);
    expect(capped.length).toBeLessThanOrEqual(400);
    // A cut between sentences leaves text that is still true, so no ellipsis.
    expect(capped.endsWith(".")).toBe(true);
    expect(capped).not.toContain("…");
  });

  it("caps mid-sentence with an ellipsis, which is the honest version of the same cut", () => {
    const oneSentence = "Planlar ".repeat(200);
    const capped = cleanSummary(oneSentence);
    expect(capped.length).toBeLessThanOrEqual(400);
    expect(capped.endsWith("…")).toBe(true);
    // A word boundary, not a character count: "Planlar Pla…" reads as a bug.
    expect(capped[capped.length - 2]).not.toBe(" ");
  });

  it("leaves a summary already inside the cap untouched", () => {
    const already = "PostgreSQL çok kolonlu indekslerde arama planları tablo büyüdükçe bozuluyor.";
    expect(cleanSummary(`  ${already}  `)).toBe(already);
    expect(cleanSummary(`Özet: ${already}`)).toBe(already);
  });
});

// -- buildSummaryPrompt --

describe("buildSummaryPrompt", () => {
  it("asks for the content's own language, and names no language at all", () => {
    const prompt = buildSummaryPrompt(articleRecord());
    expect(prompt.system).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(prompt.system).toMatch(/same language as the text you were given/i);
    // The naming language is a different question and a different setting
    // (`taxonomyLanguage`), so the summary prompt must carry no language in it.
    // Naming one here is how a Turkish page ends up summarised in English, which
    // is the exact failure the doc calls out under "Summaries".
    for (const language of ["Turkish", "Türkçe", "English", "German", "French", "Spanish"]) {
      expect(prompt.system).not.toContain(language);
    }
  });

  it("forbids the three things that make a summary look broken", () => {
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/one or two sentences of plain text/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/no markdown/i);
    expect(SUMMARY_SYSTEM_PROMPT).toMatch(/bu bir özet/i);
  });

  it("caps the text it inlines, so a whole article cannot ride into one request", () => {
    const enormous = record({ title: "Bir yazı", description: "c".repeat(40_000) });
    const prompt = buildSummaryPrompt(enormous);
    // Bounded rather than exact: the point is that 40,000 characters do not
    // become a 40,000-character request.
    expect(prompt.user.length).toBeLessThan(5_000);
    expect(prompt.user).toContain("…");
    expect(prompt.user).toContain("Bir yazı");
  });

  it("sends the description as the text to summarise, and the note as its own labelled line", () => {
    const prompt = buildSummaryPrompt(
      articleRecord("b1", { note: "sunum için" }),
    );
    expect(prompt.user).toContain("Title: Çok kolonlu indekslerde arama planları");
    expect(prompt.user).toContain("Text:");
    expect(prompt.user).toContain(ARTICLE.slice(0, 200));
    // A note is the user's reason for saving, not the content. Labelled, so the
    // model can tell them apart, and never the body of the request.
    expect(prompt.user).toContain("Saved with this note: sunum için");
  });

  it("still produces a body for a record the gate would have rejected", () => {
    // Unreachable through `summarizeRecords`, but the function is exported and
    // a prompt asking the model to summarise nothing is worse than a fallback.
    // `trimEnd` because the 180-character slice lands on a space, and the
    // prompt builder trims its inputs.
    const prompt = buildSummaryPrompt(record({ shortDescription: TRUNCATED }));
    expect(prompt.user).toContain(TRUNCATED.trimEnd());
  });
});

// -- planSummaries --

describe("planSummaries", () => {
  it("keeps only the records the gate accepts", () => {
    const ids = planSummaries([articleRecord("a"), articleRecord("b")]);
    expect(ids).toEqual(["a", "b"]);
  });

  it("skips what already has a summary, whether the record says so or the caller does", () => {
    const stored = articleRecord("a", { summary: "Planlar bozuluyor." });
    const fromCaller = articleRecord("b");
    expect(planSummaries([stored])).toEqual([]);
    expect(planSummaries([fromCaller], new Set(["b"]))).toEqual([]);
    // `""` and `null` are not a summary: a cleared one should be written again
    // rather than merged as a permanent blank.
    expect(planSummaries([articleRecord("c", { summary: "" })])).toEqual(["c"]);
    expect(planSummaries([articleRecord("d", { summary: null })])).toEqual(["d"]);
  });

  it("skips a record the gate rejects", () => {
    const ids = planSummaries([record({ description: TRUNCATED }, "tweet"), record({ title: "medya" }, "bare")]);
    expect(ids).toEqual([]);
  });

  it("never includes a soft-deleted record, by either signal", () => {
    // A tombstone is readable from the column and from inside the data, and one
    // caller seeing it as deleted is exactly how a summary gets written for
    // something the user deleted.
    const byColumn = { ...articleRecord("a"), deletedAt: "2026-09-01T00:00:00.000Z" };
    const byData = articleRecord("b", { deletedAt: "2026-09-01T00:00:00.000Z" });
    expect(planSummaries([byColumn, byData])).toEqual([]);
    expect(summarySkipReason(byColumn)).toBe("deleted");
    expect(summarySkipReason(byData)).toBe("deleted");
  });

  it("ignores junk rather than throwing, and does not repeat an id", () => {
    const ids = planSummaries([
      articleRecord("a"),
      articleRecord("a"),
      { id: "", data: {} },
      null as unknown as SummaryRecord,
      { data: {} } as unknown as SummaryRecord,
      articleRecord("b"),
    ]);
    expect(ids).toEqual(["a", "b"]);
  });

  it("explains every exclusion with a machine-readable reason", () => {
    // A reason the client cannot compare against is not a reason, it is a
    // sentence — so these are the values it branches on, not prose.
    expect(summarySkipReason(articleRecord("a"))).toBeNull();
    expect(summarySkipReason(articleRecord("a", { summary: "x" }))).toBe("already-summarised");
    expect(summarySkipReason(record({ description: TRUNCATED }, "t"))).toBe("too-short");
    expect(summarySkipReason({ ...articleRecord("d"), deletedAt: "2026-09-01T00:00:00.000Z" })).toBe("deleted");
  });
});

// -- summarizeAvailability --

describe("summarizeAvailability", () => {
  it("reports unconfigured rather than throwing, which is the state a fresh deploy is in", () => {
    const availability = summarizeAvailability();
    expect(availability.summarize).toBe(false);
    expect(availability.proposer).toBeNull();
  });

  it("reports the model docs/retrieval.md's configuration table specifies", () => {
    configureOpenAI();
    expect(summarizeAvailability()).toEqual({ proposer: "openai", summarize: true, model: "gpt-4o-mini" });

    process.env.NOOK_AI_MODEL = "gpt-5-nano";
    expect(summarizeAvailability().model).toBe("gpt-5-nano");

    process.env.NOOK_SUMMARY_MODEL = "gpt-4o";
    expect(summarizeAvailability().model).toBe("gpt-4o");
  });

  it("needs a key, not just a provider name", () => {
    process.env.NOOK_AI_PROPOSER = "gemini";
    expect(summarizeAvailability().summarize).toBe(false);

    process.env.GEMINI_API_KEY = "test-key";
    expect(summarizeAvailability()).toEqual({ proposer: "gemini", summarize: true, model: "gemini-2.5-flash" });
  });
});

// -- summarizeRecords --

describe("summarizeRecords", () => {
  const longIds = ["a", "b", "c"];

  it("returns the contract shape, in the order the caller asked", async () => {
    configureOpenAI();
    const pool = fakePool(longIds.map((id) => ({ id, data: { id, description: ARTICLE } })));
    const proposer = stubProposer("Planlar tablo büyüdükçe bozuluyor ve hedefi yükseltmek gerekiyor.");

    const result = await summarizeRecords(pool, "u1", ["c", "a", "b"], {
      fetch: proposer.fetch,
      sleep: proposer.sleep,
    });

    expect(result.model).toBe("gpt-4o-mini");
    expect(result.summaries.map((entry) => entry.id)).toEqual(["c", "a", "b"]);
    expect(result.summaries[0].summary).toBe("Planlar tablo büyüdükçe bozuluyor ve hedefi yükseltmek gerekiyor.");
    expect(result.skipped).toEqual([]);
  });

  it("cleans the model's own output on the way out", async () => {
    configureOpenAI();
    const pool = fakePool([{ id: "a", data: { id: "a", description: ARTICLE } }]);
    const proposer = stubProposer("**Bu bir özet:** Planlar tablo büyüdükçe bozuluyor.");

    const result = await summarizeRecords(pool, "u1", ["a"], { fetch: proposer.fetch, sleep: proposer.sleep });

    // The whole reason cleanSummary is load-bearing: what reaches the bookmark
    // is the sentence, not the model's framing of it.
    expect(result.summaries).toEqual([{ id: "a", summary: "Planlar tablo büyüdükçe bozuluyor." }]);
  });

  it("sends the record's own text, and asks for prose rather than JSON", async () => {
    configureOpenAI();
    const pool = fakePool([{ id: "a", data: { id: "a", title: "Planlar", description: ARTICLE } }]);
    const proposer = stubProposer("Planlar bozuluyor.");

    await summarizeRecords(pool, "u1", ["a"], { fetch: proposer.fetch, sleep: proposer.sleep });

    const body = JSON.parse(proposer.state.bodies[0]) as Record<string, unknown>;
    // ai.ts pins JSON because a taxonomy is a structure. A summary is prose, and
    // a JSON envelope here would only be another way for the call to fail.
    expect(body.response_format).toBeUndefined();
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.max_completion_tokens).toBeGreaterThan(0);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].content).toBe(SUMMARY_SYSTEM_PROMPT);
    expect(messages[1].content).toContain(ARTICLE.slice(0, 200));
  });

  it("reads the records and writes nothing", async () => {
    configureOpenAI();
    const pool = fakePool([{ id: "a", data: { id: "a", description: ARTICLE } }]);
    const proposer = stubProposer("Planlar bozuluyor.");

    await summarizeRecords(pool, "u1", ["a"], { fetch: proposer.fetch, sleep: proposer.sleep });

    // One statement, and it is a SELECT. A write here would move the record's
    // version and pull a change on every device that did not make it, so the
    // summary has to go back through the normal sync path instead.
    expect(pool.statements).toHaveLength(1);
    expect(pool.statements[0].sql.trim().toUpperCase().startsWith("SELECT")).toBe(true);
    expect(pool.statements[0].values).toEqual(["u1", ["a"]]);
  });

  it("degrades to `skipped` on a model failure rather than throwing", async () => {
    configureOpenAI();
    const pool = fakePool([{ id: "a", data: { id: "a", description: ARTICLE } }]);
    const fetchStub = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const result = await summarizeRecords(pool, "u1", ["a"], { fetch: fetchStub, sleep: async () => {} });

    expect(result.summaries).toEqual([]);
    expect(result.skipped).toEqual([{ id: "a", reason: "failed" }]);
    // Three attempts, the same policy ai.ts applies to the proposer.
    expect(fetchStub).toHaveBeenCalledTimes(3);
  });

  it("tells a model that declined apart from a model that could not be reached", async () => {
    configureOpenAI();
    const pool = fakePool([{ id: "a", data: { id: "a", description: ARTICLE } }]);
    const proposer = stubProposer("***");

    const result = await summarizeRecords(pool, "u1", ["a"], { fetch: proposer.fetch, sleep: proposer.sleep });

    expect(result.skipped).toEqual([{ id: "a", reason: "empty-output" }]);
  });

  it("reports every reason it did not ask, and asks for the rest", async () => {
    configureOpenAI();
    const pool = fakePool([
      { id: "done", data: { id: "done", description: ARTICLE, summary: "Var olan özet." } },
      { id: "tweet", data: { id: "tweet", description: TRUNCATED } },
      { id: "gone", data: { id: "gone", description: ARTICLE }, deleted_at: "2026-09-01T00:00:00.000Z" },
      { id: "long", data: { id: "long", description: ARTICLE } },
    ]);
    const proposer = stubProposer("Planlar bozuluyor.");

    const result = await summarizeRecords(
      pool,
      "u1",
      ["done", "tweet", "gone", "long", "never-synced", "long"],
      { fetch: proposer.fetch, sleep: proposer.sleep },
    );

    expect(result.summaries.map((entry) => entry.id)).toEqual(["long"]);
    expect(result.skipped).toEqual([
      { id: "done", reason: "already-summarised" },
      { id: "tweet", reason: "too-short" },
      { id: "gone", reason: "deleted" },
      { id: "never-synced", reason: "not-found" },
    ]);
    // One request for the one record, and the repeat id was collapsed.
    expect(proposer.state.calls).toBe(1);
  });

  it("degrades to `unavailable` without touching the database when no proposer is set", async () => {
    const pool = fakePool([{ id: "a", data: { id: "a", description: ARTICLE } }]);

    const result = await summarizeRecords(pool, "u1", ["a"], {});

    // An unconfigured optional feature must not become a red error on the
    // Settings screen, and the reason is machine-readable so the panel can say
    // "the server has no model configured" rather than "nothing to do".
    expect(result.model).toBe(UNAVAILABLE_MODEL);
    expect(result.skipped).toEqual([{ id: "a", reason: "unavailable" }]);
    expect(pool.statements).toHaveLength(0);
  });

  it("does nothing at all for an empty request", async () => {
    configureOpenAI();
    const pool = fakePool([]);

    const result = await summarizeRecords(pool, "u1", ["", "   "], {});

    expect(result).toEqual({ summaries: [], skipped: [], model: "gpt-4o-mini" });
    expect(pool.statements).toHaveLength(0);
  });
});
