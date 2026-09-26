import type { Pool, PoolClient } from "pg";
import { enqueueIndexing } from "./embeddings.js";

export type RecordKind = "bookmark" | "list";

export interface SyncRecord {
  kind: RecordKind;
  id: string;
  version: string;
  data: Record<string, unknown>;
}

export interface SyncConflict {
  kind: string;
  id: string;
  version: string | null;
  data: Record<string, unknown> | null;
}

export interface RejectedChange {
  kind: string;
  id: string;
  error: string;
}

export interface Mutation {
  kind: RecordKind;
  id: string;
  baseVersion: string | null;
  data: Record<string, unknown>;
}

/** A change that only passed the structural checks in `parseSyncRequest`; per-change
 *  validation (and rejection) happens later in `syncRecords`, without I/O. */
export interface RawChange {
  kind: string;
  id: string;
  baseVersion: unknown;
  data: unknown;
}

export interface ParsedSyncRequest {
  cursor: string;
  epoch?: string;
  changes: RawChange[];
}

export interface SyncResponse {
  applied: SyncRecord[];
  conflicts: SyncConflict[];
  rejected: RejectedChange[];
  changes: SyncRecord[];
  cursor: string;
  hasMore: boolean;
  epoch: string;
  cursorReset?: true;
}

const MAX_CHANGES = 100;
const MAX_RECORD_BYTES = 512_000;
const MAX_CURSOR = BigInt("9223372036854775807");
const INVALID = Symbol("invalid base version");

function parseCursor(value: unknown): string {
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid cursor");
  const parsed = BigInt(value);
  if (parsed > MAX_CURSOR) throw new Error("Invalid cursor");
  return parsed.toString();
}

function parseRawChange(value: unknown): RawChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid change");
  const change = value as Record<string, unknown>;
  if (typeof change.kind !== "string") throw new Error("Invalid change");
  if (typeof change.id !== "string") throw new Error("Invalid change");
  return { kind: change.kind, id: change.id, baseVersion: change.baseVersion, data: change.data };
}

/**
 * Structural validation only: body shape, cursor, changes array size, duplicate
 * kind+id, and that every change is an object with a string kind/id. Everything else
 * (bad id length, mismatched data.id, oversized records, ...) is a per-change concern
 * handled by `validateChange` inside `syncRecords`, so one bad record never fails the
 * whole request.
 */
export function parseSyncRequest(value: unknown): ParsedSyncRequest {
  if (!value || typeof value !== "object") throw new Error("Invalid request");
  const body = value as Record<string, unknown>;
  const cursor = body.cursor === undefined ? "0" : parseCursor(body.cursor);
  if (body.epoch !== undefined && typeof body.epoch !== "string") {
    throw new Error("Invalid epoch");
  }
  if (!Array.isArray(body.changes) || body.changes.length > MAX_CHANGES) {
    throw new Error("Invalid changes array");
  }
  const changes = body.changes.map(parseRawChange);
  const keys = new Set(changes.map(({ kind, id }) => `${kind}\0${id}`));
  if (keys.size !== changes.length) throw new Error("Duplicate changes");
  return { cursor, epoch: body.epoch as string | undefined, changes };
}

function parseBaseVersion(value: unknown): string | null | typeof INVALID {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return INVALID;
  const parsed = BigInt(value);
  if (parsed > MAX_CURSOR) return INVALID;
  return parsed.toString();
}

/** Postgres text (and therefore jsonb) cannot store a U+0000 code point anywhere in
 *  the value, so a record containing one would fail the INSERT; reject it up front
 *  instead of failing the whole batch. */
function containsNullChar(value: unknown): boolean {
  if (typeof value === "string") return value.includes("\u0000");
  if (Array.isArray(value)) return value.some(containsNullChar);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, val]) => key.includes("\u0000") || containsNullChar(val),
    );
  }
  return false;
}

/** Pure per-change validation: never touches the database. A failure here becomes a
 *  `rejected` entry; the rest of the batch is still processed. */
export function validateChange(raw: RawChange): { mutation: Mutation } | { rejected: RejectedChange } {
  const { kind, id } = raw;
  if (kind !== "bookmark" && kind !== "list") {
    return { rejected: { kind, id, error: "Invalid kind" } };
  }
  if (id.length < 1 || id.length > 256) {
    return { rejected: { kind, id, error: "Invalid id" } };
  }
  if (!raw.data || typeof raw.data !== "object" || Array.isArray(raw.data)) {
    return { rejected: { kind, id, error: "Invalid record" } };
  }
  const data = raw.data as Record<string, unknown>;
  if (data.id !== id) {
    return { rejected: { kind, id, error: "Record id mismatch" } };
  }
  if (Buffer.byteLength(JSON.stringify(data), "utf8") > MAX_RECORD_BYTES) {
    return { rejected: { kind, id, error: "Record too large" } };
  }
  if (data.deletedAt !== null && data.deletedAt !== undefined &&
      (typeof data.deletedAt !== "string" || Number.isNaN(Date.parse(data.deletedAt)))) {
    return { rejected: { kind, id, error: "Invalid deletion time" } };
  }
  if (containsNullChar(data)) {
    return { rejected: { kind, id, error: "Record contains a null character" } };
  }
  const baseVersion = parseBaseVersion(raw.baseVersion);
  if (baseVersion === INVALID) {
    return { rejected: { kind, id, error: "Invalid base version" } };
  }
  return { mutation: { kind, id, baseVersion, data } };
}

interface DbRow { kind: RecordKind; id: string; version: string; data: Record<string, unknown> }

async function currentRecord(client: PoolClient, userId: string, kind: RecordKind, id: string) {
  const result = await client.query<DbRow>(
    "SELECT kind, id, version::text, data FROM nook_records WHERE user_id=$1 AND kind=$2 AND id=$3 FOR UPDATE",
    [userId, kind, id],
  );
  return result.rows[0] ?? null;
}

export async function syncRecords(
  pool: Pool,
  userId: string,
  request: ParsedSyncRequest,
): Promise<SyncResponse> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize sync requests for one account. This keeps version allocation,
    // conflict checks and cursor reads in commit order across devices.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [userId]);

    // Read fresh on every request (never cached) so an epoch rotation after a
    // restore takes effect immediately, without an API restart.
    const epochResult = await client.query<{ value: string }>(
      "SELECT value FROM nook_sync_meta WHERE key = 'epoch'",
    );
    const epoch = epochResult.rows[0]?.value;
    if (!epoch) throw new Error("Sync epoch is not configured");

    const maxVersionResult = await client.query<{ max: string }>(
      "SELECT coalesce(max(version), 0)::text AS max FROM nook_records WHERE user_id = $1",
      [userId],
    );
    const maxVersion = maxVersionResult.rows[0].max;

    // A different epoch means the server data was replaced (restore from backup);
    // a cursor ahead of every stored version means it was rolled back. Either way
    // the client's bookkeeping no longer describes this server, so apply nothing
    // and make it resync from scratch.
    const epochMismatch = request.epoch !== undefined && request.epoch !== epoch;
    const cursorAhead = BigInt(request.cursor) > BigInt(maxVersion);
    if (epochMismatch || cursorAhead) {
      await client.query("COMMIT");
      return {
        applied: [],
        conflicts: [],
        rejected: [],
        changes: [],
        cursor: "0",
        hasMore: true,
        epoch,
        cursorReset: true,
      };
    }

    const applied: SyncRecord[] = [];
    const conflicts: SyncConflict[] = [];
    const rejected: RejectedChange[] = [];
    for (const raw of request.changes) {
      const validated = validateChange(raw);
      if ("rejected" in validated) {
        rejected.push(validated.rejected);
        continue;
      }
      const change = validated.mutation;
      const current = await currentRecord(client, userId, change.kind, change.id);
      if ((current?.version ?? null) !== change.baseVersion) {
        if (current) conflicts.push(current);
        else conflicts.push({ kind: change.kind, id: change.id, version: null, data: null });
        continue;
      }
      const result = await client.query<DbRow>(
        `INSERT INTO nook_records (user_id, kind, id, data, deleted_at)
         VALUES ($1, $2, $3, $4::jsonb, $5)
         ON CONFLICT (user_id, kind, id) DO UPDATE SET
           data=EXCLUDED.data,
           deleted_at=EXCLUDED.deleted_at,
           version=nextval('nook_sync_version_seq'),
           updated_at=now()
         RETURNING kind, id, version::text, data`,
        [userId, change.kind, change.id, JSON.stringify(change.data), change.data.deletedAt ?? null],
      );
      applied.push(result.rows[0]);
    }
    const result = await client.query<DbRow>(
      // ORDER BY must be table-qualified: the SELECT list's `version::text` cast
      // creates an output column also named "version", and an unqualified ORDER BY
      // matches that text output column first, sorting lexicographically instead of
      // numerically (e.g. "10" before "9") once a user has 10+ rows.
      `SELECT kind, id, version::text, data
       FROM nook_records WHERE user_id=$1 AND version>$2::bigint
       ORDER BY nook_records.version LIMIT 501`,
      [userId, request.cursor],
    );
    await client.query("COMMIT");
    // Fire-and-forget indexing, here for three reasons. After the COMMIT, because
    // a vector is derived data and a change that is not yet indexed is still a
    // saved change - the reverse order would mean holding a transaction open
    // across a network call to OpenAI. Outside the advisory lock, which
    // `pg_advisory_xact_lock` has already released with the COMMIT. And wrapped,
    // because a throw from here would fall into the catch below, whose ROLLBACK
    // would mask a change that is already committed: the client would see a
    // failure, retry, and be told it conflicted with its own previous attempt,
    // forever (docs/retrieval.md, "How the index gets built").
    enqueueIndexing(pool, userId, applied.filter((record) => record.kind === "bookmark"));
    const hasMore = result.rows.length > 500;
    const changes = result.rows.slice(0, 500);
    return {
      applied,
      conflicts,
      rejected,
      changes,
      cursor: changes.at(-1)?.version ?? request.cursor,
      hasMore,
      epoch,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
