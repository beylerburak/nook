// No network, no database, no API key: a `vi.fn()` pool and a `vi.fn()` pool
// client, dispatched on the statement text — the same stubbing style as
// ai-jobs.unit.test.ts, one layer deeper because the pass owns a lease and a
// transaction underneath it.
//
// The two things pinned hardest here are the two that cost money or cost a user's
// trust. `summaryContentHash` must be blind to `summary` and sensitive to
// everything the prompt reads, or a deletion is either impossible or lost; and
// `summaryOutcomeWindow` must keep "the model had nothing to say" apart from "the
// network was down", because conflating them re-buys a library forever or parks it
// for a week after a blip.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SUMMARY_BATCH_SIZE,
  SUMMARY_DECLINE_MS,
  SUMMARY_RETRY_MS,
  countSummarizeStatus,
  planSummaryWork,
  pruneSummaries,
  readSummarizeStatus,
  runSummarizationPass,
  summaryContentHash,
  summaryOutcomeWindow,
  summarySourceText,
  topUpSummaryQueue,
  type SummaryAttempt,
} from "../src/ai-summary.js";
import type { SummaryRecord } from "../src/summarize.js";

// -- fixtures -------------------------------------------------------------

const NOW = Date.parse("2026-09-26T12:00:00.000Z");

/** Longer than the 180-character truncation `shortDescription` applies and past the
 *  400-character gate, so "long enough to summarise" is a fact about the fixture
 *  rather than an assumption — the same relationship `isWorthSummarising` is built
 *  on. */
const BODY =
  "Veritabanı indeksleme davranışlarını incelerken VACUUM'in neden yavaşladığını anlamak istedim; " +
  "PostgreSQL'in autovacuum ayarlarının buna nasıl etki ettiğini de öğrenmek istiyorum, yoksa yavaşlık kalıcı mı. " +
  "Yazının devamında çok kolonlu indekslerde arama planlarının neden bozulduğu ölçülüyor, istatistik hedeflerinin " +
  "ne sıklıkla yükseltilmesi gerektiği hesaplanıyor ve üretimde kademeli bir geçiş öneriliyor.";

function article(id: string, overrides: Record<string, unknown> = {}): SummaryRecord {
  return { id, data: { id, title: "Çok kolonlu indekslerde arama planları", description: BODY, ...overrides } };
}

/** A record the gate rejects, standing in for the X-post shape most of a real
 *  library has. */
function tweet(id: string): SummaryRecord {
  return { id, data: { id, title: "vdb", description: BODY.slice(0, 180) } };
}

function attempt(overrides: Partial<SummaryAttempt> = {}): SummaryAttempt {
  return { contentHash: "hash", at: new Date(NOW - 60_000).toISOString(), outcome: "declined", ...overrides };
}

/** Whitespace-collapsed, so an assertion can quote a fragment of a statement
 *  without reproducing its indentation. */
function flatten(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

interface Recorded {
  sql: string;
  params: unknown[];
}

interface PassStubOptions {
  /** false = another replica holds it. */
  lease?: boolean;
  settings?: Record<string, unknown>;
  state?: Record<string, unknown>;
  /** Rows the candidate query returns. */
  candidates?: Array<{ id: string; data: Record<string, unknown>; deleted_at?: string | null }>;
  attempts?: Array<{ bookmark_id: string; content_hash: string; at: string; outcome: "declined" | "failed" }>;
  /** The row the write path re-reads, keyed by id. */
  records?: Record<string, { data: Record<string, unknown>; deleted_at?: string | null } | null>;
  /** What the model answers per record id. */
  summaries?: Record<string, string>;
  /** Records the model produced nothing usable for. */
  declines?: string[];
  /** Ids whose call failed. */
  failures?: string[];
}

function passPool(options: PassStubOptions = {}) {
  const poolStatements: Recorded[] = [];
  const clientStatements: Recorded[] = [];
  const written = new Map<string, Record<string, unknown>>();
  const remembered: Array<{ id: string; hash: string; outcome: string }> = [];
  let deletedAttempts: string[][] = [];

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const statement = { sql: flatten(sql), params };
      clientStatements.push(statement);
      if (statement.sql.includes("SELECT data, deleted_at FROM nook_records")) {
        const id = String(params[2]);
        const record = options.records?.[id] === undefined ? { data: { id } } : options.records?.[id];
        return { rows: record ? [record] : [], rowCount: record ? 1 : 0 };
      }
      if (statement.sql.startsWith("UPDATE nook_records")) {
        written.set(String(params[2]), JSON.parse(String(params[3])));
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => client),
    // Dispatch is on distinctive fragments, most specific first: the candidate query
    // mentions `nook_ai_summaries`, `nook_ai_state` and `nook_ai_settings` in its
    // own sub-queries, so a looser check would answer it with the wrong fixture.
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const statement = { sql: flatten(sql), params };
      poolStatements.push(statement);
      if (statement.sql.includes("summary_lease_until)")) {
        return { rows: options.lease === false ? [] : [{ user_id: String(params[0]) }], rowCount: 1 };
      }
      if (statement.sql.includes("SELECT data FROM nook_ai_settings")) {
        return { rows: [{ data: options.settings ?? { autoSummarize: true } }] };
      }
      if (statement.sql.includes("SELECT data FROM nook_ai_state")) {
        return { rows: [{ data: options.state ?? {} }] };
      }
      if (statement.sql.includes("SELECT bookmark_id, content_hash, at, outcome")) {
        return { rows: options.attempts ?? [] };
      }
      if (statement.sql.startsWith("INSERT INTO nook_ai_summaries")) {
        const [ids, hashes, outcomes] = params.slice(1) as string[][];
        ids.forEach((id, at) => remembered.push({ id, hash: hashes[at], outcome: outcomes[at] }));
        return { rows: [], rowCount: ids.length };
      }
      if (statement.sql.startsWith("DELETE FROM nook_ai_summaries WHERE")) {
        deletedAttempts.push(params[1] as string[]);
        return { rows: [], rowCount: (params[1] as string[]).length };
      }
      if (statement.sql.startsWith("DELETE FROM nook_ai_summaries d")) {
        return { rows: [], rowCount: 3 };
      }
      if (statement.sql.includes("SELECT id, data, deleted_at FROM nook_records")) {
        // `summarizeRecords`' own re-read: the same rows the work list read, which
        // is the second gate the pass leans on.
        return {
          rows: (options.candidates ?? [])
            .filter((row) => (params[1] as string[]).includes(row.id))
            .map((row) => ({ id: row.id, data: row.data, deleted_at: row.deleted_at ?? null })),
        };
      }
      if (statement.sql.includes("ORDER BY COALESCE(r.data->>'savedAt'")) {
        return {
          rows: (options.candidates ?? []).map((row) => ({
            id: row.id,
            data: row.data,
            deleted_at: row.deleted_at ?? null,
          })),
        };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  return {
    pool: pool as never,
    poolStatements,
    clientStatements,
    written,
    remembered,
    deletedAttempts: () => deletedAttempts,
    /** The candidate statement, which is the one the count and the top-up share. */
    candidateSql: () => poolStatements.find((statement) => statement.sql.includes("ORDER BY COALESCE(r.data->>'savedAt'")),
  };
}

/** A proposer that answers per id, so one call can summarise some records and
 *  decline others. Counts as configured by the caller's environment. */
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
  delete process.env.NOOK_AI_SUMMARY_BATCH;
  delete process.env.NOOK_AI_SUMMARY_RETRY_MS;
  delete process.env.NOOK_AI_SUMMARY_DECLINE_MS;
});

// -- the content hash -----------------------------------------------------

describe("summaryContentHash", () => {
  it("never changes because a summary was written, which is what keeps the memory honest", () => {
    const before = summaryContentHash(article("b1").data);
    // A pass writing a summary is a *change to the record* and must not be a change
    // to the text. If it were, every write would present itself as a new text, the
    // attempt memory would never suppress anything, and the library would be
    // re-bought on every pass.
    const after = summaryContentHash(article("b1", { summary: "Planlar bozuluyor." }).data);
    expect(after).toBe(before);
    // ...and clearing it back to nothing is equally invisible, which is the other
    // half: `null` and `""` both mean "no summary", so what makes a cleared record a
    // candidate is the *row* having been deleted on write — not the hash moving.
    expect(summaryContentHash(article("b1", { summary: null }).data)).toBe(before);
    expect(summaryContentHash(article("b1", { summary: "" }).data)).toBe(before);
  });

  it("changes for every field the prompt actually reads", () => {
    const base = summaryContentHash(article("b1").data);
    // Title, description and note are the three fields `buildSummaryPrompt` reads,
    // and an edited note is the case the rule is *for*: the summary on the record
    // would otherwise be of something the user no longer saved.
    expect(summaryContentHash(article("b1", { title: "Başka bir başlık" }).data)).not.toBe(base);
    expect(summaryContentHash(article("b1", { description: `${BODY} Ek bir cümle.` }).data)).not.toBe(base);
    expect(summaryContentHash(article("b1", { note: "sunum için" }).data)).not.toBe(base);
  });

  it("ignores the fields the prompt does not read, so an edit to one of those is not a new text", () => {
    // Tags, url and ai move on every tag edit and every sync, and none of them is
    // something the model was asked about. Hashing the record rather than the text
    // would re-summarise the library on a rename — the mistake
    // `embeddedText`'s own note warns about for vectors.
    const base = summaryContentHash(article("b1").data);
    expect(summaryContentHash(article("b1", { tags: ["arayuz"] }).data)).toBe(base);
    expect(summaryContentHash(article("b1", { url: "https://example.com/other" }).data)).toBe(base);
    expect(summaryContentHash(article("b1", { ai: { model: "jev-1.13.0" } }).data)).toBe(base);
  });

  it("is the hash of the prompt's own text, not a second rendering of the record", () => {
    // The strongest form of the property, and the one that keeps a future change to
    // the prompt from silently invalidating every stored hash: if the two ever
    // diverged, the summary would be considered fresh or stale against text the
    // model never saw, and nothing anywhere would say so.
    const data = article("b1", { note: "sunum için" }).data;
    expect(summarySourceText(data)).toContain("Saved with this note: sunum için");
    expect(summarySourceText(data)).toContain(BODY.slice(0, 200));
    expect(summaryContentHash(data)).toBe(summaryContentHash(article("b1", { note: "sunum için" }).data));
  });

  it("is total, because the hash is computed over whatever a record turned out to be", () => {
    expect(typeof summaryContentHash({})).toBe("string");
    expect(summaryContentHash({ description: 42 as unknown as string })).toBe(summaryContentHash({}));
  });
});

// -- the retry window -----------------------------------------------------

describe("summaryOutcomeWindow", () => {
  it("gives a decline a week and a failure half an hour, because they are different facts", () => {
    // A model that read the text and had nothing to say: the same question gets the
    // same answer, so a short window here is a re-bill rather than a retry.
    expect(summaryOutcomeWindow("empty-output", NOW) - NOW).toBe(SUMMARY_DECLINE_MS);
    // A timeout is transient and carries no information about the text at all. It is
    // emphatically not the model's opinion, so it must not inherit the week.
    expect(summaryOutcomeWindow("failed", NOW) - NOW).toBe(SUMMARY_RETRY_MS);
    expect(SUMMARY_DECLINE_MS / SUMMARY_RETRY_MS).toBe(336);
  });

  it("accepts the stored spelling of a decline, so the two callers cannot disagree", () => {
    // `nook_ai_summaries.outcome` says "declined"; `SummarizeResponse.skipped` says
    // "empty-output". One function answers for both rather than leaving a caller to
    // remember to translate.
    expect(summaryOutcomeWindow("declined", NOW)).toBe(summaryOutcomeWindow("empty-output", NOW));
  });

  it("gives every non-attempt a window of zero, so no row parks a record", () => {
    for (const reason of ["too-short", "already-summarised", "not-found", "deleted", "unavailable"] as const) {
      expect(summaryOutcomeWindow(reason, NOW)).toBe(0);
    }
    // The case this is really for: a 380-character description is refused by the
    // gate, and if refusing it left a row behind, the record would sit out a week
    // after the user added the paragraph that took it past 400.
  });

  it("follows the two environment overrides, and refuses a zero", () => {
    process.env.NOOK_AI_SUMMARY_DECLINE_MS = "60000";
    process.env.NOOK_AI_SUMMARY_RETRY_MS = "5000";
    expect(summaryOutcomeWindow("empty-output", NOW) - NOW).toBe(60_000);
    expect(summaryOutcomeWindow("failed", NOW) - NOW).toBe(5_000);
    // A zero window would be a rule saying "ask about this again immediately",
    // which is the one value an operator must not be able to set by accident.
    process.env.NOOK_AI_SUMMARY_RETRY_MS = "0";
    expect(summaryOutcomeWindow("failed", NOW) - NOW).toBe(SUMMARY_RETRY_MS);
  });
});

// -- the work plan --------------------------------------------------------

describe("planSummaryWork", () => {
  const hashOf = (record: SummaryRecord) => summaryContentHash(record.data);

  it("skips everything the existing gate already refuses", () => {
    // `summarySkipReason` is the tested rule and is not re-implemented here, so a
    // record it refuses never reaches the attempt test at all.
    const done = article("done", { summary: "Var olan özet." });
    const ids = planSummaryWork(
      [done, tweet("short"), { ...article("gone"), deletedAt: "2026-09-01T00:00:00.000Z" }, article("wanted")],
      new Map(),
      NOW,
    );
    expect(ids).toEqual(["wanted"]);
  });

  it("takes a record with a live attempt whose window has not expired", () => {
    const record = article("a");
    const attempts = new Map([["a", attempt({ contentHash: hashOf(record), at: new Date(NOW - 60_000).toISOString() })]]);
    // Declined a minute ago on this exact text: asking again gets the same empty
    // answer at full price.
    expect(planSummaryWork([record], attempts, NOW)).toEqual([]);
  });

  it("takes one whose attempt was a failure rather than a decline, once the short window is past", () => {
    const record = article("a");
    const at = new Date(NOW - (SUMMARY_RETRY_MS + 1)).toISOString();
    const attempts = new Map([["a", attempt({ contentHash: hashOf(record), at, outcome: "failed" })]]);
    // A timeout is not the model's opinion, so half an hour is the whole wait.
    expect(planSummaryWork([record], attempts, NOW)).toEqual(["a"]);
  });

  it("still refuses a decline inside its long window, and takes it once that is past", () => {
    const record = article("a");
    const refused = new Map([
      ["a", attempt({ contentHash: hashOf(record), at: new Date(NOW - (SUMMARY_RETRY_MS + 1)).toISOString() })],
    ]);
    // The SQL pre-filter only knows the short window, so this row is offered here —
    // and this function is what refuses it. That is the whole design of the
    // approximation: a wasted SELECT, never a re-bill.
    expect(planSummaryWork([record], refused, NOW)).toEqual([]);

    const expired = new Map([
      ["a", attempt({ contentHash: hashOf(record), at: new Date(NOW - (SUMMARY_DECLINE_MS + 1)).toISOString() })],
    ]);
    expect(planSummaryWork([record], expired, NOW)).toEqual(["a"]);
  });

  it("takes a record whose text changed under a live attempt, which is the edited-note case", () => {
    const record = article("a", { note: "sunum için" });
    const attempts = new Map([["a", attempt({ contentHash: "the hash of some older text" })]]);
    // A different hash means the stored answer is about text that no longer exists,
    // and a summary of the old text on a record whose note you just changed is
    // wrong in the one way a user notices.
    expect(planSummaryWork([record], attempts, NOW)).toEqual(["a"]);
  });

  it("takes a record that was never attempted, which is every record on a fresh account", () => {
    expect(planSummaryWork([article("a"), article("b")], new Map(), NOW)).toEqual(["a", "b"]);
  });

  it("treats a row it cannot read as no row, because a memory nothing can parse must not park a record", () => {
    const record = article("a");
    const unparseable = new Map([["a", attempt({ contentHash: hashOf(record), at: "not a date" })]]);
    expect(planSummaryWork([record], unparseable, NOW)).toEqual(["a"]);
  });

  it("is total, and does not repeat an id", () => {
    const record = article("a");
    const ids = planSummaryWork(
      [
        record,
        record,
        { id: "", data: {} },
        null as unknown as SummaryRecord,
        { data: {} } as unknown as SummaryRecord,
        article("b"),
      ],
      new Map(),
      NOW,
    );
    expect(ids).toEqual(["a", "b"]);
  });
});

// -- the work list --------------------------------------------------------

describe("topUpSummaryQueue", () => {
  it("asks the candidate query and nothing else, and gates on the toggle inside it", async () => {
    const stub = passPool({ candidates: [{ id: "a", data: article("a").data }] });
    expect(await topUpSummaryQueue(stub.pool, "u1")).toBe(1);

    const statement = stub.candidateSql() as Recorded;
    // A live bookmark: a collection is not a candidate and a deleted one never will
    // be.
    expect(statement.sql).toContain("r.kind = 'bookmark'");
    expect(statement.sql).toContain("r.deleted_at IS NULL");
    // The documented meaning of a cleared summary: no summary at all. btrim so a
    // whitespace-only one is the same answer, which is what the JS side's cleanText
    // says too.
    expect(statement.sql).toContain("coalesce(btrim(r.data->>'summary'), '') = ''");
    // The 400-character gate, interpolated from the one place it is defined rather
    // than written out again here.
    expect(statement.sql).toContain("length(coalesce(r.data->>'description', '')) > 400");
    // The attempt exclusion, on the SHORT window — see planSummaryWork for why that
    // direction and not the other.
    expect(statement.sql).toContain("r.id NOT IN ( SELECT s.bookmark_id FROM nook_ai_summaries s");
    expect(statement.sql).toContain("s.at >= now() - $2::interval");
    // Otherwise the status route reports a queue the worker will never drain, which
    // is a lie in the one place a user checks.
    expect(statement.sql).toContain("coalesce((st.data->>'autoSummarize')::boolean, false)");
    // The summary lease is *not* a clause of this query, and the reason is worth
    // pinning because getting it wrong is silent: the pass reads this while holding
    // its own lease, so a lease guard here filters out its own candidates and the
    // feature does nothing at all.
    expect(statement.sql).not.toContain("summary_lease_until");
    // Newest first, matching the partial expression index in schema.sql.
    expect(statement.sql).toContain(
      "ORDER BY COALESCE(r.data->>'savedAt', r.data->>'createdAt', r.data->>'updatedAt') DESC NULLS LAST",
    );
    expect(statement.params).toEqual(["u1", "1800 seconds", SUMMARY_BATCH_SIZE]);
  });

  it("returns 0 rather than rejecting when the query cannot run", async () => {
    const query = vi.fn(async () => {
      throw new Error("relation nook_ai_summaries does not exist");
    });
    // The schema may still be applying; a tick that has to survive that is the
    // reason this degrades instead of throwing.
    expect(await topUpSummaryQueue({ query } as never, "u1")).toBe(0);
  });
});

describe("countSummarizeStatus", () => {
  it("asks the same candidate rule the top-up does, in one statement", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ summarised: 118, pending: 41 }] }));
    const counts = await countSummarizeStatus({ query } as never, "u1");
    expect(counts).toEqual({ summarised: 118, pending: 41 });

    const [sql, params] = query.mock.calls[0];
    const statement = flatten(sql);
    // Exact numbers rather than the upper bound the panel used to compute itself:
    // it counted every record with no summary, including the ones the gate would
    // never accept, and had to say so in the copy.
    expect(statement).toContain("coalesce(btrim(r.data->>'summary'), '') <> ''");
    expect(statement).toContain("coalesce(btrim(r.data->>'summary'), '') = ''");
    // ...which means the same filter, the same attempt rule and the same toggle, so
    // the number on the panel and the work the tick does cannot disagree.
    expect(statement).toContain("length(coalesce(r.data->>'description', '')) > 400");
    expect(statement).toContain("s.at >= now() - $2::interval");
    expect(statement).toContain("coalesce((st.data->>'autoSummarize')::boolean, false)");
    // One statement, so both numbers come from one snapshot: a panel showing 40 and
    // 41 from two reads a few milliseconds apart is reporting an arithmetic error
    // as a fact.
    expect(query).toHaveBeenCalledTimes(1);
    expect(params).toEqual(["u1", "1800 seconds"]);
  });

  it("zeroes what it cannot read, rather than showing NaN", async () => {
    const query = vi.fn(async () => ({ rows: [{}] }));
    expect(await countSummarizeStatus({ query } as never, "u1")).toEqual({ summarised: 0, pending: 0 });
  });
});

// -- the pass -------------------------------------------------------------

describe("runSummarizationPass", () => {
  function stubWithModel(options: PassStubOptions) {
    const stub = passPool(options);
    const fetchStub = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
      const asked = body.messages[1].content;
      for (const [id, text] of Object.entries(options.summaries ?? {})) {
        if (asked.includes(`Title: Çok kolonlu indekslerde arama planları`)) {
          return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }), { status: 200 });
        }
        void id;
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "Planlar bozuluyor." } }] }), {
        status: 200,
      });
    });
    return { stub, fetch: fetchStub, sleep: async () => {} };
  }

  it("writes a summary through the shared write path and forgets the attempt", async () => {
    configureOpenAI();
    const record = article("b1");
    const { stub, fetch, sleep } = stubWithModel({
      candidates: [{ id: "b1", data: record.data }],
      records: { b1: { data: record.data } },
      summaries: { b1: "Planlar bozuluyor." },
    });

    const result = await runSummarizationPass(stub.pool, "u1", { now: () => NOW, fetch, sleep });

    expect(result).toMatchObject({ ran: true, processed: 1, written: 1, skipped: 0 });
    // Through `applyServerWrite`, which means the advisory lock a sync takes and a
    // guard re-checked on the row inside it — the same mechanism the classification
    // pass writes with, not a second copy of it.
    expect(stub.clientStatements.map((statement) => statement.sql)).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "SELECT data, deleted_at FROM nook_records WHERE user_id=$1 AND kind=$2 AND id=$3 FOR UPDATE",
      "UPDATE nook_records SET data=$4::jsonb, deleted_at=$5, version=nextval('nook_sync_version_seq'), updated_at=now() WHERE user_id=$1 AND kind=$2 AND id=$3",
      "COMMIT",
    ]);
    expect(stub.written.get("b1")).toMatchObject({
      summary: "Planlar bozuluyor.",
      updatedAt: "2026-09-26T12:00:00.000Z",
    });
    // The row is DELETED, not marked done. That is what makes a deletion work: with
    // the memory gone, clearing the summary makes the record a candidate again.
    expect(stub.deletedAttempts()).toEqual([["b1"]]);
    expect(stub.remembered).toEqual([]);
  });

  it("remembers a decline with its hash, and parks it for a week", async () => {
    configureOpenAI();
    const record = article("b1");
    const stub = passPool({
      candidates: [{ id: "b1", data: record.data }],
      records: { b1: { data: record.data } },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const result = await runSummarizationPass(stub.pool, "u1", {
      now: () => NOW,
      // Nothing usable comes back, which is the model having read the text and
      // having nothing to say about it.
      fetch: async () => new Response(JSON.stringify({ choices: [{ message: { content: "***" } }] }), { status: 200 }),
      sleep: async () => {},
    });

    expect(result).toMatchObject({ ran: true, processed: 0, written: 0, skipped: 1 });
    expect(stub.written.size).toBe(0);
    // One row, the hash of the text we asked about, `at = now()`, and the outcome —
    // the four things the table holds. The hash is what makes the row a statement
    // about *this* text: edit the note and it stops applying.
    expect(stub.remembered).toEqual([
      { id: "b1", hash: summaryContentHash(record.data), outcome: "declined" },
    ]);
    const insert = stub.poolStatements.find((statement) => statement.sql.startsWith("INSERT INTO nook_ai_summaries"));
    // One statement for the whole batch: 25 round trips to record 25 refusals is a
    // pass whose bookkeeping costs more than its model calls. And `now()` rather
    // than the pass's clock, because the window is measured from when the attempt
    // happened and `now` is a test's injected constant.
    expect(insert?.sql).toContain("FROM unnest($2::text[], $3::text[], $4::text[]) AS x(id, hash, outcome)");
    expect(insert?.sql).toContain("now()");
    expect(stub.deletedAttempts()).toEqual([]);
  });

  it("remembers a failure too, but as a failure, so a blip does not park a record for a week", async () => {
    configureOpenAI();
    const record = article("b1");
    const stub = passPool({
      candidates: [{ id: "b1", data: record.data }],
      records: { b1: { data: record.data } },
    });
    const result = await runSummarizationPass(stub.pool, "u1", {
      now: () => NOW,
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      sleep: async () => {},
    });

    expect(result).toMatchObject({ ran: true, processed: 0, written: 0, skipped: 1 });
    expect(stub.remembered).toMatchObject([{ id: "b1", outcome: "failed" }]);
    const state = JSON.parse(
      (stub.poolStatements.find((statement) => statement.sql.includes("jsonb_build_object('summarize'")) as Recorded)
        .params[1] as string,
    );
    // A transport error is a real failure, not a deployment state, so it backs off
    // exponentially rather than parking for an hour.
    expect(state.backoffUntil).toBe("2026-09-26T12:01:00.000Z");
    expect(state.backoffMs).toBe(60_000);
    expect(state.unavailableUntil).toBeNull();
    expect(state.lastError).toMatch(/backing off/);
  });

  it("leaves no row for a record it never asked the model about", async () => {
    configureOpenAI();
    const stub = passPool({
      candidates: [
        { id: "short", data: tweet("short").data },
        { id: "done", data: article("done", { summary: "Var olan." }).data },
      ],
      records: {
        short: { data: tweet("short").data },
        done: { data: article("done", { summary: "Var olan." }).data },
      },
    });
    const result = await runSummarizationPass(stub.pool, "u1", { now: () => NOW, sleep: async () => {} });

    // `summarizeRecords` re-reads and re-plans, and that is a *good* second gate on
    // a later read: between the work list and the call, a record can be shortened,
    // summarised by something else, or deleted, and the tested rules catch all
    // three. Neither is an attempt, so neither leaves a row.
    expect(result.ran).toBe(false);
    expect(stub.remembered).toEqual([]);
  });

  it("refuses a write whose guard fails on the fresh row, which is the concurrent-write case", async () => {
    configureOpenAI();
    const record = article("b1");
    const { stub, fetch, sleep } = stubWithModel({
      candidates: [{ id: "b1", data: record.data }],
      // A summary arrived while the call was in flight: another pass on another
      // replica, or a device that already had one and synced it in. The only moment
      // the claim "no summary" can be broken is the row re-read inside the lock,
      // which is the whole reason the guard is re-evaluated there.
      records: { b1: { data: { ...record.data, summary: "Başka bir cihazın özeti." } } },
      summaries: { b1: "Planlar bozuluyor." },
    });

    const result = await runSummarizationPass(stub.pool, "u1", { now: () => NOW, fetch, sleep });

    expect(result).toMatchObject({ ran: true, processed: 1, written: 0, skipped: 1 });
    expect(stub.written.size).toBe(0);
    // A ROLLBACK and no nextval: a version bump here would push a change to every
    // device and resurface the bookmark as freshly edited, for a summary nobody
    // asked for twice.
    expect(stub.clientStatements.at(-1)?.sql).toBe("ROLLBACK");
    expect(stub.clientStatements.some((statement) => statement.sql.startsWith("UPDATE nook_records"))).toBe(false);
    // And no row is deleted, because there was no memory to delete.
    expect(stub.deletedAttempts()).toEqual([]);
  });

  it("refuses a write whose description fell back under the gate while the call was out", async () => {
    configureOpenAI();
    const record = article("b1");
    const { stub, fetch, sleep } = stubWithModel({
      candidates: [{ id: "b1", data: record.data }],
      // A 180-character X-post shape: the user replaced the article with the tweet
      // it was about while the request was out, and a summary of the article is
      // worse than no summary.
      records: { b1: { data: { ...record.data, description: BODY.slice(0, 180) } } },
      summaries: { b1: "Planlar bozuluyor." },
    });

    const result = await runSummarizationPass(stub.pool, "u1", { now: () => NOW, fetch, sleep });

    expect(result).toMatchObject({ ran: true, processed: 1, written: 0, skipped: 1 });
    expect(stub.written.size).toBe(0);
  });

  it("does nothing at all when another replica holds the lease", async () => {
    const stub = passPool({ lease: false, candidates: [{ id: "b1", data: article("b1").data }] });
    const fetch = vi.fn();
    const result = await runSummarizationPass(stub.pool, "u1", { now: () => NOW, fetch });

    expect(result.ran).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    // ...and the lease it did not take is one it must not release.
    expect(stub.poolStatements.some((statement) => statement.sql.includes("summary_lease_until = NULL"))).toBe(false);
  });

  it("releases the lease it took, in a finally", async () => {
    const stub = passPool({ candidates: [] });
    await runSummarizationPass(stub.pool, "u1", { now: () => NOW });
    const release = stub.poolStatements.find((statement) => statement.sql.includes("summary_lease_until = NULL"));
    expect(release).toBeDefined();
  });

  it("stops at the toggle, at a cooldown, and at an empty work list — in that order", async () => {
    const off = passPool({ settings: { autoSummarize: false }, candidates: [{ id: "b1", data: article("b1").data }] });
    expect((await runSummarizationPass(off.pool, "u1", { now: () => NOW })).ran).toBe(false);
    expect(off.candidateSql()).toBeUndefined();

    const cooling = passPool({
      state: { summarize: { backoffUntil: "2026-09-26T13:00:00.000Z" } },
      candidates: [{ id: "b1", data: article("b1").data }],
    });
    expect((await runSummarizationPass(cooling.pool, "u1", { now: () => NOW })).ran).toBe(false);
    expect(cooling.candidateSql()).toBeUndefined();

    // The cost gate. Everything below it spends money, and once a minute, forever,
    // is a lot of ticks with nothing in them.
    const empty = passPool({ candidates: [] });
    const fetch = vi.fn();
    expect((await runSummarizationPass(empty.pool, "u1", { now: () => NOW, fetch })).ran).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to plan a batch the per-call ceiling would truncate", async () => {
    process.env.NOOK_AI_SUMMARY_BATCH = "5000";
    const stub = passPool({ candidates: [] });
    await runSummarizationPass(stub.pool, "u1", { now: () => NOW });
    // Clamped to the same 50 `summarizeRecords` accepts, so the tail of an
    // over-eager batch is refused here rather than planned, not called, and offered
    // again next tick.
    expect((stub.candidateSql() as Recorded).params).toEqual(["u1", "1800 seconds", 50]);
  });

  it("never rejects, and records the failure instead", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("summary_lease_until)")) return { rows: [{ user_id: "u1" }], rowCount: 1 };
      throw new Error("connection terminated");
    });
    const result = await runSummarizationPass({ query } as never, "u1", { now: () => NOW });
    // A pass runs from a timer; a rejection there is an unhandled rejection, and an
    // unhandled rejection is a dead process.
    expect(result.error).toMatch(/connection terminated/);
  });
});

describe("pruneSummaries", () => {
  it("drops the rows whose bookmark is gone, and reports how many", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 4 }));
    expect(await pruneSummaries({ query } as never, "u1")).toBe(4);

    const [sql, params] = query.mock.calls[0];
    // Tombstones count as gone, not just missing rows: a deleted bookmark is not a
    // candidate for any future top-up, so remembering an attempt on it buys nothing.
    expect(flatten(sql)).toContain("r.kind = 'bookmark'");
    expect(flatten(sql)).toContain("r.deleted_at IS NULL");
    expect(params).toEqual(["u1"]);
  });

  it("returns 0 rather than rejecting", async () => {
    const query = vi.fn(async () => {
      throw new Error("deadlock detected");
    });
    expect(await pruneSummaries({ query } as never, "u1")).toBe(0);
  });
});

// -- the status -----------------------------------------------------------

describe("readSummarizeStatus", () => {
  const NOW_ISO = new Date(NOW).toISOString();

  function statusPool(rows: { summarised?: number; pending?: number; state?: Record<string, unknown> }) {
    const query = vi.fn(async (sql: string) => {
      // The count statement also mentions `nook_ai_state` (in the lease guard), so
      // it is matched first.
      if (sql.includes("coalesce(btrim")) return { rows: [{ summarised: rows.summarised ?? 0, pending: rows.pending ?? 0 }] };
      if (sql.includes("FROM nook_ai_state")) return { rows: [{ data: rows.state ?? {} }] };
      throw new Error(`unexpected statement: ${sql}`);
    });
    return { query };
  }

  it("fills every field, for an account that has never run a pass", async () => {
    process.env.NOOK_AI_PROPOSER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    const status = await readSummarizeStatus(statusPool({}) as never, "u1", NOW);
    // Every field present and zeroed, the same discipline
    // `normalizeAiRunState` keeps for the classification half: a panel rendering
    // `undefined` is worse than one rendering a count that restarted.
    expect(status).toEqual({
      available: true,
      model: "gpt-4o-mini",
      pending: 0,
      summarised: 0,
      written: 0,
      skipped: 0,
      lastRunAt: null,
      lastError: null,
      isUnavailable: false,
      isBackingOff: false,
    });
  });

  it("reads the sub-record, resolves the cooldowns, and names the model a call would use", async () => {
    const status = await readSummarizeStatus(
      statusPool({
        summarised: 118,
        pending: 41,
        state: {
          summarize: {
            processed: 300,
            written: 118,
            skipped: 4,
            lastRunAt: NOW_ISO,
            lastError: null,
            unavailableUntil: "2026-09-26T13:00:00.000Z",
            backoffUntil: "2026-09-26T11:00:00.000Z",
            backoffMs: 120_000,
          },
        },
      }) as never,
      "u1",
      NOW,
    );
    expect(status).toMatchObject({
      // Real numbers, not the upper bound the panel used to compute locally.
      summarised: 118,
      pending: 41,
      written: 118,
      skipped: 4,
      lastRunAt: NOW_ISO,
    });
    // A window in the future is in effect and one in the past is not, which is the
    // whole difference between a stored stamp and a rendered boolean.
    expect(status.isUnavailable).toBe(true);
    expect(status.isBackingOff).toBe(false);
    // The same resolution `summarizeRecords` makes, so what the panel names is what
    // would be called.
    expect(status.model).toBe("gpt-4o-mini");
  });

  it("reports an unconfigured server as unavailable rather than as an error", async () => {
    const status = await readSummarizeStatus(statusPool({}) as never, "u1", NOW);
    // A deployment with no proposer key is a deployment state. The panel renders
    // this from `isUnavailable`, not from `lastError`, so a quiet misconfiguration
    // must never look like a fault on the user's account.
    expect(status.available).toBe(false);
    expect(status.lastError).toBeNull();
  });
});
