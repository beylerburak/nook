import * as NookDB from "./db";
import { canonicalJson, mergeBookmarks, mergeLists, planUrlDuplicateMerge, sameRecordIgnoringTimestamps } from "./cloud-merge";
import type { Bookmark, BookmarkList } from "./types";

// -- configuration ----------------------------------------------------------

export type CloudAuthMode = "bearer" | "cookie";

export const DEFAULT_CLOUD_API_URL = (import.meta.env.WXT_API_URL || "https://nook.beyler.co").replace(/\/$/, "");

interface CloudConfig { apiUrl: string; auth: CloudAuthMode }

// Extension default: bearer auth against DEFAULT_CLOUD_API_URL, no call needed.
let cloudConfig: CloudConfig = { apiUrl: DEFAULT_CLOUD_API_URL, auth: "bearer" };

/**
 * Web app: must be called with `{ apiUrl: location.origin, auth: "cookie" }` before any
 * other cloud/NookDB call. Every meta key below is namespaced off the configured
 * apiUrl and computed lazily on each call (not cached at module load), so this can run
 * first and every subsequent call sees the right namespace.
 */
export function configureCloud(config: { apiUrl: string; auth: CloudAuthMode }): void {
  cloudConfig = { apiUrl: config.apiUrl.replace(/\/$/, ""), auth: config.auth };
}

export function cloudApiUrl(): string {
  return cloudConfig.apiUrl;
}

// Cloud meta (token/owner/sync state) is namespaced per API server origin, so
// switching the extension build between e.g. localhost and production (same
// extension ID => same IndexedDB) never reuses one server's session, cursor
// or versions against another. `cloud.deviceId` is intentionally NOT
// namespaced: it identifies this browser profile, independent of any server.
function cloudOrigin(): string {
  try {
    return new URL(cloudConfig.apiUrl).origin;
  } catch {
    return cloudConfig.apiUrl;
  }
}
function stateKey(): string { return `cloud:${cloudOrigin()}:state`; }
function tokenKey(): string { return `cloud:${cloudOrigin()}:token`; }
function ownerKey(): string { return `cloud:${cloudOrigin()}:owner`; }
function userKey(): string { return `cloud:${cloudOrigin()}:user`; }
function authExpiredKey(): string { return `cloud:${cloudOrigin()}:authExpired`; }
function syncingKey(): string { return `cloud:${cloudOrigin()}:syncing`; }
const DEVICE_KEY = "cloud.deviceId";

// Pre-namespace keys, migrated into the current namespace once.
const LEGACY_STATE_KEY = "cloud.syncState";
const LEGACY_TOKEN_KEY = "cloud.authToken";
const LEGACY_OWNER_KEY = "cloud.ownerId";

type Kind = "bookmark" | "list";

// -- public types -------------------------------------------------------

export interface CloudUserProfile { id: string; name: string; email: string; image?: string | null }
export interface CloudRejected { kind: "bookmark" | "list"; id: string; error: string; title?: string }
export interface CloudStatus {
  apiUrl: string;
  signedIn: boolean;
  ownerId?: string;
  user?: CloudUserProfile;
  lastSyncedAt?: string;
  lastError?: string;
  offline: boolean;
  syncing: boolean;
  pendingCount: number;
  rejected: CloudRejected[];
}

export class OwnerMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerMismatchError";
  }
}

// -- serial task queue (used by the background service worker) -------------
//
// Every cloud state-changing operation — sync, sign-in, sign-out, reset —
// must run one at a time and in order, so e.g. a sign-out can never have its
// result silently overwritten by an already-in-flight background sync.
// Extracted here (rather than living inline in entrypoints/background/index.ts)
// so the ordering/joining behavior is unit-testable without mocking chrome.* APIs.

export interface TaskQueue {
  /** Runs `task` after every previously enqueued task has settled, in order. */
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

export function createTaskQueue(): TaskQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      const run = tail.then(task, task);
      tail = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
}

/**
 * Wraps `factory` so repeated calls while one run is queued-or-in-flight all
 * join that same run instead of enqueueing a redundant extra one (used for
 * SYNC_CLOUD_NOW / the periodic alarm / cloud-runner's triggers). A call that
 * arrives once the run has settled starts (and queues) a fresh one.
 */
export function createJoinable<T>(queue: TaskQueue, factory: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | null = null;
  return () => {
    if (!pending) {
      pending = queue.enqueue(factory).finally(() => {
        pending = null;
      });
    }
    return pending;
  };
}

class TooLargeError extends Error {}

interface RejectedEntry { kind: Kind; id: string; error: string; fingerprint: string }
interface HashCacheEntry { stamp: string; hash: string }
/** Shape of a conflict entry as persisted by builds before automatic merging. */
interface LegacySyncConflict { kind: Kind; id: string; version: string; data: Bookmark | BookmarkList }

interface SyncState {
  cursor: string;
  epoch?: string;
  /** Fingerprint hashing scheme version. 2 = canonicalJson-based (see migrateFingerprintFormat). */
  format?: number;
  versions: Record<string, string>;
  /** Canonical-hash of each record as last synced with the server (local-id form). */
  fingerprints: Record<string, string>;
  /** Per-key content-hash cache keyed off a cheap stamp, so unchanged rows skip re-hashing. */
  hashCache: Record<string, HashCacheEntry>;
  idMap: Record<string, string>;
  rejected: Record<string, RejectedEntry>;
  /** Set when the last sync attempt failed before getting an HTTP response (see isNetworkError). */
  networkError?: boolean;
  lastSyncedAt?: string;
  /** Last non-network failure; cleared by the next successful request. */
  lastError?: string;
  /** Legacy field: conflicts stored by builds before automatic merging. Migrated away
   *  (auto-merged, then deleted) the first time a post-migration build syncs — see
   *  migrateLegacyConflicts. */
  conflicts?: Record<string, LegacySyncConflict>;
}

// Raw shapes as received from the server (may carry null placeholders).
interface RawConflict { kind: Kind; id: string; version: string | null; data: (Bookmark | BookmarkList) | null }
interface RawRejected { kind: string; id: string; error: string }
interface SyncResponse {
  applied: CloudRecord[];
  conflicts: RawConflict[];
  rejected: RawRejected[];
  changes: CloudRecord[];
  cursor: string;
  hasMore: boolean;
  epoch: string;
  cursorReset?: true;
}
interface CloudRecord { kind: Kind; id: string; version: string; data: Bookmark | BookmarkList }

interface Outgoing {
  kind: Kind;
  id: string; // remote id
  localId: string;
  baseVersion: string | null;
  data: Bookmark | BookmarkList; // remote-id form, sent over the wire
  fingerprint: string; // canonical hash of the LOCAL-id-form record
  stamp: string;
}

const keyOf = (kind: Kind, id: string) => `${kind}:${id}`;
const emptyState = (): SyncState => ({
  cursor: "0",
  versions: {},
  fingerprints: {},
  hashCache: {},
  idMap: {},
  rejected: {},
});

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function fingerprintOf(value: unknown): Promise<string> {
  return sha256Hex(canonicalJson(value));
}
// Pre-fix hashing scheme, kept only to detect (and migrate away from) old
// fingerprints — Postgres jsonb reorders object keys, so this comparison was
// always spuriously false against server data.
async function legacyFingerprintOf(value: unknown): Promise<string> {
  return sha256Hex(JSON.stringify(value));
}
function stampOf(record: { updatedAt?: string; deletedAt?: string | null }): string {
  return `${record.updatedAt ?? ""}|${record.deletedAt ?? ""}`;
}
function isDeletedRecord(record: { deletedAt?: string | null }): boolean {
  return record.deletedAt !== undefined && record.deletedAt !== null;
}
function isMissingRecord(record: { version: string | null; data: unknown }): boolean {
  if (record.version === null || record.version === "0") return true;
  if (!record.data || typeof record.data !== "object") return true;
  return Object.keys(record.data as object).length === 0;
}
function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}
function isNavigatorOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}
const SYNCING_STALE_MS = 2 * 60 * 1000;
function isSyncingFresh(startedAt: string | null | undefined): boolean {
  if (!startedAt) return false;
  const started = Date.parse(startedAt);
  if (Number.isNaN(started)) return false;
  return Date.now() - started < SYNCING_STALE_MS;
}

// -- one-time legacy-key migration -----------------------------------------

// Each call re-checks (cheap: a handful of point reads) rather than
// memoizing "already migrated" — the ns keys themselves are the real,
// persistent guard (see migrateLegacyMeta), so this stays correct even if
// the underlying store is swapped out from under a live module instance
// (as tests do via NookDB._resetForTests()).
function ensureMigrated(): Promise<void> {
  return migrateLegacyMeta();
}

async function migrateLegacyMeta(): Promise<void> {
  const [nsToken, nsOwner, nsState, legacyToken, legacyOwner, legacyState] = await Promise.all([
    NookDB.getMeta<string>(tokenKey()),
    NookDB.getMeta<string>(ownerKey()),
    NookDB.getMeta<SyncState>(stateKey()),
    NookDB.getMeta<string>(LEGACY_TOKEN_KEY),
    NookDB.getMeta<string>(LEGACY_OWNER_KEY),
    NookDB.getMeta<SyncState>(LEGACY_STATE_KEY),
  ]);
  const writes: Array<Promise<unknown>> = [];
  if (nsToken === undefined && legacyToken !== undefined) {
    writes.push(NookDB.setMeta(tokenKey(), legacyToken), NookDB.setMeta(LEGACY_TOKEN_KEY, null));
  }
  if (nsOwner === undefined && legacyOwner !== undefined) {
    writes.push(NookDB.setMeta(ownerKey(), legacyOwner), NookDB.setMeta(LEGACY_OWNER_KEY, null));
  }
  if (nsState === undefined && legacyState !== undefined) {
    writes.push(NookDB.setMeta(stateKey(), legacyState), NookDB.setMeta(LEGACY_STATE_KEY, null));
  }
  if (writes.length) await Promise.all(writes);
}

// -- state I/O --------------------------------------------------------------

async function getState(): Promise<SyncState> {
  await ensureMigrated();
  const stored = await NookDB.getMeta<Partial<SyncState>>(stateKey());
  const state: SyncState = stored
    ? {
        ...emptyState(),
        ...stored,
        versions: stored.versions ?? {},
        fingerprints: stored.fingerprints ?? {},
        hashCache: stored.hashCache ?? {},
        idMap: stored.idMap ?? {},
        rejected: stored.rejected ?? {},
      }
    : emptyState();
  return state;
}

function emitStatus() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel("nook-cloud");
  channel.postMessage({ type: "changed" });
  channel.close();
}

async function ensureDeviceId(): Promise<string> {
  let deviceId = await NookDB.getMeta<string>(DEVICE_KEY);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await NookDB.setMeta(DEVICE_KEY, deviceId);
  }
  return deviceId;
}

// -- session (bearer mode / extension) --------------------------------------

export async function cloudSession(): Promise<{ token: string; ownerId: string } | null> {
  await ensureMigrated();
  const [token, ownerId] = await Promise.all([
    NookDB.getMeta<string>(tokenKey()),
    NookDB.getMeta<string>(ownerKey()),
  ]);
  return token && ownerId ? { token, ownerId } : null;
}

export async function saveCloudSession(token: string, ownerId: string, profile?: CloudUserProfile): Promise<void> {
  await ensureMigrated();
  const previousOwner = await NookDB.getMeta<string>(ownerKey());
  if (previousOwner && previousOwner !== ownerId) {
    throw new OwnerMismatchError(
      "This browser's Nook library on this server belongs to another account. Reset cloud sync before switching accounts.",
    );
  }
  await NookDB.setMeta(ownerKey(), ownerId);
  await NookDB.setMeta(tokenKey(), token);
  if (profile) await NookDB.setMeta(userKey(), profile);
  emitStatus();
}

async function clearToken(): Promise<void> {
  await NookDB.setMeta(tokenKey(), null);
  emitStatus();
}

/** Best-effort server sign-out, then clears the local token. Library and sync state untouched. */
export async function signOutCloud(): Promise<void> {
  await ensureMigrated();
  const session = await cloudSession();
  if (session) {
    try {
      await fetch(`${cloudApiUrl()}/api/auth/sign-out`, {
        method: "POST",
        headers: { Authorization: `Bearer ${session.token}` },
      });
    } catch {
      // Best-effort — local sign-out proceeds regardless of network state.
    }
  }
  await clearToken();
}

async function clearCloudMeta(): Promise<void> {
  await Promise.all([
    NookDB.setMeta(tokenKey(), null),
    NookDB.setMeta(ownerKey(), null),
    NookDB.setMeta(userKey(), null),
    NookDB.setMeta(stateKey(), null),
    NookDB.setMeta(authExpiredKey(), null),
    NookDB.setMeta(syncingKey(), null),
  ]);
}

/** Clears token + owner + sync state for this server's namespace. Library untouched. */
export async function resetCloudSync(): Promise<void> {
  await ensureMigrated();
  await clearCloudMeta();
  emitStatus();
}

export async function cloudUser(): Promise<CloudUserProfile | null> {
  await ensureMigrated();
  const user = await NookDB.getMeta<CloudUserProfile>(userKey());
  return user ?? null;
}

// -- account binding (cookie mode / web app) ---------------------------------

/**
 * Binds this origin's local library to `profile.id`. If a different account was bound,
 * the local library and sync state are wiped first (the web copy is only a cache of the
 * account). Returns whether a wipe happened.
 */
export async function bindCloudAccount(profile: CloudUserProfile): Promise<{ wiped: boolean }> {
  await ensureMigrated();
  const previousOwner = await NookDB.getMeta<string>(ownerKey());
  const wiped = Boolean(previousOwner && previousOwner !== profile.id);
  if (wiped) await NookDB.wipeLocalLibrary();
  await NookDB.setMeta(ownerKey(), profile.id);
  await NookDB.setMeta(userKey(), profile);
  await NookDB.setMeta(authExpiredKey(), null);
  emitStatus();
  return { wiped };
}

/** Web sign-out: unbinds; with wipe (default true) clears the local library + sync state. */
export async function unbindCloudAccount(options?: { wipe?: boolean }): Promise<void> {
  await ensureMigrated();
  const wipe = options?.wipe ?? true;
  if (wipe) {
    await NookDB.wipeLocalLibrary();
  } else {
    await clearCloudMeta();
  }
  emitStatus();
}

// -- status ---------------------------------------------------------------

async function computePendingCount(
  state: SyncState,
  deviceId: string,
  bookmarks: Bookmark[],
  lists: BookmarkList[],
): Promise<number> {
  const rows: Array<{ kind: Kind; data: Bookmark | BookmarkList }> = [
    ...bookmarks.map((data) => ({ kind: "bookmark" as const, data })),
    ...lists.map((data) => ({ kind: "list" as const, data })),
  ];
  let count = 0;
  for (const row of rows) {
    const remoteId = remoteIdFor(row.kind, row.data.id, state, deviceId);
    const key = keyOf(row.kind, remoteId);
    const stamp = stampOf(row.data);
    const cached = state.hashCache[key];
    const hash = cached && cached.stamp === stamp ? cached.hash : await fingerprintOf(row.data);
    const rejectedSame = state.rejected[key] && state.rejected[key].fingerprint === hash;
    if (state.fingerprints[key] !== hash && !rejectedSame) count++;
  }
  return count;
}

export async function cloudStatus(): Promise<CloudStatus> {
  // Migrate first: the raw ownerKey()/tokenKey() reads below don't await it
  // themselves, so racing them in one Promise.all could read stale keys
  // before a legacy-key migration has written them.
  await ensureMigrated();
  const mode = cloudConfig.auth;
  const [session, ownerId, authExpired, user, state, syncingSince, deviceId, bookmarks, lists] = await Promise.all([
    mode === "bearer" ? cloudSession() : Promise.resolve(null),
    NookDB.getMeta<string>(ownerKey()),
    NookDB.getMeta<boolean>(authExpiredKey()),
    NookDB.getMeta<CloudUserProfile>(userKey()),
    getState(),
    NookDB.getMeta<string>(syncingKey()),
    ensureDeviceId(),
    NookDB.getAllBookmarks({ includeDeleted: true }),
    NookDB.getAllLists({ includeDeleted: true }),
  ]);

  // bearer: token+owner present. cookie: an account is bound and the last
  // request wasn't a 401 (authExpired).
  const signedIn = mode === "bearer" ? Boolean(session) : Boolean(ownerId) && !authExpired;

  const titleByLocalId = new Map<string, string | undefined>();
  for (const bookmark of bookmarks) titleByLocalId.set(bookmark.id, bookmark.title);
  for (const list of lists) titleByLocalId.set(list.id, list.name);

  const rejected: CloudRejected[] = Object.values(state.rejected).map((entry) => ({
    kind: entry.kind,
    id: entry.id,
    error: entry.error,
    title: titleByLocalId.get(localIdFor(entry.id, state)),
  }));

  const pendingCount = await computePendingCount(state, deviceId, bookmarks, lists);

  return {
    apiUrl: cloudApiUrl(),
    signedIn,
    ownerId: ownerId ?? undefined,
    user: user ?? undefined,
    lastSyncedAt: state.lastSyncedAt,
    lastError: state.lastError,
    offline: isNavigatorOffline() || Boolean(state.networkError),
    syncing: isSyncingFresh(syncingSince),
    pendingCount,
    rejected,
  };
}

/**
 * Calls `listener` now and whenever the status may have changed
 * (BroadcastChannel "nook-cloud" and "nook-db", window online/offline).
 * Debounced ~250 ms. Works in extension pages and in the web app; every
 * listener registration is guarded for non-browser environments (tests).
 */
export function subscribeCloudStatus(listener: (status: CloudStatus) => void): () => void {
  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = () => {
    if (disposed) return;
    cloudStatus().then((status) => {
      if (!disposed) listener(status);
    }).catch(() => {});
  };

  const scheduleEmit = () => {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      emit();
    }, 250);
  };

  const channels: BroadcastChannel[] = [];
  if (typeof BroadcastChannel !== "undefined") {
    for (const name of ["nook-cloud", "nook-db"]) {
      const channel = new BroadcastChannel(name);
      channel.onmessage = () => scheduleEmit();
      channels.push(channel);
    }
  }

  const handleOnlineChange = () => scheduleEmit();
  const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (hasWindow) {
    window.addEventListener("online", handleOnlineChange);
    window.addEventListener("offline", handleOnlineChange);
  }

  emit();

  return () => {
    disposed = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const channel of channels) channel.close();
    if (hasWindow) {
      window.removeEventListener("online", handleOnlineChange);
      window.removeEventListener("offline", handleOnlineChange);
    }
  };
}

// -- request plumbing ---------------------------------------------------

export type RequestAuth = { mode: "bearer"; token: string } | { mode: "cookie" };

/**
 * The auth a fresh authenticated call from THIS browser should use, computed
 * exactly the way `syncCloud()` computes it for `/api/sync` above: bearer mode
 * reads the stored token, cookie mode just confirms an account is bound (the
 * browser sends the session cookie itself, so there is no token to read).
 * `null` means there is no request worth sending — signed out in bearer mode,
 * or no account ever connected in cookie mode.
 *
 * Exported so other host-agnostic modules (lib/ai-settings.ts) that need to
 * call a Nook route from code shared between the extension and the web app
 * don't each re-derive the bearer/cookie branch — this is the one place that
 * reads `cloudConfig.auth`.
 */
export async function cloudRequestAuth(): Promise<RequestAuth | null> {
  if (cloudConfig.auth === "bearer") {
    const session = await cloudSession();
    return session ? { mode: "bearer", token: session.token } : null;
  }
  const boundOwner = await NookDB.getMeta<string>(ownerKey());
  return boundOwner ? { mode: "cookie" } : null;
}

async function syncRequest(auth: RequestAuth, cursor: string, changes: Outgoing[], epoch: string | undefined): Promise<SyncResponse> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const init: RequestInit = {
    method: "POST",
    headers,
    body: JSON.stringify({
      cursor,
      changes: changes.map(({ kind, id, baseVersion, data }) => ({ kind, id, baseVersion, data })),
      epoch,
    }),
  };
  if (auth.mode === "bearer") {
    headers.Authorization = `Bearer ${auth.token}`;
  } else {
    init.credentials = "include";
  }
  const response = await fetch(`${cloudApiUrl()}/api/sync`, init);
  if (response.status === 401) {
    if (auth.mode === "bearer") {
      await clearToken();
    } else {
      // Cookie mode: the session cookie expired or was revoked. Don't wipe —
      // the account is still bound, just not currently authenticated; a
      // fresh bindCloudAccount() (re-sign-in) clears this.
      await NookDB.setMeta(authExpiredKey(), true);
      emitStatus();
    }
    throw new Error("Session expired. Sign in again.");
  }
  if (response.status === 413) throw new TooLargeError("Payload too large");
  if (!response.ok) throw new Error(`Cloud sync failed (${response.status})`);
  return response.json() as Promise<SyncResponse>;
}

interface RetryResult {
  response: SyncResponse;
  forcedRejections: RejectedEntry[];
  /** Size of the batch that actually made it into the successful request (after any halving). */
  sentCount: number;
}

// On 413, halve the batch and retry; a single record that still 413s is
// marked rejected (never retried until its content changes) instead of
// blocking every other record behind it forever.
async function sendWithRetry(auth: RequestAuth, cursor: string, pending: Outgoing[], epoch: string | undefined): Promise<RetryResult> {
  let batch = pending;
  const forcedRejections: RejectedEntry[] = [];
  for (;;) {
    try {
      const response = await syncRequest(auth, cursor, batch, epoch);
      return { response, forcedRejections, sentCount: batch.length };
    } catch (error) {
      if (error instanceof TooLargeError && batch.length > 1) {
        batch = batch.slice(0, Math.ceil(batch.length / 2));
        continue;
      }
      if (error instanceof TooLargeError && batch.length === 1) {
        const only = batch[0];
        forcedRejections.push({ kind: only.kind, id: only.id, fingerprint: only.fingerprint, error: "Too large for the server" });
        batch = [];
        continue;
      }
      throw error;
    }
  }
}

function localIdFor(remoteId: string, state: SyncState): string {
  const entry = Object.entries(state.idMap).find(([, cloudId]) => cloudId === remoteId);
  return entry?.[0] ?? remoteId;
}

// Chrome's numeric bookmark IDs are scoped to one browser profile.
function remoteIdFor(kind: Kind, localId: string, state: SyncState, deviceId: string): string {
  if (kind === "bookmark" && /^chrome:\d+$/.test(localId)) {
    return (state.idMap[localId] ??= `chrome:${deviceId}:${localId.slice(7)}`);
  }
  return localId;
}

// One-time migration off the pre-fix (JSON.stringify-based) fingerprint
// scheme: for each local row, if its stored fingerprint matches the legacy
// hash, swap in the canonical hash so the switch doesn't look like every
// record changed (which would re-upload the whole library).
async function migrateFingerprintFormat(state: SyncState, deviceId: string): Promise<void> {
  if (state.format === 2) return;
  const [bookmarks, lists] = await Promise.all([
    NookDB.getAllBookmarks({ includeDeleted: true }),
    NookDB.getAllLists({ includeDeleted: true }),
  ]);
  const rows: Array<{ kind: Kind; data: Bookmark | BookmarkList }> = [
    ...bookmarks.map((data) => ({ kind: "bookmark" as const, data })),
    ...lists.map((data) => ({ kind: "list" as const, data })),
  ];
  for (const row of rows) {
    const remoteId = remoteIdFor(row.kind, row.data.id, state, deviceId);
    const key = keyOf(row.kind, remoteId);
    const stored = state.fingerprints[key];
    if (!stored) continue;
    const legacyHash = await legacyFingerprintOf(row.data);
    if (stored === legacyHash) {
      state.fingerprints[key] = await fingerprintOf(row.data);
    }
  }
  state.format = 2;
  await NookDB.setMeta(stateKey(), state);
}

// One-time migration off manual conflict resolution: any conflict a
// pre-automatic-merge build left in state.conflicts is merged the same way
// a live conflict is (see resolvePageConflict) — written locally raw and
// left dirty so the main loop below re-uploads it with the new baseVersion
// in this same run — then the field itself is dropped for good.
async function migrateLegacyConflicts(state: SyncState): Promise<void> {
  const legacyConflicts = state.conflicts;
  if (!legacyConflicts) return;
  const keys = Object.keys(legacyConflicts);
  if (keys.length > 0) {
    const [bookmarks, lists] = await Promise.all([
      NookDB.getAllBookmarks({ includeDeleted: true }),
      NookDB.getAllLists({ includeDeleted: true }),
    ]);
    const byKey = new Map<string, Bookmark | BookmarkList>();
    for (const bookmark of bookmarks) byKey.set(keyOf("bookmark", bookmark.id), bookmark);
    for (const list of lists) byKey.set(keyOf("list", list.id), list);

    const bookmarksToWrite: Bookmark[] = [];
    const listsToWrite: BookmarkList[] = [];
    for (const key of keys) {
      const stored = legacyConflicts[key];
      if (!stored || isMissingRecord(stored)) continue;
      const localId = localIdFor(stored.id, state);
      const local = byKey.get(keyOf(stored.kind, localId));
      if (!local) continue; // local record no longer exists — nothing to merge
      const write = await resolvePageConflict({
        kind: stored.kind,
        key,
        localId,
        local,
        remoteRaw: stored.data,
        remoteVersion: stored.version,
        state,
      });
      if (stored.kind === "bookmark") bookmarksToWrite.push(write.data as Bookmark);
      else listsToWrite.push(write.data as BookmarkList);
    }
    if (bookmarksToWrite.length || listsToWrite.length) {
      await NookDB.applyRemoteRecords(bookmarksToWrite, listsToWrite);
    }
  }
  delete state.conflicts;
  await NookDB.setMeta(stateKey(), state);
}

// -- automatic conflict resolution (shared by upload conflicts, downloaded
// changes that hit a locally-dirty record, and the legacy-conflict
// migration above) -----------------------------------------------------

/**
 * Every conflict auto-merges — there is no manual resolution path anymore.
 * The cheap rules run first (identical ignoring timestamps, or both sides
 * deleted ⇒ just accept the server's copy without a merge); anything else
 * goes through mergeBookmarks/mergeLists (newer wins field-wise) and is
 * written back locally raw, left dirty so it re-uploads with the server's
 * version as its baseVersion in this same sync run.
 */
async function resolvePageConflict(opts: {
  kind: Kind;
  key: string;
  localId: string;
  local: Bookmark | BookmarkList;
  remoteRaw: Bookmark | BookmarkList; // as received from the server (remote id)
  remoteVersion: string;
  state: SyncState;
}): Promise<{ localId: string; data: Bookmark | BookmarkList; dirty: boolean }> {
  const { kind, key, localId, local, remoteRaw, remoteVersion, state } = opts;
  const remoteData = { ...remoteRaw, id: localId } as Bookmark | BookmarkList;

  const accept = sameRecordIgnoringTimestamps(local, remoteData) || (isDeletedRecord(local) && isDeletedRecord(remoteData));
  if (accept) {
    state.versions[key] = remoteVersion;
    const hash = await fingerprintOf(remoteData);
    state.fingerprints[key] = hash;
    state.hashCache[key] = { stamp: stampOf(remoteData), hash };
    return { localId, data: remoteData, dirty: false };
  }

  const merged = kind === "bookmark"
    ? mergeBookmarks(local as Bookmark, remoteData as Bookmark)
    : mergeLists(local as BookmarkList, remoteData as BookmarkList);
  state.versions[key] = remoteVersion;
  // Leave it dirty (no fingerprint) so it uploads with this baseVersion on the next page.
  delete state.fingerprints[key];
  delete state.hashCache[key];
  return { localId, data: merged, dirty: true };
}

/** Returns true when it wrote anything (the writes are local edits that still need uploading). */
async function dedupeUrlDuplicates(touchedLocalIds: Set<string>): Promise<boolean> {
  if (touchedLocalIds.size === 0) return false;
  let wrote = false;
  const all = await NookDB.getAllBookmarks({ includeDeleted: false });
  const byUrlKey = new Map<string, Bookmark[]>();
  for (const bookmark of all) {
    if (!bookmark.urlKey) continue;
    const group = byUrlKey.get(bookmark.urlKey);
    if (group) group.push(bookmark);
    else byUrlKey.set(bookmark.urlKey, [bookmark]);
  }
  for (const group of byUrlKey.values()) {
    if (group.length < 2) continue;
    if (!group.some((bookmark) => touchedLocalIds.has(bookmark.id))) continue;
    const plan = planUrlDuplicateMerge(group);
    // `changed` only says whether the survivor absorbed user data; the
    // duplicates go either way (identical copies are the common case).
    if (plan.changed) await NookDB.updateBookmark(plan.survivor.id, plan.survivor);
    for (const duplicateId of plan.duplicateIds) {
      await NookDB.softDeleteBookmark(duplicateId);
    }
    wrote = true;
  }
  return wrote;
}

// -- main sync loop -----------------------------------------------------

export async function syncCloud(): Promise<{ uploaded: number; downloaded: number; rejected: number } | null> {
  const mode = cloudConfig.auth;
  let auth: RequestAuth;
  if (mode === "bearer") {
    const session = await cloudSession();
    if (!session) return null;
    auth = { mode: "bearer", token: session.token };
  } else {
    const boundOwner = await NookDB.getMeta<string>(ownerKey());
    if (!boundOwner) return null;
    auth = { mode: "cookie" };
  }

  await NookDB.ready();
  const state = await getState();
  const deviceId = await ensureDeviceId();
  await migrateFingerprintFormat(state, deviceId);
  await migrateLegacyConflicts(state);

  let uploaded = 0;
  let downloadedTotal = 0;
  let resetUsed = false;
  const BATCH_CAP = 100;

  await NookDB.setMeta(syncingKey(), new Date().toISOString());
  emitStatus();

  try {
    for (let page = 0; page < 30; page++) {
      const [bookmarks, lists] = await Promise.all([
        NookDB.getAllBookmarks({ includeDeleted: true }),
        NookDB.getAllLists({ includeDeleted: true }),
      ]);
      const localRows: Array<{ kind: Kind; data: Bookmark | BookmarkList }> = [
        ...bookmarks.map((data) => ({ kind: "bookmark" as const, data })),
        ...lists.map((data) => ({ kind: "list" as const, data })),
      ];

      const currentByCloudKey = new Map<string, { localId: string; data: Bookmark | BookmarkList; hash: string }>();
      const pending: Outgoing[] = [];
      for (const row of localRows) {
        const localId = row.data.id;
        const remoteId = remoteIdFor(row.kind, localId, state, deviceId);
        const key = keyOf(row.kind, remoteId);
        const stamp = stampOf(row.data);
        const cached = state.hashCache[key];
        const hash = cached && cached.stamp === stamp ? cached.hash : await fingerprintOf(row.data);
        if (!cached || cached.stamp !== stamp) state.hashCache[key] = { stamp, hash };
        currentByCloudKey.set(key, { localId, data: row.data, hash });

        const rejectedSame = state.rejected[key] && state.rejected[key].fingerprint === hash;
        const dirty = state.fingerprints[key] !== hash;
        if (!dirty || rejectedSame) continue;
        if (pending.length < BATCH_CAP) {
          pending.push({
            kind: row.kind,
            id: remoteId,
            localId,
            baseVersion: state.versions[key] ?? null,
            data: { ...row.data, id: remoteId },
            fingerprint: hash,
            stamp,
          });
        }
      }

      const { response, forcedRejections, sentCount } = await sendWithRetry(auth, state.cursor, pending, state.epoch);
      for (const rejection of forcedRejections) {
        state.rejected[keyOf(rejection.kind, rejection.id)] = rejection;
      }
      // 413 halving can leave some of this page's dirty records unsent
      // (neither applied, conflicted, nor rejected) — they need another
      // page immediately rather than waiting for the next scheduled sync.
      let mustContinue = pending.length > forcedRejections.length + sentCount;

      if (response.cursorReset) {
        if (resetUsed) throw new Error("Cloud sync epoch changed again mid-sync; try again.");
        resetUsed = true;
        state.cursor = "0";
        state.versions = {};
        state.fingerprints = {};
        state.hashCache = {};
        state.rejected = {};
        state.epoch = response.epoch;
        state.format = 2;
        await NookDB.setMeta(stateKey(), state);
        emitStatus();
        continue;
      }

      const pendingByKey = new Map(pending.map((item) => [keyOf(item.kind, item.id), item]));
      const handledKeys = new Set<string>();
      const bookmarksToWrite: Bookmark[] = [];
      const listsToWrite: BookmarkList[] = [];
      const downloadedLocalIds = new Set<string>();

      for (const record of response.applied) {
        const key = keyOf(record.kind, record.id);
        const sent = pendingByKey.get(key);
        if (!sent) continue;
        state.versions[key] = record.version;
        state.fingerprints[key] = sent.fingerprint;
        state.hashCache[key] = { stamp: sent.stamp, hash: sent.fingerprint };
        delete state.rejected[key];
        handledKeys.add(key);
        uploaded++;
      }

      for (const item of response.rejected) {
        const kind = item.kind as Kind;
        const key = keyOf(kind, item.id);
        if (handledKeys.has(key)) continue;
        const sent = pendingByKey.get(key);
        if (!sent) continue;
        state.rejected[key] = { kind, id: item.id, error: item.error, fingerprint: sent.fingerprint };
        handledKeys.add(key);
      }

      for (const record of response.conflicts) {
        const key = keyOf(record.kind, record.id);
        if (handledKeys.has(key)) continue;
        const sent = pendingByKey.get(key);
        if (!sent) continue;
        handledKeys.add(key);

        // The record doesn't exist on the server (e.g. restored from an
        // older backup) — not a real conflict. Forget bookkeeping so it
        // re-uploads with baseVersion null on the next page.
        if (isMissingRecord(record)) {
          delete state.versions[key];
          delete state.fingerprints[key];
          delete state.hashCache[key];
          mustContinue = true;
          continue;
        }
        const localCurrent = currentByCloudKey.get(key);
        if (!localCurrent || !record.data) continue;
        const write = await resolvePageConflict({
          kind: record.kind,
          key,
          localId: localCurrent.localId,
          local: localCurrent.data,
          remoteRaw: record.data,
          remoteVersion: record.version as string,
          state,
        });
        if (record.kind === "bookmark") { bookmarksToWrite.push(write.data as Bookmark); downloadedLocalIds.add(write.localId); }
        else listsToWrite.push(write.data as BookmarkList);
        if (write.dirty) mustContinue = true;
      }

      for (const record of response.changes) {
        const key = keyOf(record.kind, record.id);
        if (handledKeys.has(key)) continue;
        handledKeys.add(key);
        const localCurrent = currentByCloudKey.get(key);
        const isDirty = Boolean(localCurrent) && state.fingerprints[key] !== localCurrent!.hash;

        if (localCurrent && isDirty) {
          const write = await resolvePageConflict({
            kind: record.kind,
            key,
            localId: localCurrent.localId,
            local: localCurrent.data,
            remoteRaw: record.data,
            remoteVersion: record.version,
            state,
          });
          if (record.kind === "bookmark") { bookmarksToWrite.push(write.data as Bookmark); downloadedLocalIds.add(write.localId); }
          else listsToWrite.push(write.data as BookmarkList);
          if (write.dirty) mustContinue = true;
          continue;
        }

        const localId = localCurrent ? localCurrent.localId : localIdFor(record.id, state);
        const localized = { ...record.data, id: localId } as Bookmark | BookmarkList;
        state.versions[key] = record.version;
        const hash = await fingerprintOf(localized);
        state.fingerprints[key] = hash;
        state.hashCache[key] = { stamp: stampOf(localized), hash };
        if (record.kind === "bookmark") { bookmarksToWrite.push(localized as Bookmark); downloadedLocalIds.add(localId); }
        else listsToWrite.push(localized as BookmarkList);
      }

      downloadedTotal += bookmarksToWrite.length + listsToWrite.length;
      await NookDB.applyRemoteRecords(bookmarksToWrite, listsToWrite);
      // The same URL saved on two devices before they ever synced can land
      // as two live bookmarks once one device's copy arrives here.
      if (await dedupeUrlDuplicates(downloadedLocalIds)) mustContinue = true;

      state.cursor = response.cursor;
      state.epoch = response.epoch;
      state.format = 2;
      state.lastSyncedAt = new Date().toISOString();
      state.networkError = false;
      delete state.lastError;
      await NookDB.setMeta(stateKey(), state);
      emitStatus();

      if (!response.hasMore && pending.length < BATCH_CAP && !mustContinue) break;
    }
  } catch (error) {
    if (isNetworkError(error)) {
      state.networkError = true;
    } else {
      state.lastError = error instanceof Error ? error.message : String(error);
      state.networkError = false;
    }
    await NookDB.setMeta(stateKey(), state);
    emitStatus();
    throw error;
  } finally {
    await NookDB.setMeta(syncingKey(), null);
    emitStatus();
  }

  return {
    uploaded,
    downloaded: downloadedTotal,
    rejected: Object.keys(state.rejected).length,
  };
}
