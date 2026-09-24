/**
 * Drives automatic background sync in a page context (the web app). The
 * extension has its own equivalent — a chrome.alarms-driven periodic sync
 * plus a serial task queue in entrypoints/background/index.ts — because a
 * service worker has no `document`/`window`/BroadcastChannel-across-reloads
 * story the way a page does; this module is deliberately independent of
 * that one so neither has to special-case the other's environment.
 */
import { createJoinable, createTaskQueue, syncCloud } from "./cloud-sync";

export interface AutoSyncHandle {
  /** Runs a sync now (joining one already in flight) and resolves when it finishes. Never rejects. */
  requestSync(): Promise<void>;
  /** Removes every listener and timer this handle registered. Idempotent. */
  stop(): void;
}

export interface AutoSyncOptions {
  /** Delay after a local write (BroadcastChannel "nook-db") before syncing. Default 1500ms. */
  debounceMs?: number;
  /** Periodic sync interval while the page is visible. Default 30s. */
  visibleIntervalMs?: number;
  /** Periodic sync interval while the page is hidden. Default 5min. */
  hiddenIntervalMs?: number;
}

const DEFAULT_DEBOUNCE_MS = 1500;
const DEFAULT_VISIBLE_INTERVAL_MS = 30_000;
const DEFAULT_HIDDEN_INTERVAL_MS = 5 * 60_000;
// Not specified by the product contract beyond "cap 5 min" — doubling from a
// 5s base lands on a handful of retries before hitting the cap, which is a
// reasonable recovery curve for a page that just went offline.
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_CAP_MS = 5 * 60_000;
const LOCK_NAME = "nook-cloud-sync";
const DB_CHANNEL = "nook-db";

function isNetworkError(error: unknown): boolean {
  return error instanceof TypeError;
}

function hasLocks(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
}

function isHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Starts automatic sync for the current page: an immediate run, a debounced
 * run after local writes, runs on `online`/visibility-becomes-visible/window
 * focus, and a periodic run every `visibleIntervalMs`/`hiddenIntervalMs`
 * depending on page visibility. Serialized across tabs with navigator.locks
 * when available, and always serialized within this page via a task queue
 * (so triggers firing close together join one run instead of racing).
 * Network errors back off exponentially (capped at 5 minutes), reset on a
 * successful run or an `online` event. No trigger path ever throws — every
 * failure is swallowed here and surfaces through cloudStatus() instead.
 */
export function startAutoSync(options: AutoSyncOptions = {}): AutoSyncHandle {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const visibleIntervalMs = options.visibleIntervalMs ?? DEFAULT_VISIBLE_INTERVAL_MS;
  const hiddenIntervalMs = options.hiddenIntervalMs ?? DEFAULT_HIDDEN_INTERVAL_MS;

  let stopped = false;
  let backoffMs = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setTimeout> | null = null;

  const queue = createTaskQueue();

  async function runLocked(): Promise<void> {
    const attempt = async () => {
      try {
        await syncCloud();
        backoffMs = 0;
      } catch (error) {
        backoffMs = isNetworkError(error) ? (backoffMs === 0 ? BACKOFF_BASE_MS : Math.min(backoffMs * 2, BACKOFF_CAP_MS)) : 0;
      }
    };
    if (hasLocks()) {
      try {
        await navigator.locks.request(LOCK_NAME, attempt);
        return;
      } catch {
        // Locks API present but the request itself failed (e.g. torn down
        // context) — fall back to an unlocked attempt rather than losing the run.
      }
    }
    await attempt();
  }

  // Every call joins whichever run is currently queued-or-in-flight, so
  // concurrent triggers (a DB write mid-interval-tick, a focus event during
  // an already-running sync, ...) never start a second overlapping run.
  const runJoined = createJoinable(queue, runLocked);

  function currentIntervalMs(): number {
    return isHidden() ? hiddenIntervalMs : visibleIntervalMs;
  }

  function scheduleNext(): void {
    if (stopped) return;
    if (intervalTimer) clearTimeout(intervalTimer);
    const delay = backoffMs > 0 ? backoffMs : currentIntervalMs();
    intervalTimer = setTimeout(trigger, delay);
  }

  function trigger(): void {
    if (stopped) return;
    runJoined()
      .catch(() => {}) // runLocked never rejects, but stay defensive — triggers never throw.
      .finally(() => scheduleNext());
  }

  function debouncedTrigger(): void {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      trigger();
    }, debounceMs);
  }

  // -- triggers -------------------------------------------------------

  let dbChannel: BroadcastChannel | null = null;
  if (typeof BroadcastChannel !== "undefined") {
    dbChannel = new BroadcastChannel(DB_CHANNEL);
    dbChannel.onmessage = () => debouncedTrigger();
  }

  const handleOnline = () => {
    backoffMs = 0;
    trigger();
  };
  const handleVisibility = () => {
    if (!isHidden()) trigger();
    else scheduleNext();
  };
  const handleFocus = () => trigger();

  const hasWindow = typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (hasWindow) {
    window.addEventListener("online", handleOnline);
    window.addEventListener("focus", handleFocus);
  }
  const hasDocument = typeof document !== "undefined" && typeof document.addEventListener === "function";
  if (hasDocument) {
    document.addEventListener("visibilitychange", handleVisibility);
  }

  // Immediate first run, then the periodic cadence takes over.
  trigger();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (intervalTimer) clearTimeout(intervalTimer);
    if (dbChannel) dbChannel.close();
    if (hasWindow) {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("focus", handleFocus);
    }
    if (hasDocument) {
      document.removeEventListener("visibilitychange", handleVisibility);
    }
  }

  return {
    requestSync: () => runJoined(),
    stop,
  };
}
