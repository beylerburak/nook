// @vitest-environment happy-dom
//
// happy-dom gives us window/document/BroadcastChannel so the online/focus/
// visibilitychange triggers can be exercised with real DOM events. Its
// navigator.locks is present but non-functional (locks.request is
// undefined), which is actually useful here: it exercises cloud-runner's
// "navigator.locks unavailable -> in-page queue" fallback path the same way
// an older browser would.
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const { syncCloudMock } = vi.hoisted(() => ({ syncCloudMock: vi.fn() }));

vi.mock("../lib/cloud-sync", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/cloud-sync")>();
  return { ...actual, syncCloud: syncCloudMock };
});

import { startAutoSync } from "../lib/cloud-runner";

beforeEach(() => {
  vi.useFakeTimers();
  syncCloudMock.mockReset();
  syncCloudMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

test("runs a sync immediately on start", async () => {
  const handle = startAutoSync();
  await vi.advanceTimersByTimeAsync(0);
  expect(syncCloudMock).toHaveBeenCalledTimes(1);
  handle.stop();
});

test("debounces repeated nook-db writes into a single extra run", async () => {
  const handle = startAutoSync({ debounceMs: 200, visibleIntervalMs: 999_000, hiddenIntervalMs: 999_000 });
  await vi.advanceTimersByTimeAsync(0); // immediate run
  expect(syncCloudMock).toHaveBeenCalledTimes(1);

  const channel = new BroadcastChannel("nook-db");
  channel.postMessage({ type: "changed" });
  await vi.advanceTimersByTimeAsync(50);
  channel.postMessage({ type: "changed" }); // resets the debounce window
  await vi.advanceTimersByTimeAsync(50);
  channel.postMessage({ type: "changed" }); // resets it again
  await vi.advanceTimersByTimeAsync(190); // 190ms since the last message — still short of 200ms
  expect(syncCloudMock).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(20); // now past 200ms since the last message
  expect(syncCloudMock).toHaveBeenCalledTimes(2); // exactly one extra run, not three

  channel.close();
  handle.stop();
});

test("syncs on the visible interval after the immediate run finishes", async () => {
  const handle = startAutoSync({ debounceMs: 999_000, visibleIntervalMs: 1000, hiddenIntervalMs: 999_000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(syncCloudMock).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(999);
  expect(syncCloudMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(2);
  expect(syncCloudMock).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(1000);
  expect(syncCloudMock).toHaveBeenCalledTimes(3);

  handle.stop();
});

test("visibilitychange and window focus trigger a sync", async () => {
  const handle = startAutoSync({ debounceMs: 999_000, visibleIntervalMs: 999_000, hiddenIntervalMs: 999_000 });
  await vi.advanceTimersByTimeAsync(0);
  expect(syncCloudMock).toHaveBeenCalledTimes(1);

  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(syncCloudMock).toHaveBeenCalledTimes(2);

  window.dispatchEvent(new Event("focus"));
  await vi.advanceTimersByTimeAsync(0);
  expect(syncCloudMock).toHaveBeenCalledTimes(3);

  handle.stop();
});

test("exponential backoff after network errors, reset by the next success", async () => {
  syncCloudMock.mockRejectedValue(new TypeError("network down"));
  const handle = startAutoSync({ debounceMs: 999_000, visibleIntervalMs: 999_000, hiddenIntervalMs: 999_000 });

  await vi.advanceTimersByTimeAsync(0); // attempt 1 fails -> backoff becomes 5s
  expect(syncCloudMock).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(4999);
  expect(syncCloudMock).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1); // 5s elapsed -> attempt 2 fails -> backoff becomes 10s
  expect(syncCloudMock).toHaveBeenCalledTimes(2);

  await vi.advanceTimersByTimeAsync(9999);
  expect(syncCloudMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1); // 10s elapsed -> attempt 3 fails -> backoff becomes 20s
  expect(syncCloudMock).toHaveBeenCalledTimes(3);

  // A success resets the backoff — the next run waits the full (long) interval, not another short backoff delay.
  syncCloudMock.mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(syncCloudMock).toHaveBeenCalledTimes(4);

  await vi.advanceTimersByTimeAsync(998_999);
  expect(syncCloudMock).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1);
  expect(syncCloudMock).toHaveBeenCalledTimes(5);

  handle.stop();
});

test("backoff is capped at 5 minutes", async () => {
  syncCloudMock.mockRejectedValue(new TypeError("network down"));
  const handle = startAutoSync({ debounceMs: 999_000, visibleIntervalMs: 999_000, hiddenIntervalMs: 999_000 });
  await vi.advanceTimersByTimeAsync(0); // attempt 1
  let calls = 1;
  expect(syncCloudMock).toHaveBeenCalledTimes(calls);

  // Doubling from 5s exceeds the 5-minute cap within a handful of retries.
  let delay = 5_000;
  for (let i = 0; i < 7; i++) {
    await vi.advanceTimersByTimeAsync(delay);
    calls++;
    expect(syncCloudMock).toHaveBeenCalledTimes(calls);
    delay = Math.min(delay * 2, 300_000);
  }
  expect(delay).toBe(300_000); // confirms the cap was reached

  // The retry after hitting the cap must wait exactly 5 minutes, not longer.
  await vi.advanceTimersByTimeAsync(299_999);
  expect(syncCloudMock).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(1);
  expect(syncCloudMock).toHaveBeenCalledTimes(calls + 1);

  handle.stop();
});

test("an online event resets backoff and triggers a sync immediately", async () => {
  syncCloudMock.mockRejectedValue(new TypeError("network down"));
  const handle = startAutoSync({ debounceMs: 999_000, visibleIntervalMs: 999_000, hiddenIntervalMs: 999_000 });
  await vi.advanceTimersByTimeAsync(0); // fails, backoff -> 5s
  expect(syncCloudMock).toHaveBeenCalledTimes(1);

  syncCloudMock.mockResolvedValue(undefined);
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(syncCloudMock).toHaveBeenCalledTimes(2); // immediate, not waiting for the 5s backoff

  // Backoff is 0 again after the online-triggered success — next run waits the full interval.
  await vi.advanceTimersByTimeAsync(998_999);
  expect(syncCloudMock).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(syncCloudMock).toHaveBeenCalledTimes(3);

  handle.stop();
});

test("requestSync() resolves when the run finishes and joins an already in-flight run", async () => {
  let resolveSync: (() => void) | null = null;
  syncCloudMock.mockImplementation(
    () => new Promise<void>((resolve) => { resolveSync = () => resolve(undefined); }),
  );

  const handle = startAutoSync({ debounceMs: 999_000, visibleIntervalMs: 999_000, hiddenIntervalMs: 999_000 });
  await vi.advanceTimersByTimeAsync(0); // immediate run now in flight
  expect(syncCloudMock).toHaveBeenCalledTimes(1);

  let resolved = false;
  const requestPromise = handle.requestSync().then(() => { resolved = true; });
  await vi.advanceTimersByTimeAsync(0);
  expect(resolved).toBe(false); // still waiting on the in-flight run
  expect(syncCloudMock).toHaveBeenCalledTimes(1); // joined it, no second call

  resolveSync!();
  await requestPromise;
  expect(resolved).toBe(true);

  handle.stop();
});

test("requestSync() never rejects even when the sync attempt fails", async () => {
  syncCloudMock.mockRejectedValue(new Error("boom"));
  const handle = startAutoSync({ debounceMs: 999_000, visibleIntervalMs: 999_000, hiddenIntervalMs: 999_000 });
  await vi.advanceTimersByTimeAsync(0);
  await expect(handle.requestSync()).resolves.toBeUndefined();
  handle.stop();
});

test("stop() removes every listener and timer", async () => {
  const handle = startAutoSync({ debounceMs: 50, visibleIntervalMs: 1000, hiddenIntervalMs: 1000 });
  await vi.advanceTimersByTimeAsync(0);
  const callsAtStop = syncCloudMock.mock.calls.length;

  handle.stop();

  const channel = new BroadcastChannel("nook-db");
  channel.postMessage({ type: "changed" });
  window.dispatchEvent(new Event("online"));
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(5000); // well past debounce + interval

  expect(syncCloudMock.mock.calls.length).toBe(callsAtStop);
  channel.close();
});
