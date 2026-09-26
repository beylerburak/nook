// No database and no API key: everything here is a normaliser, a ring buffer or a
// `vi.fn()` pool. The discipline under test is the one `ai-settings.ts` keeps for
// its own row — a stored value is never trusted, so every input has to have a
// defined output — and the assertions are written as the shapes a hand-edited or
// half-written row would take, not as the shape a correct writer produces.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_LOG_MAX_ENTRIES,
  activeCooldown,
  normalizeAiRunState,
  pushLogEntry,
  readAiStatus,
  summarizeRunState,
  type AiLogEntry,
} from "../src/ai-store.js";

const NOW = Date.parse("2026-09-26T12:00:00.000Z");
const IN_AN_HOUR = new Date(NOW + 3_600_000).toISOString();
const IN_TEN_MINUTES = new Date(NOW + 600_000).toISOString();
const AN_HOUR_AGO = new Date(NOW - 3_600_000).toISOString();

function entry(overrides: Partial<AiLogEntry> = {}): AiLogEntry {
  return { id: "b1", confidence: 0.91, assigned: true, at: "2026-09-26T11:59:00.000Z", ...overrides };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TYPESAFE_API_KEY;
});

describe("normalizeAiRunState", () => {
  it("fills in every field for a missing row", () => {
    const expected = {
      processed: 0,
      assigned: 0,
      tagged: 0,
      skipped: 0,
      lastRunAt: null,
      lastError: null,
      unavailableUntil: null,
      backoffUntil: null,
      backoffMs: 0,
      log: [],
      // The summarisation sub-record. Every row written before that pass existed
      // has no such key, so a normaliser that did not fill it here would leave the
      // classification pass's own status reading off `undefined`.
      summarize: {
        processed: 0,
        written: 0,
        skipped: 0,
        lastRunAt: null,
        lastError: null,
        unavailableUntil: null,
        backoffUntil: null,
        backoffMs: 0,
      },
    };
    expect(normalizeAiRunState(undefined)).toEqual(expected);
    expect(normalizeAiRunState(null)).toEqual(expected);
    expect(normalizeAiRunState({})).toEqual(expected);
    // A row written by an older build that only knew about the counters.
    expect(normalizeAiRunState({ processed: 12, assigned: 3 })).toEqual({ ...expected, processed: 12, assigned: 3 });
  });

  it("is total over garbage, and never propagates a number that is not one", () => {
    for (const junk of ["a string", 42, true, [1, 2, 3], { processed: "many", log: "none" }]) {
      const state = normalizeAiRunState(junk);
      // Counters are display values, so an unreadable one is zeroed rather than
      // shown: "processed: NaN" is worse than a count that restarted.
      expect(Number.isFinite(state.processed)).toBe(true);
      expect(state.processed).toBe(0);
      expect(Array.isArray(state.log)).toBe(true);
    }
    expect(normalizeAiRunState({ processed: -4, tagged: 3.9, skipped: Number.NaN })).toMatchObject({
      processed: 0,
      tagged: 3,
      skipped: 0,
    });
    // A counter stored as a numeric string is still a number, because jsonb has no
    // integer type and a different writer could have produced it.
    expect(normalizeAiRunState({ assigned: "7" }).assigned).toBe(0);
  });

  it("keeps a cooldown that is still in the future, and drops one that is not a date", () => {
    const state = normalizeAiRunState({
      unavailableUntil: IN_AN_HOUR,
      backoffUntil: "not a date",
      backoffMs: 120_000,
      lastRunAt: AN_HOUR_AGO,
    });
    expect(state.unavailableUntil).toBe(IN_AN_HOUR);
    // A parked window left behind by an earlier failure is still kept: it is the
    // record of what happened, and "in effect" is decided against the clock.
    expect(state.backoffUntil).toBeNull();
    expect(state.backoffMs).toBe(120_000);
    expect(state.lastRunAt).toBe(AN_HOUR_AGO);
  });

  it("reads only the log entries that carry an id, and clamps a confidence", () => {
    const state = normalizeAiRunState({
      log: [
        entry({ id: "b1" }),
        "not an entry",
        null,
        { confidence: 0.5, assigned: "yes" },
        entry({ id: "b2", confidence: 7, assigned: false }),
      ],
    });
    // An entry with no id cannot be attributed to a bookmark, so it is dropped
    // rather than rendered as a nameless bar in the histogram.
    expect(state.log).toEqual([entry({ id: "b1" }), entry({ id: "b2", confidence: 1, assigned: false })]);
  });

  it("keeps only the tail of a log longer than the ring buffer", () => {
    const log = Array.from({ length: AI_LOG_MAX_ENTRIES + 25 }, (_, index) => entry({ id: `b${index}` }));
    const state = normalizeAiRunState({ log });
    expect(state.log).toHaveLength(AI_LOG_MAX_ENTRIES);
    expect(state.log.at(-1)?.id).toBe(`b${AI_LOG_MAX_ENTRIES + 24}`);
    expect(state.log[0].id).toBe("b25");
  });
});

describe("summarizeRunState", () => {
  it("resolves the cooldowns against the clock it is given", () => {
    const state = normalizeAiRunState({
      processed: 40,
      assigned: 12,
      tagged: 30,
      skipped: 3,
      lastRunAt: AN_HOUR_AGO,
      unavailableUntil: IN_AN_HOUR,
      backoffUntil: AN_HOUR_AGO,
      log: [entry()],
    });
    const summary = summarizeRunState(state, NOW);
    expect(summary).toEqual({
      processed: 40,
      assigned: 12,
      tagged: 30,
      skipped: 3,
      lastRunAt: AN_HOUR_AGO,
      lastError: null,
      // A cooldown whose window has passed reads as not in effect, which is the
      // whole difference between a stored stamp and a rendered boolean.
      isUnavailable: true,
      isBackingOff: false,
      log: [entry()],
    });
    expect(summarizeRunState(state, NOW + 7_200_000).isUnavailable).toBe(false);
  });

  it("hands back a copy of the log, so a caller cannot mutate the state it was given", () => {
    const state = normalizeAiRunState({ log: [entry()] });
    const summary = summarizeRunState(state, NOW);
    summary.log.push(entry({ id: "b2" }));
    expect(state.log).toHaveLength(1);
  });
});

describe("activeCooldown", () => {
  it("is null when the worker may run", () => {
    expect(activeCooldown(normalizeAiRunState(undefined), NOW)).toBeNull();
    expect(activeCooldown(normalizeAiRunState({ unavailableUntil: AN_HOUR_AGO }), NOW)).toBeNull();
    expect(activeCooldown(normalizeAiRunState({ backoffUntil: "nonsense" }), NOW)).toBeNull();
  });

  it("picks the window that ends last, because that is the one that governs", () => {
    const both = normalizeAiRunState({ unavailableUntil: IN_AN_HOUR, backoffUntil: IN_TEN_MINUTES });
    expect(activeCooldown(both, NOW)).toBe(IN_AN_HOUR);
    expect(activeCooldown(normalizeAiRunState({ backoffUntil: IN_TEN_MINUTES }), NOW)).toBe(IN_TEN_MINUTES);
    expect(activeCooldown(normalizeAiRunState({ unavailableUntil: IN_AN_HOUR }), NOW)).toBe(IN_AN_HOUR);
  });
});

describe("pushLogEntry", () => {
  it("appends, and drops the oldest overflow", () => {
    const log: AiLogEntry[] = [];
    for (let index = 0; index < AI_LOG_MAX_ENTRIES + 1; index++) {
      pushLogEntry(log, entry({ id: `b${index}` }));
    }
    expect(log).toHaveLength(AI_LOG_MAX_ENTRIES);
    // Newest last, oldest gone: the panel only ever draws the tail.
    expect(log[0].id).toBe("b1");
    expect(log.at(-1)?.id).toBe(`b${AI_LOG_MAX_ENTRIES}`);
  });

  it("mutates in place, because the state it is called with is a column being rebuilt", () => {
    const log: AiLogEntry[] = [entry({ id: "b1" })];
    const same = log;
    pushLogEntry(log, entry({ id: "b2" }));
    expect(same).toHaveLength(2);
  });
});

describe("readAiStatus", () => {
  /** One `query`, dispatched on the statement — enough for the independent reads
   *  `readAiStatus` composes, and nothing more. */
  function stubPool(options: {
    settings?: Record<string, unknown>;
    pending?: number;
    state?: Record<string, unknown>;
    taxonomy?: Record<string, unknown>;
    reviewCount?: number;
  } = {}) {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("nook_ai_settings")) return { rows: [{ data: options.settings ?? { autoClassify: true } }] };
      if (sql.includes("count(*)::int AS count FROM nook_ai_jobs")) {
        return { rows: [{ count: options.pending ?? 7 }] };
      }
      if (sql.includes("FROM nook_ai_taxonomy")) return { rows: [{ data: options.taxonomy ?? {} }] };
      // The review count's own statement selects from `nook_ai_review` (matched
      // first, more specifically) rather than `nook_ai_state`, so it must be
      // checked before the broader `nook_ai_state` branch below.
      if (sql.includes("FROM nook_ai_review")) return { rows: [{ count: options.reviewCount ?? 5 }] };
      if (sql.includes("FROM nook_ai_state")) return { rows: [{ data: options.state ?? {} }] };
      throw new Error(`unexpected statement: ${sql}`);
    });
    return { query };
  }

  it("composes the whole surface from independent reads, and takes `available` from the key", async () => {
    const status = await readAiStatus(stubPool({ pending: 3, reviewCount: 12 }) as never, "u1", NOW);
    expect(status.available).toBe(false);
    expect(status.pending).toBe(3);
    expect(status.settings.autoClassify).toBe(true);
    expect(status.taxonomy).toEqual({ acceptedAt: null, collections: [], tags: [] });
    // Additive, like `summarize`: the same count GET /api/ai/review's `total`
    // reports, read here as a plain count with no pruning side effect (see the
    // comment on `AiStatusResponse.reviewCount`).
    expect(status.reviewCount).toBe(12);

    // The same value the classify route's 503 is built from, so the panel's dot and
    // the route cannot disagree about whether this server can classify at all.
    process.env.TYPESAFE_API_KEY = "test-key";
    expect((await readAiStatus(stubPool() as never, "u1", NOW)).available).toBe(true);
  });

  it("defaults reviewCount to zero for an account with no kept guesses", async () => {
    const status = await readAiStatus(stubPool({ reviewCount: 0 }) as never, "u1", NOW);
    expect(status.reviewCount).toBe(0);
  });

  it("reports a cooldown in effect as a boolean, and one in the past as not in effect", async () => {
    const cooling = await readAiStatus(
      stubPool({ state: { backoffUntil: IN_TEN_MINUTES, processed: 9 } }) as never,
      "u1",
      NOW,
    );
    expect(cooling.run.isBackingOff).toBe(true);
    expect(cooling.run.processed).toBe(9);

    const past = await readAiStatus(
      stubPool({ state: { backoffUntil: AN_HOUR_AGO, lastError: "Rate limited — backing off." } }) as never,
      "u1",
      NOW,
    );
    expect(past.run.isBackingOff).toBe(false);
    expect(past.run.lastError).toBe("Rate limited — backing off.");
  });
});
