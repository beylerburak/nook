import "fake-indexeddb/auto";
import { afterEach, expect, test, vi } from "vitest";
import * as NookDB from "../lib/db";
import {
  DEFAULT_CLOUD_API_URL,
  bindCloudAccount,
  cloudApiUrl,
  cloudStatus,
  cloudUser,
  configureCloud,
  createJoinable,
  createTaskQueue,
  saveCloudSession,
  subscribeCloudStatus,
  syncCloud,
  unbindCloudAccount,
  type CloudStatus,
  type CloudUserProfile,
} from "../lib/cloud-sync";

afterEach(() => {
  configureCloud({ apiUrl: DEFAULT_CLOUD_API_URL, auth: "bearer" });
  vi.unstubAllGlobals();
});

async function waitUntil(predicate: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

// -- mock server --------------------------------------------------------
//
// Mimics apps/api's POST /api/sync contract, including Postgres jsonb's key
// reordering (records come back with their keys in a different order than
// they were sent in), so tests exercise the same canonical-comparison paths
// production traffic does rather than accidentally relying on key order.

type Kind = "bookmark" | "list";
interface ServerRecord { kind: Kind; id: string; version: string; data: Record<string, unknown> }
interface RawChange { kind: Kind; id: string; baseVersion: string | null; data: Record<string, unknown> }
interface RequestBody { cursor: string; changes: RawChange[]; epoch?: string }

// Deep, deterministic (but different-from-insertion-order) key reorder —
// simulates jsonb not preserving object key order.
function reorderKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reorderKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort().reverse()) {
      out[key] = reorderKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

class MockServer {
  records = new Map<string, ServerRecord>();
  versionSeq = 0;
  epoch = "epoch-1";
  rejectIds = new Set<string>();
  /** When set, requests whose change count exceeds this get a 413. */
  max413BatchSize: number | null = null;
  /** Consume-once: apply the write but respond as if the network dropped the reply. */
  dropNextResponseAfterApply = false;

  key(kind: Kind, id: string) {
    return `${kind}:${id}`;
  }

  async respond(body: RequestBody): Promise<Response> {
    if (this.max413BatchSize !== null && body.changes.length > this.max413BatchSize) {
      return new Response("Payload too large", { status: 413 });
    }
    if (body.epoch !== undefined && body.epoch !== this.epoch) {
      return this.json({ applied: [], conflicts: [], rejected: [], changes: [], cursor: "0", hasMore: true, epoch: this.epoch, cursorReset: true });
    }

    const applied: ServerRecord[] = [];
    const conflicts: Array<{ kind: Kind; id: string; version: string | null; data: Record<string, unknown> | null }> = [];
    const rejected: Array<{ kind: Kind; id: string; error: string }> = [];

    for (const change of body.changes) {
      const key = this.key(change.kind, change.id);
      if (this.rejectIds.has(key)) {
        rejected.push({ kind: change.kind, id: change.id, error: "Rejected for test" });
        continue;
      }
      const current = this.records.get(key);
      if ((current?.version ?? null) !== change.baseVersion) {
        if (current) conflicts.push({ kind: current.kind, id: current.id, version: current.version, data: current.data });
        else conflicts.push({ kind: change.kind, id: change.id, version: null, data: null });
        continue;
      }
      const version = String(++this.versionSeq);
      const stored = reorderKeys({ ...change.data }) as Record<string, unknown>;
      const record = { kind: change.kind, id: change.id, version, data: stored };
      this.records.set(key, record);
      applied.push(record);
    }

    const cursorNum = Number(body.cursor);
    const changes = [...this.records.values()]
      .filter((record) => Number(record.version) > cursorNum)
      .sort((a, b) => Number(a.version) - Number(b.version));

    if (this.dropNextResponseAfterApply) {
      this.dropNextResponseAfterApply = false;
      throw new Error("simulated network drop");
    }

    return this.json({
      applied,
      conflicts,
      rejected,
      changes,
      cursor: changes.at(-1)?.version ?? body.cursor,
      hasMore: false,
      epoch: this.epoch,
    });
  }

  json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
  }

  // Seeds a record as if another device had already synced it.
  seed(kind: Kind, id: string, data: Record<string, unknown>): ServerRecord {
    const version = String(++this.versionSeq);
    const record = { kind, id, version, data: reorderKeys({ ...data, id }) as Record<string, unknown> };
    this.records.set(this.key(kind, id), record);
    return record;
  }
}

function mockFetch(server: MockServer) {
  return vi.fn(async (_url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as RequestBody;
    return server.respond(body);
  });
}

async function legacyHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const CLOUD_ORIGIN = new URL(cloudApiUrl()).origin;

// -- tests ----------------------------------------------------------------

test("uploads local Chrome IDs safely and pulls web records", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "chrome:42", source: "chrome", url: "https://local.example", title: "Local" });
  await saveCloudSession("test-token", "user-1");

  const server = new MockServer();
  vi.stubGlobal("fetch", mockFetch(server));

  const first = await syncCloud();
  expect(first?.uploaded).toBe(1);
  const [chromeRecord] = [...server.records.values()];
  expect(chromeRecord.id).toMatch(/^chrome:[a-f0-9-]+:42$/);
  expect(chromeRecord.data.id).toBe(chromeRecord.id);

  server.seed("bookmark", "web:1", { source: "web", url: "https://remote.example", title: "Remote", updatedAt: new Date().toISOString(), deletedAt: null });
  const second = await syncCloud();
  expect(second?.downloaded).toBe(1);
  expect((await NookDB.getBookmark("web:1"))?.title).toBe("Remote");
});

test("a concurrent edit of a previously-synced record auto-merges and uploads in the same run", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "Original", tags: ["a"] });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  vi.stubGlobal("fetch", mockFetch(server));

  await syncCloud(); // baseline sync

  await new Promise((resolve) => setTimeout(resolve, 2));
  await NookDB.updateBookmark("b1", { title: "Local edit", tags: ["a", "local-tag"] });

  // A concurrent edit lands on the server from another device, bumping its version.
  const key = server.key("bookmark", "b1");
  const existing = server.records.get(key)!;
  server.records.set(key, {
    ...existing,
    version: String(++server.versionSeq),
    data: reorderKeys({ ...existing.data, title: "Remote edit", tags: ["a", "remote-tag"] }) as Record<string, unknown>,
  });

  const result = await syncCloud();
  expect(result?.uploaded).toBeGreaterThan(0); // the merged record re-uploads in this same run, not left for later

  const merged = await NookDB.getBookmark("b1");
  expect(merged?.tags).toEqual(expect.arrayContaining(["a", "local-tag", "remote-tag"]));
  expect(server.records.get(key)?.data.tags).toEqual(expect.arrayContaining(["a", "local-tag", "remote-tag"]));
});

test("legacy conflicts persisted by an older build are auto-merged on the next sync and the field is dropped", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "Local title", tags: ["local-tag"] });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  const seeded = server.seed("bookmark", "b1", {
    source: "web",
    url: "https://a.example",
    title: "Remote title",
    tags: ["remote-tag"],
    updatedAt: "2024-01-01T00:00:00.000Z",
    deletedAt: null,
  });
  vi.stubGlobal("fetch", mockFetch(server));

  // Simulate state persisted by a pre-automatic-merge build: this record was
  // flagged as a manual conflict, awaiting a resolveCloudConflict() call that
  // no longer exists.
  await NookDB.setMeta(`cloud:${CLOUD_ORIGIN}:state`, {
    cursor: seeded.version,
    versions: {},
    fingerprints: {},
    hashCache: {},
    idMap: {},
    rejected: {},
    conflicts: {
      "bookmark:b1": { kind: "bookmark", id: "b1", version: seeded.version, data: seeded.data },
    },
  });

  const result = await syncCloud();
  expect(result?.uploaded).toBe(1);

  const merged = await NookDB.getBookmark("b1");
  expect(merged?.tags).toEqual(expect.arrayContaining(["local-tag", "remote-tag"]));
  expect(server.records.get("bookmark:b1")?.data.tags).toEqual(expect.arrayContaining(["local-tag", "remote-tag"]));

  const stateAfter = await NookDB.getMeta<Record<string, unknown>>(`cloud:${CLOUD_ORIGIN}:state`);
  expect(stateAfter && "conflicts" in stateAfter).toBe(false);
});

test("an interrupted-sync retry no longer produces a spurious conflict (canonical, key-order-independent comparison)", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "A" });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  vi.stubGlobal("fetch", mockFetch(server));

  // The server commits the write, but the client never sees the response
  // (network drop) — its local bookkeeping still thinks the record is unsynced.
  server.dropNextResponseAfterApply = true;
  await expect(syncCloud()).rejects.toThrow();
  expect(server.records.size).toBe(1);

  const result = await syncCloud();
  expect(result?.uploaded).toBe(0); // retried, accepted as identical — not counted as a fresh upload
  expect((await NookDB.getBookmark("b1"))?.title).toBe("A");
});

test("a conflict for a record missing on the server (version:null) is forgotten and re-uploaded", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "A" });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  vi.stubGlobal("fetch", mockFetch(server));

  const first = await syncCloud();
  expect(first?.uploaded).toBe(1);

  // Server data loss / restore from an older backup: the record is gone.
  server.records.delete(server.key("bookmark", "b1"));
  await NookDB.updateBookmark("b1", { title: "A, edited" });

  const second = await syncCloud();
  expect(second?.uploaded).toBe(1);
  expect(server.records.get(server.key("bookmark", "b1"))?.data.title).toBe("A, edited");
});

test("an epoch change (cursorReset) resyncs from scratch and keeps newer local data", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "Original" });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  vi.stubGlobal("fetch", mockFetch(server));

  await syncCloud();
  expect(server.records.get(server.key("bookmark", "b1"))?.data.title).toBe("Original");

  // A local edit happens after the last sync, strictly newer than the server's copy.
  await new Promise((resolve) => setTimeout(resolve, 2));
  await NookDB.updateBookmark("b1", { title: "Edited locally" });

  // The server is restored to a snapshot from before that edit and its epoch rotates.
  server.epoch = "epoch-2";

  await syncCloud();
  // The local edit survives the reset via the automatic-merge rule, rather
  // than being silently overwritten by the server's older copy.
  expect((await NookDB.getBookmark("b1"))?.title).toBe("Edited locally");
});

test("first sign-in overlap with existing server data auto-merges", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "x:123", source: "x", url: "https://x.com/a/status/123", title: "Local title", tags: ["local-tag"] });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  server.seed("bookmark", "x:123", { source: "x", url: "https://x.com/a/status/123", title: "Remote title", tags: ["remote-tag"], updatedAt: "2024-01-01T00:00:00.000Z", deletedAt: null });
  vi.stubGlobal("fetch", mockFetch(server));

  await syncCloud();
  const merged = await NookDB.getBookmark("x:123");
  expect(merged?.tags).toEqual(expect.arrayContaining(["local-tag", "remote-tag"]));
  // The merged copy is uploaded in the same run, not left for the next alarm.
  expect(server.records.get("bookmark:x:123")?.data.tags).toEqual(expect.arrayContaining(["local-tag", "remote-tag"]));
});

test("one rejected record doesn't block the rest of the batch, and isn't retried until it's edited", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "good", source: "web", url: "https://good.example", title: "Good" });
  await NookDB.putBookmark({ id: "bad", source: "web", url: "https://bad.example", title: "Bad" });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  server.rejectIds.add(server.key("bookmark", "bad"));
  const fetchMock = mockFetch(server);
  vi.stubGlobal("fetch", fetchMock);

  const first = await syncCloud();
  expect(first?.uploaded).toBe(1);
  expect(first?.rejected).toBe(1);
  const status1 = await cloudStatus();
  expect(status1.rejected).toHaveLength(1);
  expect(status1.rejected[0]).toMatchObject({ id: "bad", title: "Bad" });

  const second = await syncCloud();
  expect(second?.rejected).toBe(1);
  // Unchanged rejected record isn't resent (sync still makes one request to
  // pull any remote changes, but "bad" is excluded from its payload).
  const lastBody = JSON.parse(String((fetchMock.mock.calls.at(-1)![1] as RequestInit).body)) as RequestBody;
  expect(lastBody.changes.find((change) => change.id === "bad")).toBeUndefined();

  server.rejectIds.delete(server.key("bookmark", "bad"));
  await NookDB.updateBookmark("bad", { title: "Bad, fixed" });
  const third = await syncCloud();
  expect(third?.rejected).toBe(0);
  expect(server.records.get(server.key("bookmark", "bad"))?.data.title).toBe("Bad, fixed");
});

test("HTTP 413 halves the batch and retries; a single still-oversized record is rejected instead of stuck forever", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "A" });
  await NookDB.putBookmark({ id: "b2", source: "web", url: "https://b.example", title: "B" });
  await NookDB.putBookmark({ id: "b3", source: "web", url: "https://c.example", title: "C" });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  server.max413BatchSize = 1;
  vi.stubGlobal("fetch", mockFetch(server));

  const result = await syncCloud();
  expect(result?.uploaded).toBe(3);
  expect(result?.rejected).toBe(0);
  expect(server.records.size).toBe(3);
});

test("a single record that still 413s alone is rejected as too large, without blocking future syncs", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "huge", source: "web", url: "https://huge.example", title: "Huge" });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  server.max413BatchSize = 0; // nothing ever fits
  vi.stubGlobal("fetch", mockFetch(server));

  const result = await syncCloud();
  expect(result?.rejected).toBe(1);
  const status = await cloudStatus();
  expect(status.rejected).toHaveLength(1);
  expect(status.rejected[0].error).toBe("Too large for the server");
});

test("legacy (pre-namespace) meta keys migrate into this server's namespace and are cleared", async () => {
  NookDB._resetForTests();
  await NookDB.setMeta("cloud.authToken", "legacy-token");
  await NookDB.setMeta("cloud.ownerId", "owner-legacy");
  await NookDB.setMeta("cloud.syncState", { cursor: "7", versions: { "bookmark:b1": "3" }, fingerprints: {}, idMap: {} });

  const server = new MockServer();
  const fetchMock = mockFetch(server);
  vi.stubGlobal("fetch", fetchMock);

  const status = await cloudStatus();
  expect(status.signedIn).toBe(true);
  expect(status.ownerId).toBe("owner-legacy");

  expect(await NookDB.getMeta(`cloud:${CLOUD_ORIGIN}:token`)).toBe("legacy-token");
  expect(await NookDB.getMeta("cloud.authToken")).toBeNull();
  expect(await NookDB.getMeta("cloud.ownerId")).toBeNull();
  expect(await NookDB.getMeta("cloud.syncState")).toBeNull();

  await syncCloud();
  const firstCall = fetchMock.mock.calls[0];
  const body = JSON.parse(String((firstCall[1] as RequestInit).body)) as RequestBody;
  expect(body.cursor).toBe("7"); // migrated cursor was actually used
});

test("a different server's namespace is isolated and doesn't trigger OWNER_MISMATCH", async () => {
  NookDB._resetForTests();
  await NookDB.setMeta("cloud:https://other-server.example:owner", "owner-on-other-server");

  await expect(saveCloudSession("token-here", "owner-here")).resolves.toBeUndefined();
  const status = await cloudStatus();
  expect(status.ownerId).toBe("owner-here");
});

test("a cross-device URL duplicate converges to a single live bookmark after sync", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "web:local1", source: "web", url: "https://dup.example", title: "Dup", savedAt: "2024-01-01T00:00:00.000Z" });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  server.seed("bookmark", "web:remote1", {
    source: "web",
    url: "https://dup.example",
    title: "Dup",
    tags: ["from-remote"],
    savedAt: "2024-06-01T00:00:00.000Z",
    updatedAt: "2024-06-01T00:00:00.000Z",
    deletedAt: null,
  });
  vi.stubGlobal("fetch", mockFetch(server));

  await syncCloud();
  // One more page's worth of syncing lets the dedupe's own tombstone/update upload.
  await syncCloud();

  const live = (await NookDB.getAllBookmarks()).filter((bookmark) => bookmark.url === "https://dup.example");
  expect(live).toHaveLength(1);
  expect(live[0].id).toBe("web:local1"); // earliest savedAt wins as survivor
  expect(live[0].tags).toEqual(expect.arrayContaining(["from-remote"]));
  expect((await NookDB.getBookmark("web:remote1"))?.deletedAt).toBeTruthy();
});

test("a cross-device URL duplicate with identical user data is still removed, in the same run", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "web:local2", source: "web", url: "https://same.example", title: "Same", savedAt: "2024-01-01T00:00:00.000Z" });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  server.seed("bookmark", "web:remote2", {
    source: "web",
    url: "https://same.example",
    title: "Same",
    savedAt: "2024-06-01T00:00:00.000Z",
    updatedAt: "2024-06-01T00:00:00.000Z",
    deletedAt: null,
  });
  vi.stubGlobal("fetch", mockFetch(server));

  await syncCloud();

  const live = (await NookDB.getAllBookmarks()).filter((bookmark) => bookmark.url === "https://same.example");
  expect(live.map((bookmark) => bookmark.id)).toEqual(["web:local2"]);
  expect(server.records.get("bookmark:web:remote2")?.data.deletedAt).toBeTruthy();
});

test("migrating the fingerprint format to canonicalJson doesn't re-upload unchanged records", async () => {
  NookDB._resetForTests();
  const bookmark = await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "Stable" });
  await saveCloudSession("t", "owner-1");

  const server = new MockServer();
  const seeded = server.seed("bookmark", "b1", bookmark as unknown as Record<string, unknown>);

  // Simulate state persisted under the old JSON.stringify-based fingerprint scheme.
  const legacy = await legacyHash(bookmark);
  await NookDB.setMeta(`cloud:${CLOUD_ORIGIN}:state`, {
    cursor: String(seeded.version),
    versions: { "bookmark:b1": seeded.version },
    fingerprints: { "bookmark:b1": legacy },
    idMap: {},
  });

  const fetchMock = mockFetch(server);
  vi.stubGlobal("fetch", fetchMock);

  const result = await syncCloud();
  expect(result?.uploaded).toBe(0);
  const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body)) as RequestBody;
  expect(body.changes).toHaveLength(0);
});

// -- config / namespacing --------------------------------------------------

test("configureCloud switches the apiUrl; cloudApiUrl() and the meta namespace follow it lazily", async () => {
  NookDB._resetForTests();
  expect(cloudApiUrl()).toBe(DEFAULT_CLOUD_API_URL);

  configureCloud({ apiUrl: "https://example.test/", auth: "cookie" });
  expect(cloudApiUrl()).toBe("https://example.test"); // trailing slash stripped

  await bindCloudAccount({ id: "u1", name: "U", email: "u@example.com" });
  expect(await NookDB.getMeta("cloud:https://example.test:owner")).toBe("u1");
});

// -- cookie mode (web app) --------------------------------------------------

test("cookie mode: syncCloud() is a no-op until an account is bound", async () => {
  NookDB._resetForTests();
  configureCloud({ apiUrl: "https://cookie.example", auth: "cookie" });
  expect(await syncCloud()).toBeNull();
});

test("cookie mode: binding switches accounts by wiping, unbinding can preserve or wipe the library", async () => {
  NookDB._resetForTests();
  configureCloud({ apiUrl: "https://cookie.example", auth: "cookie" });

  const profileA: CloudUserProfile = { id: "user-a", name: "A", email: "a@example.com" };
  const { wiped: firstBind } = await bindCloudAccount(profileA);
  expect(firstBind).toBe(false);
  expect((await cloudStatus()).signedIn).toBe(true);
  expect((await cloudUser())?.id).toBe("user-a");

  await NookDB.putBookmark({ id: "web:1", source: "web", url: "https://a.example", title: "Mine" });
  expect((await NookDB.getAllBookmarks()).length).toBe(1);

  // Switching to a different account wipes the local library first — the web copy is only a cache.
  const profileB: CloudUserProfile = { id: "user-b", name: "B", email: "b@example.com" };
  const { wiped: secondBind } = await bindCloudAccount(profileB);
  expect(secondBind).toBe(true);
  expect((await NookDB.getAllBookmarks()).length).toBe(0);
  expect((await cloudUser())?.id).toBe("user-b");

  await NookDB.putBookmark({ id: "web:2", source: "web", url: "https://b.example", title: "Also mine" });
  await unbindCloudAccount({ wipe: false });
  expect((await cloudStatus()).signedIn).toBe(false);
  expect((await NookDB.getAllBookmarks()).length).toBe(1); // library preserved

  await bindCloudAccount(profileB); // re-sign-in, same account: no wipe
  await unbindCloudAccount(); // default wipe: true
  expect((await NookDB.getAllBookmarks()).length).toBe(0);
});

test("cookie mode: a 401 marks signedIn false without wiping the local library; re-binding clears it", async () => {
  NookDB._resetForTests();
  configureCloud({ apiUrl: "https://cookie.example", auth: "cookie" });
  const profile: CloudUserProfile = { id: "user-a", name: "A", email: "a@example.com" };
  await bindCloudAccount(profile);
  await NookDB.putBookmark({ id: "web:1", source: "web", url: "https://a.example", title: "Mine" });

  vi.stubGlobal("fetch", vi.fn(async () => new Response("Unauthorized", { status: 401 })));
  await expect(syncCloud()).rejects.toThrow();

  const status = await cloudStatus();
  expect(status.signedIn).toBe(false);
  expect((await NookDB.getAllBookmarks()).length).toBe(1); // not wiped

  await bindCloudAccount(profile);
  expect((await cloudStatus()).signedIn).toBe(true);
});

test("bearer mode sends an Authorization header and no credentials", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "A" });
  await saveCloudSession("bearer-token", "owner-1");
  const server = new MockServer();
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer bearer-token");
    expect(init.credentials).toBeUndefined();
    return server.respond(JSON.parse(String(init.body)));
  });
  vi.stubGlobal("fetch", fetchMock);

  await syncCloud();
  expect(fetchMock).toHaveBeenCalled();
});

test("cookie mode sends credentials: include and no Authorization header", async () => {
  NookDB._resetForTests();
  configureCloud({ apiUrl: "https://cookie.example", auth: "cookie" });
  await bindCloudAccount({ id: "user-a", name: "A", email: "a@example.com" });
  await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "A" });
  const server = new MockServer();
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    expect(init.credentials).toBe("include");
    expect((init.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
    return server.respond(JSON.parse(String(init.body)));
  });
  vi.stubGlobal("fetch", fetchMock);

  await syncCloud();
  expect(fetchMock).toHaveBeenCalled();
});

// -- status -----------------------------------------------------------------

test("a network-level fetch failure marks offline without touching lastError", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "A" });
  await saveCloudSession("t", "owner-1");
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new TypeError("Failed to fetch");
  }));

  await expect(syncCloud()).rejects.toThrow();
  const status = await cloudStatus();
  expect(status.offline).toBe(true);
  expect(status.lastError).toBeUndefined();
});

test("pendingCount reflects dirty local records, excluding rejected ones", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "good", source: "web", url: "https://good.example", title: "Good" });
  await NookDB.putBookmark({ id: "bad", source: "web", url: "https://bad.example", title: "Bad" });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();
  server.rejectIds.add(server.key("bookmark", "bad"));
  vi.stubGlobal("fetch", mockFetch(server));

  expect((await cloudStatus()).pendingCount).toBe(2); // both dirty before any sync

  await syncCloud(); // "good" uploads; "bad" is rejected
  expect((await cloudStatus()).pendingCount).toBe(0); // "good" synced, "bad" excluded as rejected

  await NookDB.putBookmark({ id: "another", source: "web", url: "https://another.example", title: "Another" });
  expect((await cloudStatus()).pendingCount).toBe(1);
});

test("cloudStatus().syncing is true while a run is in progress and false once it settles", async () => {
  NookDB._resetForTests();
  await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "A" });
  await saveCloudSession("t", "owner-1");
  const server = new MockServer();

  let releaseFetch: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => { releaseFetch = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
    await gate;
    return server.respond(JSON.parse(String(init.body)));
  }));

  const syncPromise = syncCloud();
  await waitUntil(async () => (await cloudStatus()).syncing);

  releaseFetch!();
  await syncPromise;
  expect((await cloudStatus()).syncing).toBe(false);
});

test("subscribeCloudStatus fires immediately and again (debounced) after a nook-db broadcast", async () => {
  NookDB._resetForTests();
  const statuses: CloudStatus[] = [];
  const unsubscribe = subscribeCloudStatus((status) => statuses.push(status));

  await waitUntil(() => statuses.length >= 1);
  const initialCalls = statuses.length;

  await NookDB.putBookmark({ id: "b1", source: "web", url: "https://a.example", title: "A" }); // posts to "nook-db"
  await waitUntil(() => statuses.length > initialCalls);

  unsubscribe();
  const callsAfterUnsubscribe = statuses.length;
  await NookDB.putBookmark({ id: "b2", source: "web", url: "https://b.example", title: "B" });
  await new Promise((resolve) => setTimeout(resolve, 400)); // past the debounce window
  expect(statuses.length).toBe(callsAfterUnsubscribe);
});

// -- background serial-queue helper --------------------------------------

test("createTaskQueue runs enqueued tasks strictly in order, even after a failure", async () => {
  const queue = createTaskQueue();
  const order: number[] = [];
  const p1 = queue.enqueue(async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(1);
    throw new Error("boom");
  });
  const p2 = queue.enqueue(async () => {
    order.push(2);
    return "second";
  });

  await expect(p1).rejects.toThrow("boom");
  await expect(p2).resolves.toBe("second");
  expect(order).toEqual([1, 2]);
});

test("createJoinable dedupes concurrent calls into one run but starts fresh once settled", async () => {
  const queue = createTaskQueue();
  let calls = 0;
  const run = createJoinable(queue, async () => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return calls;
  });

  const [a, b] = await Promise.all([run(), run()]);
  expect(a).toBe(b); // joined the same in-flight run
  expect(calls).toBe(1);

  const c = await run();
  expect(c).toBe(2); // a call after the first settled starts a new run
});

test("a task enqueued while another is in flight runs after it, never overwritten by it", async () => {
  const queue = createTaskQueue();
  const log: string[] = [];
  const runSync = createJoinable(queue, async () => {
    log.push("sync:start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    log.push("sync:end");
  });

  const syncPromise = runSync();
  const otherPromise = queue.enqueue(async () => {
    log.push("other");
  });

  await Promise.all([syncPromise, otherPromise]);
  expect(log).toEqual(["sync:start", "sync:end", "other"]);
});
