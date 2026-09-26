// Settings are an account preference now (docs/ai.md, "Settings surface"):
// `loadAiSettings`/`saveAiSettings` talk to GET/PUT /api/ai/settings rather
// than an IndexedDB `meta` key. This file covers the client half of that —
// the fetch, the offline/signed-out fallback to the local cache, and the
// short-lived in-memory cache the default (no-deps) path keeps so a burst of
// calls (e.g. `aiIsArmable()` in entrypoints/background/index.ts, once per
// saved bookmark) doesn't turn into one request each.
import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  AI_SETTINGS_META_KEY,
  DEFAULT_AI_SETTINGS,
  _resetAiSettingsCacheForTests,
  loadAiSettings,
  saveAiSettings,
  subscribeToAiSettings,
  type AiSettings,
} from "../lib/ai-settings";
import { DEFAULT_CLOUD_API_URL, configureCloud, saveCloudSession, type RequestAuth } from "../lib/cloud-sync";
import * as NookDB from "../lib/db";

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Stands in for GET/PUT {apiUrl}/api/ai/settings. */
class MockSettingsServer {
  requests: Array<{ method: string; body: unknown; authorization: string | null }> = [];
  stored: AiSettings = { ...DEFAULT_AI_SETTINGS };
  /** Forced status/throw for the next request; consumed once. */
  once: { status?: number; throws?: unknown } | null = null;

  fetch = async (_input: string, init: RequestInit): Promise<Response> => {
    const method = init.method ?? "GET";
    const authorization = (init.headers as Record<string, string> | undefined)?.Authorization ?? null;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    this.requests.push({ method, body, authorization });

    if (this.once?.throws !== undefined) {
      const throws = this.once.throws;
      this.once = null;
      throw throws;
    }
    if (this.once?.status !== undefined) {
      const status = this.once.status;
      this.once = null;
      return json({ error: "nope" }, status);
    }
    if (method === "PUT") this.stored = { ...this.stored, ...(body as Partial<AiSettings>) };
    return json(this.stored);
  };
}

let server: MockSettingsServer;
let clock: number;

/** fake-indexeddb resolves over a variable number of microtasks (see the same
 *  pattern in settings-ai-panel.test.tsx), so a fixed `await Promise.resolve()`
 *  count is not reliable — wait for an actual store round trip instead. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await NookDB.getMeta("ai-settings-test.settle-probe");
  }
}

function bearerAuth(): () => Promise<RequestAuth | null> {
  return async () => ({ mode: "bearer", token: "test-token" });
}

beforeEach(async () => {
  NookDB._resetForTests();
  await NookDB.ready();
  _resetAiSettingsCacheForTests();
  clock = BASE_TIME;
  server = new MockSettingsServer();
});

afterEach(() => {
  vi.unstubAllGlobals();
  configureCloud({ apiUrl: DEFAULT_CLOUD_API_URL, auth: "bearer" });
});

function deps(overrides: Partial<Parameters<typeof loadAiSettings>[0]> = {}) {
  return {
    fetch: server.fetch,
    requestAuth: bearerAuth(),
    apiUrl: DEFAULT_CLOUD_API_URL,
    now: () => clock,
    ...overrides,
  };
}

describe("loadAiSettings", () => {
  test("fetches the account's settings from the server", async () => {
    server.stored = { ...DEFAULT_AI_SETTINGS, autoClassify: true, maxTags: 5 };
    const result = await loadAiSettings(deps());
    expect(result).toEqual(server.stored);
    expect(server.requests).toEqual([{ method: "GET", body: undefined, authorization: "Bearer test-token" }]);
  });

  test("normalizes a garbled body into complete, in-range defaults", async () => {
    server.fetch = async () => json({ collectionMinConfidence: 7, maxTags: "nope" });
    const result = await loadAiSettings(deps());
    expect(result.collectionMinConfidence).toBe(1);
    expect(result.maxTags).toBe(DEFAULT_AI_SETTINGS.maxTags);
    expect(result.autoClassify).toBe(false);
  });

  test("no account bound (signed out) makes no request and falls back to the local cache", async () => {
    await NookDB.setMeta(AI_SETTINGS_META_KEY, { ...DEFAULT_AI_SETTINGS, autoClassify: true });
    const result = await loadAiSettings(deps({ requestAuth: async () => null }));
    expect(result.autoClassify).toBe(true);
    expect(server.requests).toHaveLength(0);
  });

  test("falls back to the local cache on a network error", async () => {
    await NookDB.setMeta(AI_SETTINGS_META_KEY, { ...DEFAULT_AI_SETTINGS, autoTaxonomy: true });
    const result = await loadAiSettings(deps({ fetch: async () => { throw new TypeError("offline"); } }));
    expect(result.autoTaxonomy).toBe(true);
  });

  test("falls back to the local cache on a 5xx", async () => {
    await NookDB.setMeta(AI_SETTINGS_META_KEY, { ...DEFAULT_AI_SETTINGS, autoSummarize: true });
    server.once = { status: 500 };
    const result = await loadAiSettings(deps());
    expect(result.autoSummarize).toBe(true);
  });

  test("falls back to the conservative defaults when there is no cache to fall back to", async () => {
    const result = await loadAiSettings(deps({ requestAuth: async () => null }));
    expect(result).toEqual(DEFAULT_AI_SETTINGS);
  });

  test("writes a successful fetch through to the local cache", async () => {
    server.stored = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    await loadAiSettings(deps());
    expect(await NookDB.getMeta(AI_SETTINGS_META_KEY)).toEqual(server.stored);
  });

  test("the default (no-deps) path caches a successful answer for a while", async () => {
    // A plain injected `now` (not fake timers): `loadAiSettings` also writes
    // through to IndexedDB on every fetch, and fake-indexeddb's own scheduling
    // does not play well with fake timers — this gets the same determinism
    // without freezing the clock IndexedDB itself relies on. `now` alone does
    // not bypass the cache (see `bypassesCache`), so this still exercises the
    // real default path other than the clock.
    await saveCloudSession("test-token", "user-1");
    server.stored = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    vi.stubGlobal("fetch", server.fetch);

    const first = await loadAiSettings({ now: () => clock });
    expect(first.autoClassify).toBe(true);

    // A second call inside the window must not fetch again, even though the
    // "server" has since changed — this is exactly what protects a burst of
    // `aiIsArmable()` calls from becoming a request each.
    server.stored = { ...DEFAULT_AI_SETTINGS, autoClassify: false };
    const second = await loadAiSettings({ now: () => clock });
    expect(second.autoClassify).toBe(true);
    expect(server.requests).toHaveLength(1);

    clock += 61_000;
    const third = await loadAiSettings({ now: () => clock });
    expect(third.autoClassify).toBe(false);
    expect(server.requests).toHaveLength(2);
  });

  test("a dep override always bypasses the cache", async () => {
    server.stored = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    await loadAiSettings(deps());
    server.stored = { ...DEFAULT_AI_SETTINGS, autoClassify: false };
    const second = await loadAiSettings(deps());
    expect(second.autoClassify).toBe(false);
    expect(server.requests).toHaveLength(2);
  });
});

describe("saveAiSettings", () => {
  test("PUTs the patch and returns what the server actually stored", async () => {
    server.stored = { ...DEFAULT_AI_SETTINGS, maxTags: 3 };
    const result = await saveAiSettings({ autoClassify: true }, deps());
    expect(result).toEqual({ ...DEFAULT_AI_SETTINGS, maxTags: 3, autoClassify: true });
    expect(server.requests[0]).toMatchObject({ method: "PUT", body: { autoClassify: true } });
  });

  test("writes the saved value through to the local cache", async () => {
    await saveAiSettings({ autoTaxonomy: true }, deps());
    expect((await NookDB.getMeta<AiSettings>(AI_SETTINGS_META_KEY))?.autoTaxonomy).toBe(true);
  });

  test("throws rather than pretending to succeed when signed out", async () => {
    await expect(saveAiSettings({ autoClassify: true }, deps({ requestAuth: async () => null }))).rejects.toThrow();
  });

  test("throws on a network failure, and leaves the local cache untouched", async () => {
    await NookDB.setMeta(AI_SETTINGS_META_KEY, { ...DEFAULT_AI_SETTINGS, autoClassify: true });
    await expect(
      saveAiSettings({ autoTaxonomy: true }, deps({ fetch: async () => { throw new TypeError("offline"); } })),
    ).rejects.toThrow();
    expect((await NookDB.getMeta<AiSettings>(AI_SETTINGS_META_KEY))?.autoClassify).toBe(true);
  });

  test("throws on a non-ok response", async () => {
    server.once = { status: 401 };
    await expect(saveAiSettings({ autoClassify: true }, deps())).rejects.toThrow();
  });
});

describe("subscribeToAiSettings", () => {
  test("emits once on subscribe with the current settings", async () => {
    server.stored = { ...DEFAULT_AI_SETTINGS, autoClassify: true };
    vi.stubGlobal("fetch", server.fetch);
    await saveCloudSession("test-token", "user-1");

    const seen: AiSettings[] = [];
    const unsubscribe = subscribeToAiSettings((settings) => seen.push(settings));
    await flush();
    unsubscribe();

    expect(seen).toHaveLength(1);
    expect(seen[0].autoClassify).toBe(true);
  });

  test("a save in this context notifies every other subscriber immediately", async () => {
    vi.stubGlobal("fetch", server.fetch);
    await saveCloudSession("test-token", "user-1");

    const seen: AiSettings[] = [];
    const unsubscribe = subscribeToAiSettings((settings) => seen.push(settings));
    await flush();
    seen.length = 0; // Only the save's own notification matters to this test.

    await saveAiSettings({ autoClassify: true });
    expect(seen.some((settings) => settings.autoClassify === true)).toBe(true);

    unsubscribe();
  });
});
