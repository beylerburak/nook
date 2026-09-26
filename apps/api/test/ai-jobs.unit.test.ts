// No network, no database, no API key. Everything here is a `vi.fn()` pool and a
// `vi.fn()` pool client, dispatched on the statement text — the same stubbing style
// as embeddings.unit.test.ts, one layer deeper because the write path owns a
// transaction.
//
// The most important test in this file is "keeps going when a candidate is merely
// under the 40-character floor". It is the regression test for a real bug: the
// deleted runner treated the neutral placeholder `classifyBookmarkOutcome` returns
// for a bookmark under the floor as a terminal failure, so one 39-character post
// ended the pass and burned the rest of the batch (see `classifyOne` in
// ../src/ai-jobs.ts). The rest are the properties that bug took with it: what a
// genuine failure does, and what the queue's SQL has to exclude to stay free.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CLASSIFY_BATCH_SIZE,
  CLASSIFY_CONCURRENCY,
  applyClassificationPatch,
  applyServerWrite,
  claimJobs,
  enqueueClassification,
  parseTaxonomyAcceptance,
  parseTaxonomyProposeBody,
  requestClassificationRun,
  runClassificationPass,
  topUpClassificationQueue,
} from "../src/ai-jobs.js";
import { UNAVAILABLE_MODEL, type ClassifyResponse } from "../src/ai.js";
import type { ClassifyRequest } from "../src/ai-classify.js";

// -- fixtures -------------------------------------------------------------

/** Long enough to clear the floor with the title alone, so a fixture built from it
 *  is one the real classifier would have called. */
const BODY =
  "PostgreSQL'in indeksleme davranışları ve VACUUM'un neden yavaşladığını anlatan kapsamlı bir yazı.";

/** A media-only capture: after the state filter this is a bare emoji and a handle,
 *  which is what 39 of a real 1,061-bookmark library reduce to. */
const SHORTHAND = "kısa bir gönderi";

function decision(overrides: Partial<ClassifyResponse> = {}): ClassifyResponse {
  return {
    model: "jev-1.13.0",
    collection: { assign: true, id: "l1", name: "Reading", confidence: 0.93, probabilities: { l1: 0.93 } },
    tags: [],
    ...overrides,
  };
}

/** The neutral placeholder: a 200 that means "the call did not happen or the model
 *  could not be reached". */
function neutral(throttled = false): { response: ClassifyResponse; throttled: boolean } {
  return {
    response: { model: UNAVAILABLE_MODEL, collection: { assign: false, id: null, name: null, confidence: 0, probabilities: {} }, tags: [] },
    throttled,
  };
}

function libraryRow(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Kitap ${id}`,
    short_description: BODY,
    note: null,
    url: "https://example.com/read",
    tags: null,
    list_id: null,
    list_name: null,
    creator: null,
    ai: null,
    saved_at: "2026-09-20T10:00:00.000Z",
    created_at: "2026-09-20T10:00:00.000Z",
    updated_at: "2026-09-20T10:00:00.000Z",
    data_deleted_at: null,
    ...overrides,
  };
}

interface Recorded {
  sql: string;
  params: unknown[];
}

/** Whitespace-collapsed, so an assertion can quote a fragment of a statement
 *  without reproducing its indentation. */
function flatten(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

interface PassStubOptions {
  /** false = another replica holds it. */
  lease?: boolean;
  settings?: Record<string, unknown>;
  state?: Record<string, unknown>;
  claims?: string[];
  library?: Record<string, unknown>[];
  lists?: Record<string, unknown>[];
  taxonomy?: Record<string, unknown>;
  /** The row `applyClassificationPatch` reads back for the write path. */
  record?: { data: Record<string, unknown>; deleted_at?: string | null } | null;
}

function passPool(options: PassStubOptions = {}) {
  const poolStatements: Recorded[] = [];
  const clientStatements: Recorded[] = [];

  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const statement = { sql: flatten(sql), params };
      clientStatements.push(statement);
      if (statement.sql.includes("SELECT data, deleted_at FROM nook_records")) {
        const record = options.record === undefined ? { data: { id: "b1" }, deleted_at: null } : options.record;
        return { rows: record ? [record] : [], rowCount: record ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };

  const pool = {
    connect: vi.fn(async () => client),
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const statement = { sql: flatten(sql), params };
      poolStatements.push(statement);
      if (statement.sql.includes("INSERT INTO nook_ai_state (user_id, lease_until)")) {
        return { rows: options.lease === false ? [] : [{ user_id: String(params[0]) }], rowCount: 1 };
      }
      if (statement.sql.includes("SELECT data FROM nook_ai_settings")) {
        return { rows: [{ data: options.settings ?? { autoClassify: true } }] };
      }
      if (statement.sql.includes("SELECT data FROM nook_ai_state")) {
        return { rows: [{ data: options.state ?? {} }] };
      }
      if (statement.sql.startsWith("DELETE FROM nook_ai_jobs")) {
        const claims = options.claims ?? [];
        return { rows: claims.map((bookmark_id) => ({ bookmark_id })), rowCount: claims.length };
      }
      if (statement.sql.includes("AS short_description")) {
        return { rows: options.library ?? [] };
      }
      if (statement.sql.includes("kind='list'")) {
        return { rows: options.lists ?? [] };
      }
      if (statement.sql.includes("SELECT data FROM nook_ai_taxonomy")) {
        return { rows: [{ data: options.taxonomy ?? {} }] };
      }
      return { rows: [], rowCount: 0 };
    }),
  };

  return {
    pool: pool as never,
    poolStatements,
    clientStatements,
    client,
    /** The statements run inside the write path's transaction, in order. */
    writePath: () => clientStatements.map((statement) => statement.sql),
  };
}

/** A pool whose only method is `query`, recording every statement. Typed so
 *  `mock.calls` destructures without a cast, which is the whole point of a
 *  statement-shape assertion. */
function queryPool(rows: unknown[] = [], rowCount: number = rows.length) {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows, rowCount }));
  return { pool: { query } as never, query };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.NOOK_AI_TICK_MS;
  delete process.env.NOOK_AI_LEASE_SECONDS;
});

// -- the claim and the queue ----------------------------------------------

describe("claimJobs", () => {
  it("is one DELETE whose returned rows are the claim", async () => {
    const { pool, query } = queryPool([{ bookmark_id: "b1" }, { bookmark_id: "b2" }]);
    const claimed = await claimJobs(pool, "u1", 25);

    expect(claimed).toEqual(["b1", "b2"]);
    // A single statement: a claim that needed a second statement to mark itself
    // would have a window between the two, and that window is where a crash loses
    // work. Here a crash loses nothing, because the bookmark is still eligible and
    // still absent from nook_ai_decided.
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0];
    expect(flatten(sql)).toBe(
      "DELETE FROM nook_ai_jobs WHERE user_id=$1 AND bookmark_id IN ( SELECT bookmark_id FROM nook_ai_jobs WHERE user_id=$1 ORDER BY created_at LIMIT $2 ) RETURNING bookmark_id",
    );
    // Oldest first, so a bookmark queued yesterday is not starved by the newest
    // saves, which arrive continuously.
    expect(flatten(sql)).toContain("ORDER BY created_at");
    expect(params).toEqual(["u1", 25]);
  });

  it("does nothing at all for a limit of zero", async () => {
    const query = vi.fn();
    expect(await claimJobs({ query } as never, "u1", 0)).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("enqueueClassification", () => {
  it("queues the ids in one statement, and reads autoClassify inside it", async () => {
    const { pool, query } = queryPool([], 2);
    await enqueueClassification(pool, "u1", ["b1", "b2", "b1", ""]);

    const [sql, params] = query.mock.calls[0];
    const statement = flatten(sql);
    // One statement, because a sync pays no extra round trip: the decision has to
    // be the newest one anyway, and a user who turns the toggle off should stop
    // accumulating queue rows immediately rather than after the next tick.
    expect(statement).toContain("nook_ai_settings");
    expect(statement).toContain("coalesce((s.data->>'autoClassify')::boolean, false)");
    expect(statement).toContain("unnest($2::text[])");
    // A bookmark synced many times before it is claimed must not queue twice.
    expect(statement).toContain("ON CONFLICT DO NOTHING");
    expect(params).toEqual(["u1", ["b1", "b2"]]);
  });

  it("never rejects, and does not touch the database for an empty list", async () => {
    const failing = vi.fn(async () => {
      throw new Error("connection terminated");
    });
    // A throw here would land in syncRecords' catch and ROLLBACK a change that is
    // already committed; the top-up is what makes a lost insert a delay, not a loss.
    await expect(enqueueClassification({ query: failing } as never, "u1", ["b1"])).resolves.toBeUndefined();

    const query = vi.fn();
    await enqueueClassification({ query } as never, "u1", []);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("topUpClassificationQueue", () => {
  it("excludes everything that must not be bought a second time", async () => {
    const { pool, query } = queryPool([{ bookmark_id: "b1" }, { bookmark_id: "b2" }]);
    expect(await topUpClassificationQueue(pool, "u1")).toBe(2);

    const [sql, params] = query.mock.calls[0];
    const statement = flatten(sql);
    // A collection is not a candidate, and a deleted bookmark never will be.
    expect(statement).toContain("r.kind = 'bookmark'");
    expect(statement).toContain("r.deleted_at IS NULL");
    // The eligibility rule, in SQL: a bookmark a human filed, or one the model has
    // already ruled on, is not re-offered.
    expect(statement).toContain("r.data->'ai' IS NULL");
    expect(statement).toContain("r.data->'listId' IS NULL");
    // One row per bookmark, not one per enqueue.
    expect(statement).toContain("NOT EXISTS (SELECT 1 FROM nook_ai_jobs");
    // The money: a "nothing fit" verdict wrote nothing to the record, so this is
    // the only thing standing between the model and a re-bill for every bookmark
    // the account has ever declined.
    expect(statement).toContain("NOT EXISTS (SELECT 1 FROM nook_ai_decided");
    // Otherwise the status route reports a queue the worker will never drain.
    expect(statement).toContain("coalesce((s.data->>'autoClassify')::boolean, false)");
    // A claimed row is the running pass's to write; re-adding it mid-pass would
    // queue a second decision for a bookmark already being decided.
    expect(statement).toContain("s.lease_until > now()");
    // Newest first, matching selectCandidates' own sort and the partial index.
    expect(statement).toContain(
      "ORDER BY COALESCE(r.data->>'savedAt', r.data->>'createdAt', r.data->>'updatedAt') DESC NULLS LAST",
    );
    expect(statement).toContain("ON CONFLICT DO NOTHING");
    expect(params).toEqual(["u1", CLASSIFY_BATCH_SIZE]);
  });

  it("returns 0 rather than rejecting when the queue cannot be read", async () => {
    const query = vi.fn(async () => {
      throw new Error("relation nook_ai_jobs does not exist");
    });
    // The schema may still be applying; a tick that has to survive that is the
    // reason this function degrades instead of throwing.
    expect(await topUpClassificationQueue({ query } as never, "u1")).toBe(0);
  });
});

// -- the pass -------------------------------------------------------------

describe("runClassificationPass", () => {
  it("stops dispatching when a call comes back neutral, and remembers only what it bought", async () => {
    const stub = passPool({
      claims: ["b1", "b2", "b3", "b4", "b5", "b6"],
      library: ["b1", "b2", "b3", "b4", "b5", "b6"].map((id) => libraryRow(id)),
    });
    const classify = vi.fn(async () => neutral());

    const result = await runClassificationPass(stub.pool, "u1", { classify, now: () => Date.parse("2026-09-26T12:00:00Z") });

    // A terminal status ends the pass rather than spending the rest of the batch on
    // an answer it already knows it cannot use. Exactly CLASSIFY_CONCURRENCY calls
    // are made, because every one of them resolves into the stop.
    expect(classify).toHaveBeenCalledTimes(CLASSIFY_CONCURRENCY);
    expect(result.ran).toBe(true);
    expect(result.claimed).toBe(6);
    expect(result.processed).toBe(0);
    expect(result.skipped).toBe(6);
    // Nothing was bought, so nothing is remembered: these bookmarks still deserve
    // their one classification, and the top-up will queue them again. Not even the
    // statement runs — there is no id to write.
    expect(stub.poolStatements.some((statement) => statement.sql.includes("nook_ai_decided"))).toBe(false);
  });

  it("keeps going when a candidate is merely under the 40-character floor", async () => {
    // The regression test. `b1` is first in the queue because a newest-first
    // candidate list makes a media-only save exactly the case that used to end the
    // pass: it is the most recent thing the user saved.
    const stub = passPool({
      claims: ["b1", "b2"],
      library: [
        libraryRow("b1", { title: SHORTHAND, short_description: null, url: "https://x.com/a/status/1" }),
        libraryRow("b2"),
      ],
    });
    const classify = vi.fn(async (request: ClassifyRequest) => ({
      response: decision(),
      throttled: false,
    }));

    const result = await runClassificationPass(stub.pool, "u1", {
      classify,
      now: () => Date.parse("2026-09-26T12:00:00Z"),
    });

    // b1 is under the floor, so it was never asked about — and it did not stop
    // anything: b2 was dispatched and decided in the same pass.
    expect(classify).toHaveBeenCalledTimes(1);
    expect(classify.mock.calls[0][0].bookmark.id).toBe("b2");
    expect(result.processed).toBe(1);
    expect(result.skipped).toBe(1);

    // ...and it is remembered, because we have spent the analysis on reading it and
    // no amount of reading will make a 30-character post worth a request.
    const decided = stub.poolStatements.find((statement) => statement.sql.includes("nook_ai_decided"));
    expect(decided?.params).toEqual(["u1", ["b1", "b2"]]);
  });

  it("does not read the library when there is nothing queued", async () => {
    // The cost gate: the option builders need the whole library, so a pass with
    // nothing to do must not pay for reading it — and a tick with nothing to do is
    // the common case.
    const stub = passPool({ claims: [] });
    const classify = vi.fn();
    const result = await runClassificationPass(stub.pool, "u1", { classify });

    expect(result.ran).toBe(false);
    expect(result.claimed).toBe(0);
    expect(classify).not.toHaveBeenCalled();
    expect(stub.poolStatements.some((statement) => statement.sql.includes("AS short_description"))).toBe(false);
  });

  it("stops at the toggle and at a cooldown, and skips the queue entirely", async () => {
    const off = passPool({ settings: { autoClassify: false } });
    expect((await runClassificationPass(off.pool, "u1")).ran).toBe(false);
    expect(off.poolStatements.some((statement) => statement.sql.startsWith("DELETE FROM nook_ai_jobs"))).toBe(false);

    const cooling = passPool({ state: { backoffUntil: "2026-09-26T13:00:00.000Z" } });
    expect((await runClassificationPass(cooling.pool, "u1", { now: () => Date.parse("2026-09-26T12:00:00Z") })).ran)
      .toBe(false);
  });

  it("declines when another replica holds the lease", async () => {
    const stub = passPool({ lease: false, claims: ["b1"], library: [libraryRow("b1")] });
    const classify = vi.fn();
    const result = await runClassificationPass(stub.pool, "u1", { classify });

    expect(result.ran).toBe(false);
    expect(classify).not.toHaveBeenCalled();
    // ...and the lease it did not take is one it must not release.
    expect(stub.poolStatements.some((statement) => statement.sql.includes("lease_until = NULL"))).toBe(false);
  });

  it("releases the lease it took, in a finally", async () => {
    const stub = passPool({ claims: [], library: [] });
    await runClassificationPass(stub.pool, "u1");
    const release = stub.poolStatements.find((statement) => statement.sql.includes("lease_until = NULL"));
    expect(release).toBeDefined();
  });

  it("parks for an hour when this server has no key, and backs off when a call fails", async () => {
    const missing = passPool({ claims: ["b1"], library: [libraryRow("b1")] });
    await runClassificationPass(missing.pool, "u1", {
      classify: vi.fn(async () => neutral()),
      now: () => Date.parse("2026-09-26T12:00:00Z"),
    });
    const parked = JSON.parse(
      (missing.poolStatements.find((statement) => statement.sql.includes("INSERT INTO nook_ai_state (user_id, data)")) as Recorded)
        .params[1] as string,
    );
    // A deployment state: it takes a deploy, so an hour of quiet and no error.
    expect(parked.unavailableUntil).toBe("2026-09-26T13:00:00.000Z");
    expect(parked.backoffUntil).toBeNull();
    expect(parked.lastError).toBeNull();

    // With a key present, the same neutral response is a failed call, and a
    // throttled one doubles from the 60s floor. That distinction could not be made
    // by a client, which is the whole reason it is made here.
    process.env.TYPESAFE_API_KEY = "test-key";
    const failing = passPool({ claims: ["b1"], library: [libraryRow("b1")] });
    const result = await runClassificationPass(failing.pool, "u1", {
      classify: vi.fn(async () => neutral(true)),
      now: () => Date.parse("2026-09-26T12:00:00Z"),
    });
    const backed = JSON.parse(
      (failing.poolStatements.find((statement) => statement.sql.includes("INSERT INTO nook_ai_state (user_id, data)")) as Recorded)
        .params[1] as string,
    );
    expect(backed.unavailableUntil).toBeNull();
    expect(backed.backoffUntil).toBe("2026-09-26T12:01:00.000Z");
    expect(backed.backoffMs).toBe(60_000);
    expect(backed.lastError).toMatch(/backing off/);
    // The returned result carries the same sentence rather than a second wording of
    // its own, so a caller logging `result.error` cannot see nothing where the panel
    // is about to show a reason.
    expect(result.error).toBe(backed.lastError);
  });

  it("reports no error on a pass that reached the model", async () => {
    process.env.TYPESAFE_API_KEY = "test-key";
    const pool = passPool({ claims: ["b1"], library: [libraryRow("b1")] });
    const result = await runClassificationPass(pool.pool, "u1", {
      classify: vi.fn(async () => ({ response: decision({ collection: { assign: false, id: null, name: null, confidence: 0.2, probabilities: {} } }), throttled: false })),
      now: () => Date.parse("2026-09-26T12:00:00Z"),
    });
    expect(result.error).toBeUndefined();
  });

  it("never rejects, and records the failure instead", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("lease_until)")) return { rows: [{ user_id: "u1" }] };
      throw new Error("connection terminated");
    });
    const result = await runClassificationPass({ query } as never, "u1", {
      classify: vi.fn(async () => ({ response: decision(), throttled: false })),
    });
    // A pass runs from a timer; a rejection there is an unhandled rejection, and an
    // unhandled rejection is a dead process.
    expect(result.error).toMatch(/connection terminated/);
  });
});

// -- the write path -------------------------------------------------------

describe("applyClassificationPatch", () => {
  it("takes the same advisory lock a sync takes, and reads the row FOR UPDATE", async () => {
    const stub = passPool({ record: { data: { id: "b1", title: "x" } } });
    const result = await applyClassificationPatch(
      stub.pool,
      "u1",
      "b1",
      decision({ collection: { assign: false, id: null, name: null, confidence: 0.2, probabilities: {} }, tags: [] }),
      new Map(),
      3,
      null,
      "2026-09-26T12:00:00.000Z",
    );
    // Nothing to file, so nothing is written — and no version is taken.
    expect(result.wrote).toBe(false);
    expect(result.skipped).toBe(true);
    expect(stub.writePath()).toEqual([
      "BEGIN",
      // The same key as syncRecords' own lock, which is the only reason this write
      // cannot interleave with a device's sync of the same record. A different key
      // would serialise the two subsystems against nobody.
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "SELECT data, deleted_at FROM nook_records WHERE user_id=$1 AND kind=$2 AND id=$3 FOR UPDATE",
      "ROLLBACK",
    ]);
  });

  it("re-checks eligibility on the fresh row, so a human who filed it while the request was in flight wins", async () => {
    const stub = passPool({
      record: { data: { id: "b1", listId: "l1", listName: "Reading" } },
    });
    const result = await applyClassificationPatch(
      stub.pool,
      "u1",
      "b1",
      decision(),
      new Map([["l1", "Reading"]]),
      3,
      null,
      "2026-09-26T12:00:00.000Z",
    );

    expect(result.wrote).toBe(false);
    expect(result.skipped).toBe(true);
    // No write, and above all no nextval: a version bump here would push a no-op
    // change to every device and resurface the bookmark as freshly edited.
    expect(stub.writePath().some((sql) => sql.startsWith("UPDATE nook_records"))).toBe(false);
  });

  it("recomputes the union against the fresh row, so a tag added in the meantime survives", async () => {
    const stub = passPool({
      record: { data: { id: "b1", title: "x", tags: ["kullanıcı-deneyimi"] } },
    });
    const result = await applyClassificationPatch(
      stub.pool,
      "u1",
      "b1",
      decision({
        collection: { assign: false, id: null, name: null, confidence: 0.4, probabilities: {} },
        tags: [{ name: "arayuz", noul: 0.91 }],
      }),
      new Map(),
      3,
      "2026-09-01T00:00:00.000Z",
      "2026-09-26T12:00:00.000Z",
    );

    expect(result.wrote).toBe(true);
    expect(result.tagged).toBe(true);
    const update = stub.clientStatements.find((statement) => statement.sql.startsWith("UPDATE nook_records")) as Recorded;
    // The write takes a version, which is what puts the decision in front of every
    // device through the ordinary sync pull.
    expect(update.sql).toContain("version=nextval('nook_sync_version_seq')");
    expect(update.sql).toContain("deleted_at=$5");
    const merged = JSON.parse(update.params[3] as string) as Record<string, unknown>;
    // Recomputed against the row read inside the lock, not against the candidate
    // the pass read at the start: applying the earlier patch would have overwritten
    // the user's own tag with an array built from a record that no longer exists.
    expect(merged.tags).toEqual(["kullanıcı-deneyimi", "arayuz"]);
    expect(merged.updatedAt).toBe("2026-09-26T12:00:00.000Z");
    // `taxonomyAt` dates the taxonomy in force, never this decision.
    expect(merged.ai).toMatchObject({ taxonomyAt: "2026-09-01T00:00:00.000Z" });
  });

  it("writes nothing for a record that is gone or tombstoned", async () => {
    const gone = passPool({ record: null });
    expect(
      (await applyClassificationPatch(gone.pool, "u1", "b1", decision(), new Map(), 3, null, "2026-09-26T12:00:00.000Z"))
        .skipped,
    ).toBe(true);

    const tombstoned = passPool({ record: { data: { id: "b1" }, deleted_at: "2026-09-20T00:00:00.000Z" } });
    expect(
      (await applyClassificationPatch(tombstoned.pool, "u1", "b1", decision(), new Map(), 3, null, "2026-09-26T12:00:00.000Z"))
        .skipped,
    ).toBe(true);
    expect(tombstoned.writePath().at(-1)).toBe("ROLLBACK");
    // A tombstone is not a live record and the write must not invent a liveness of
    // its own: `deleted_at` comes back exactly as it was read.
    expect(tombstoned.writePath().some((sql) => sql.startsWith("UPDATE nook_records"))).toBe(false);
  });

  it("degrades rather than throwing, and rolls back", async () => {
    const stub = passPool({ record: { data: { id: "b1" } } });
    stub.client.query.mockImplementation(async (sql: string) => {
      if (sql.includes("FOR UPDATE")) throw new Error("deadlock detected");
      return { rows: [], rowCount: 0 };
    });
    const result = await applyClassificationPatch(
      stub.pool,
      "u1",
      "b1",
      decision(),
      new Map([["l1", "Reading"]]),
      3,
      null,
      "2026-09-26T12:00:00.000Z",
    );
    // A background write that threw would take down a pass that has already billed
    // its requests, and the caller is a timer with nowhere to put an exception.
    expect(result).toMatchObject({ wrote: false, skipped: true, error: "deadlock detected" });
    expect(stub.client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(stub.client.release).toHaveBeenCalled();
  });
});

// -- the extracted write path ---------------------------------------------

describe("applyServerWrite", () => {
  it("is the whole of a caller: the transaction, the lock, and the re-check", async () => {
    // The seam exists so the summarisation pass writes through the same mechanism
    // rather than a second copy of it, so what is under test here is that a caller
    // decides *nothing* about the transaction: the steps, their order, and the
    // fact that both hooks are handed the row read inside the lock.
    const stub = passPool({ record: { data: { id: "b1", title: "x" } } });
    const seen: unknown[] = [];
    const result = await applyServerWrite(stub.pool, "u1", "bookmark", "b1", "2026-09-26T12:00:00.000Z", {
      guard: (record) => {
        seen.push(record);
        return true;
      },
      build: (record) => {
        seen.push(record);
        return { summary: "Planlar bozuluyor." };
      },
    });

    expect(result.wrote).toBe(true);
    expect(stub.writePath()).toEqual([
      "BEGIN",
      "SELECT pg_advisory_xact_lock(hashtext($1))",
      "SELECT data, deleted_at FROM nook_records WHERE user_id=$1 AND kind=$2 AND id=$3 FOR UPDATE",
      "UPDATE nook_records SET data=$4::jsonb, deleted_at=$5, version=nextval('nook_sync_version_seq'), updated_at=now() WHERE user_id=$1 AND kind=$2 AND id=$3",
      "COMMIT",
    ]);
    // Both hooks saw the same row, and it is the row inside the lock rather than
    // anything the caller read earlier. That identity is the safety property: a
    // guard answered at the start of a pass is answered about a record that may
    // already be gone.
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(seen[0]).toEqual({ id: "b1", data: { id: "b1", title: "x" }, deletedAt: null });

    const update = stub.clientStatements.find((sql) => sql.sql.startsWith("UPDATE nook_records")) as Recorded;
    expect(update.params.slice(0, 3)).toEqual(["u1", "bookmark", "b1"]);
    // Stamps `updatedAt` and takes a version: what puts the change in front of
    // every device through the ordinary sync pull, and what makes the merge's
    // newer-wins resolve in the server's favour.
    const merged = JSON.parse(update.params[3] as string) as Record<string, unknown>;
    expect(merged).toMatchObject({ title: "x", summary: "Planlar bozuluyor.", updatedAt: "2026-09-26T12:00:00.000Z" });
  });

  it("reports each way of writing nothing, and never reaches the UPDATE", async () => {
    const gone = await applyServerWrite(passPool({ record: null }).pool, "u1", "bookmark", "b1", "2026-09-26T12:00:00.000Z", {
      guard: () => true,
      build: () => ({ summary: "x" }),
    });
    expect(gone).toMatchObject({ wrote: false, reason: "gone", record: null });

    const guarded = await applyServerWrite(
      passPool({ record: { data: { id: "b1" } } }).pool,
      "u1",
      "bookmark",
      "b1",
      "2026-09-26T12:00:00.000Z",
      { guard: () => false, build: () => ({ summary: "x" }) },
    );
    // A refused guard wins over anything the build would have said, so the build
    // is never asked: a caller that has decided to leave a record alone must not
    // be able to talk itself out of it.
    expect(guarded).toMatchObject({ wrote: false, reason: "guarded" });

    const stub = passPool({ record: { data: { id: "b1", summary: "already here" } } });
    const noChange = await applyServerWrite(stub.pool, "u1", "bookmark", "b1", "2026-09-26T12:00:00.000Z", {
      guard: () => true,
      build: () => ({ summary: "already here" }),
    });
    expect(noChange).toMatchObject({ wrote: false, reason: "no-change" });
    // A no-op write is a version bump and a dashboard resurfacing, for nothing.
    expect(stub.writePath().some((sql) => sql.startsWith("UPDATE nook_records"))).toBe(false);
  });

  it("is kind-parameterised, so a list row is not reachable through a bookmark write", async () => {
    const stub = passPool({ record: { data: { id: "b1" } } });
    await applyServerWrite(stub.pool, "u1", "bookmark", "b1", "2026-09-26T12:00:00.000Z", {
      guard: () => true,
      build: () => ({ summary: "x" }),
    });
    const read = stub.clientStatements.find((sql) => sql.sql.includes("FOR UPDATE")) as Recorded;
    expect(read.params).toEqual(["u1", "bookmark", "b1"]);
  });
});

// -- "Classify now" --------------------------------------------------------

describe("requestClassificationRun", () => {
  it("tops the queue up and wakes the worker without waiting for it", async () => {
    // The route's whole contract: it enqueues and returns, because 25 calls take
    // tens of seconds and that is not something to hold an HTTP request open for.
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("INSERT INTO nook_ai_jobs")) return { rows: [{ bookmark_id: "b1" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const result = await requestClassificationRun({ query } as never, "u1");
    expect(result).toEqual({ queued: 1 });
  });
});

// -- request bodies -------------------------------------------------------

describe("parseTaxonomyProposeBody", () => {
  it("tolerates an omitted body and an omitted language, and rejects a wrong one", () => {
    expect(parseTaxonomyProposeBody(undefined)).toEqual({});
    expect(parseTaxonomyProposeBody({})).toEqual({});
    expect(parseTaxonomyProposeBody({ language: "tr" })).toEqual({ language: "tr" });
    // `auto` is the server's own default, so the client omits it; sending a
    // language nobody has heard of is a 400 rather than a silent fallback.
    expect(() => parseTaxonomyProposeBody({ language: "kl" })).toThrow("Invalid language");
    expect(() => parseTaxonomyProposeBody({ language: 5 })).toThrow("Invalid language");
    expect(() => parseTaxonomyProposeBody([])).toThrow("Invalid request");
  });
});

describe("parseTaxonomyAcceptance", () => {
  it("takes names, and a tag's definition with its name", () => {
    // The definition has to travel because the server cannot reconstruct it: the
    // proposer wrote it, and it is the only evidence a member-less tag will ever
    // have when it is offered to the model. Dropping it measured 12-of-12 against
    // 10-of-12 vocabulary entries put to use (docs/ai.md).
    expect(
      parseTaxonomyAcceptance({
        collections: ["  Açık  Kaynak  "],
        tags: [{ name: "#arayuz", definition: "  Arayüz  ve  tasarım.  " }],
      }),
    ).toEqual({
      collections: ["Açık Kaynak"],
      tags: [{ name: "#arayuz", definition: "Arayüz ve tasarım." }],
    });
    expect(parseTaxonomyAcceptance({})).toEqual({ collections: [], tags: [] });
  });

  it("accepts a tag with no definition, and a bare-string tag from an older panel", () => {
    // A proposer that omitted its `why` still yields a usable tag, asked about by
    // bare name — which is what every tag was before definitions existed. A panel
    // that predates the field sends bare strings and must not 400.
    expect(parseTaxonomyAcceptance({ tags: [{ name: "arayuz" }] }).tags).toEqual([{ name: "arayuz" }]);
    expect(parseTaxonomyAcceptance({ tags: [{ name: "arayuz", definition: "   " }] }).tags).toEqual([{ name: "arayuz" }]);
    expect(parseTaxonomyAcceptance({ tags: ["arayuz"] }).tags).toEqual([{ name: "arayuz" }]);
  });

  it("rejects a name that is not a name, rather than quietly dropping it", () => {
    // The review list tells the user what is about to be created, so a ticked name
    // that vanished at acceptance would be the worst available answer.
    expect(() => parseTaxonomyAcceptance({ collections: ["ok", ""] })).toThrow("Invalid collections");
    expect(() => parseTaxonomyAcceptance({ collections: [3] })).toThrow("Invalid collections");
    expect(() => parseTaxonomyAcceptance({ tags: "arayuz" })).toThrow("Invalid tags");
    expect(() => parseTaxonomyAcceptance({ tags: [{ name: "" }] })).toThrow("Invalid tags");
    expect(() => parseTaxonomyAcceptance({ tags: [42] })).toThrow("Invalid tags");
    expect(() => parseTaxonomyAcceptance({ collections: Array.from({ length: 101 }, () => "x") })).toThrow(
      "Too many collections",
    );
    expect(() => parseTaxonomyAcceptance({ tags: Array.from({ length: 101 }, () => ({ name: "x" })) })).toThrow(
      "Too many tags",
    );
    expect(() => parseTaxonomyAcceptance(null)).toThrow("Invalid request");
  });

  it("collapses a name ticked twice into one name, keeping its definition", () => {
    expect(parseTaxonomyAcceptance({ collections: ["Reading", "Reading"] }).collections).toEqual(["Reading"]);
    expect(
      parseTaxonomyAcceptance({
        tags: [
          { name: "arayuz", definition: "Arayüz." },
          { name: "arayuz", definition: "Arayüz." },
        ],
      }).tags,
    ).toEqual([{ name: "arayuz", definition: "Arayüz." }]);
  });
});
