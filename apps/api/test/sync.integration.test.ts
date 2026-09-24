import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncRecords, type ParsedSyncRequest, type RawChange } from "../src/sync.js";

// Integration tests need a real Postgres. They self-skip unless a throwaway test
// database is provided via NOOK_TEST_DATABASE_URL — see docs/cloud.md / the agent
// handoff notes for how to spin one up inside the running compose stack. They never
// touch the `nook` database.
const DB_URL = process.env.NOOK_TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("syncRecords (integration)", () => {
  const pool = new Pool({ connectionString: DB_URL });
  let epoch: string;

  beforeAll(async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS "user"(id text PRIMARY KEY)');
    const schema = await readFile(new URL("../src/schema.sql", import.meta.url), "utf8");
    await pool.query(schema);
    const result = await pool.query<{ value: string }>(
      "SELECT value FROM nook_sync_meta WHERE key = 'epoch'",
    );
    epoch = result.rows[0].value;
  });

  afterAll(async () => {
    await pool.end();
  });

  async function createUser(): Promise<string> {
    const id = randomUUID();
    await pool.query('INSERT INTO "user"(id) VALUES ($1)', [id]);
    return id;
  }

  function bookmarkChange(id: string, baseVersion: string | null, title = "hello"): RawChange {
    return { kind: "bookmark", id, baseVersion, data: { id, title } };
  }

  function request(cursor: string, changes: RawChange[], epochOverride?: string): ParsedSyncRequest {
    return { cursor, epoch: epochOverride, changes };
  }

  it("applies a change and returns an increasing version on each write", async () => {
    const userId = await createUser();
    const first = await syncRecords(pool, userId, request("0", [bookmarkChange("b1", null)]));
    expect(first.applied).toHaveLength(1);
    expect(first.applied[0]).toMatchObject({ kind: "bookmark", id: "b1" });
    expect(first.epoch).toBe(epoch);

    const v1 = first.applied[0].version;
    const second = await syncRecords(
      pool,
      userId,
      request(first.cursor, [bookmarkChange("b1", v1, "updated")]),
    );
    expect(second.applied).toHaveLength(1);
    expect(BigInt(second.applied[0].version)).toBeGreaterThan(BigInt(v1));
  });

  it("returns the current record as a conflict on a stale baseVersion", async () => {
    const userId = await createUser();
    const first = await syncRecords(pool, userId, request("0", [bookmarkChange("b1", null)]));
    const v1 = first.applied[0].version;

    const stale = await syncRecords(
      pool,
      userId,
      request(first.cursor, [bookmarkChange("b1", "0", "conflicting")]),
    );
    expect(stale.applied).toHaveLength(0);
    expect(stale.conflicts).toHaveLength(1);
    expect(stale.conflicts[0]).toMatchObject({ kind: "bookmark", id: "b1", version: v1 });
    expect(stale.conflicts[0].data).toMatchObject({ id: "b1", title: "hello" });
  });

  it("returns null version/data as a conflict when the record doesn't exist", async () => {
    const userId = await createUser();
    const result = await syncRecords(
      pool,
      userId,
      request("0", [bookmarkChange("missing", "5")]),
    );
    expect(result.applied).toHaveLength(0);
    expect(result.conflicts).toEqual([{ kind: "bookmark", id: "missing", version: null, data: null }]);
  });

  it("rejects one bad change without blocking the rest of the batch", async () => {
    const userId = await createUser();
    const good = bookmarkChange("good", null);
    const bad: RawChange = { kind: "bookmark", id: "bad", baseVersion: null, data: { id: "different-id" } };
    const result = await syncRecords(pool, userId, request("0", [good, bad]));
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0].id).toBe("good");
    expect(result.rejected).toEqual([{ kind: "bookmark", id: "bad", error: "Record id mismatch" }]);
  });

  it("resets the cursor and applies nothing on an epoch mismatch", async () => {
    const userId = await createUser();
    const result = await syncRecords(
      pool,
      userId,
      request("0", [bookmarkChange("b1", null)], "not-the-real-epoch"),
    );
    expect(result).toEqual({
      applied: [],
      conflicts: [],
      rejected: [],
      changes: [],
      cursor: "0",
      hasMore: true,
      epoch,
      cursorReset: true,
    });

    // Confirm nothing was actually written.
    const check = await pool.query("SELECT 1 FROM nook_records WHERE user_id=$1 AND id='b1'", [userId]);
    expect(check.rowCount).toBe(0);
  });

  it("resets the cursor when it is ahead of the user's max stored version", async () => {
    const userId = await createUser();
    const result = await syncRecords(pool, userId, request("999999999", []));
    expect(result.cursorReset).toBe(true);
    expect(result.cursor).toBe("0");
    expect(result.hasMore).toBe(true);
    expect(result.epoch).toBe(epoch);
  });

  it("paginates at 500 with hasMore, and includes epoch on every response", async () => {
    const userId = await createUser();
    const values = Array.from({ length: 520 }, (_, i) => `('${userId}', 'bookmark', 'p${i}', '{"id":"p${i}"}'::jsonb)`);
    await pool.query(
      `INSERT INTO nook_records (user_id, kind, id, data) VALUES ${values.join(",")}`,
    );

    const firstPage = await syncRecords(pool, userId, request("0", []));
    expect(firstPage.changes).toHaveLength(500);
    expect(firstPage.hasMore).toBe(true);
    expect(firstPage.epoch).toBe(epoch);

    const secondPage = await syncRecords(pool, userId, request(firstPage.cursor, []));
    expect(secondPage.changes).toHaveLength(20);
    expect(secondPage.hasMore).toBe(false);
    expect(secondPage.epoch).toBe(epoch);
  });
});
