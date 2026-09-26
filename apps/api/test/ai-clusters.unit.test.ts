// No network, no database. `pool.query`/`client.query` are `vi.fn()`s dispatched
// on the statement text, the same stubbing style ai-jobs.unit.test.ts uses one
// layer deeper for its own write path. `clusterEmbeddings` itself is NOT
// mocked — these are route-level tests of `proposeClustersForUser` and
// `acceptClustersForUser`, so the fixtures below are real (if small) embedding
// vectors, chosen and verified (see the comment above BLOB_A/BLOB_B) to
// cluster into exactly two clean groups through the real algorithm.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ACCEPTED_COLLECTIONS,
  MAX_ACCEPTED_MEMBER_IDS,
  ProposerCallFailedError,
  acceptClustersForUser,
  parseClusterAcceptance,
  proposeClustersForUser,
} from "../src/ai-clusters.js";
import { ProposerUnavailableError } from "../src/ai-jobs.js";

function flatten(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

// -- embedding fixtures -----------------------------------------------------
//
// Two directions far enough apart (and internally tight enough) that
// `clusterEmbeddings`'s default k-means++ + merge pipeline recovers exactly two
// clusters of the given sizes with zero unclustered — verified directly against
// cluster-math.ts while writing this file, the same way ai-clusters-math.unit.test.ts
// verifies the algorithm on its own; this is a fixed point of that behaviour,
// not a new claim about it.
const BLOB_A = [5, 0, 0, 0, 0, 0];
const BLOB_B = [0, 5, 0, 0, 0, 0];

function nearVector(center: readonly number[], index: number, amplitude = 0.03): number[] {
  return center.map((value, d) => value + amplitude * Math.sin((index + 1) * (d + 1) * 0.73));
}

interface Row {
  id: string;
  title: string | null;
  short_description: string | null;
  note: string | null;
  url: string | null;
  handle: string | null;
  vector: number[];
}

function row(id: string, center: readonly number[], index: number, title: string): Row {
  return { id, title, short_description: null, note: null, url: null, handle: null, vector: nearVector(center, index) };
}

/** 12 + 12 = 24, one above `MIN_CONSIDERED` (20) with room to spare, and the
 *  exact size verified to produce two clean clusters of 12. */
function twoBlobRows(): Row[] {
  return [
    ...Array.from({ length: 12 }, (_, i) => row(`a-${i}`, BLOB_A, i, `Alpha post ${i}`)),
    ...Array.from({ length: 12 }, (_, i) => row(`b-${i}`, BLOB_B, i, `Beta post ${i}`)),
  ];
}

// -- propose: a pool fake dispatched on statement shape ----------------------

interface ProposePoolOptions {
  embedded: Row[];
  existingCentroids?: Array<{ list_id: string; vector: number[] }>;
  existingNames?: Array<{ id: string; name: string }>;
  settings?: Record<string, unknown>;
}

function proposePool(options: ProposePoolOptions) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    const flat = flatten(sql);
    calls.push({ sql: flat, params });
    // The existing-collection-centroid read joins a second `nook_records l`;
    // the plain unfiled-embedded read does not. Checked before the generic
    // embeddings join so the two never get confused for one another.
    if (flat.includes("JOIN nook_records l")) {
      return { rows: options.existingCentroids ?? [] };
    }
    if (flat.includes("JOIN nook_embeddings e")) {
      return { rows: options.embedded };
    }
    if (flat.startsWith("SELECT id, data->>'name' AS name FROM nook_records")) {
      return { rows: options.existingNames ?? [] };
    }
    if (flat.includes("FROM nook_ai_settings")) {
      return { rows: [{ data: options.settings ?? {} }] };
    }
    return { rows: [] };
  });
  return { pool: { query } as never, query, calls };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NOOK_AI_PROPOSER;
  delete process.env.OPENAI_API_KEY;
});

describe("proposeClustersForUser — too few to cluster", () => {
  it("returns before reading anything else or resolving a proposer", async () => {
    const { pool, query } = proposePool({ embedded: twoBlobRows().slice(0, 5) });
    const fetch = vi.fn();

    const result = await proposeClustersForUser(pool, "u1", undefined, { fetch });

    expect(result).toEqual({ proposals: [], unclustered: 5, considered: 5 });
    // Only the one read: the library is too small to be worth reading the
    // account's existing collections or settings for.
    expect(query).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("proposeClustersForUser — matched to an existing collection", () => {
  it("names a matched cluster from the collection it matches, with no proposer call at all", async () => {
    const { pool } = proposePool({
      embedded: twoBlobRows(),
      existingCentroids: [
        { list_id: "list-alpha", vector: BLOB_A },
        { list_id: "list-beta", vector: BLOB_B },
      ],
      existingNames: [
        { id: "list-alpha", name: "Alpha" },
        { id: "list-beta", name: "Beta" },
      ],
    });
    const fetch = vi.fn();

    const result = await proposeClustersForUser(pool, "u1", undefined, { fetch });

    expect(result.considered).toBe(24);
    expect(result.unclustered).toBe(0);
    expect(result.proposals).toHaveLength(2);
    const names = result.proposals.map((p) => p.name).sort();
    expect(names).toEqual(["Alpha", "Beta"]);
    for (const proposal of result.proposals) {
      expect(proposal.existingListId).toBe(proposal.name === "Alpha" ? "list-alpha" : "list-beta");
      expect(proposal.size).toBe(12);
      expect(proposal.memberIds).toHaveLength(12);
      expect(proposal.sampleTitles.length).toBeGreaterThan(0);
      expect(proposal.sampleTitles.length).toBeLessThanOrEqual(5);
    }
    // The whole point of matching: naming a cluster that already has an
    // obvious home costs nothing.
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("proposeClustersForUser — the naming call", () => {
  it("makes exactly one call to name every unmatched cluster, and reports each cluster back by its own id", async () => {
    process.env.NOOK_AI_PROPOSER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    const { pool } = proposePool({ embedded: twoBlobRows() });
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string) as { messages: Array<{ content: string }> };
      const userText = body.messages[1].content;
      const ids = [...userText.matchAll(/Group (cluster-\d+):/g)].map((m) => m[1]);
      const clusters = ids.map((id) => ({ id, name: `Named ${id}`, why: `Why for ${id}` }));
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ clusters }) } }] }),
      } as Response;
    });

    const result = await proposeClustersForUser(pool, "u1", undefined, { fetch });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result.considered).toBe(24);
    expect(result.unclustered).toBe(0);
    expect(result.proposals).toHaveLength(2);
    for (const proposal of result.proposals) {
      expect(proposal.name).toBe(`Named ${proposal.id}`);
      expect(proposal.why).toBe(`Why for ${proposal.id}`);
      expect(proposal.existingListId).toBeNull();
      expect(proposal.size).toBe(12);
    }
    // Every considered bookmark landed in exactly one proposal.
    const allMembers = result.proposals.flatMap((p) => p.memberIds);
    expect(new Set(allMembers).size).toBe(24);
  });

  it("maps a proposer not configured to ProposerUnavailableError", async () => {
    const { pool } = proposePool({ embedded: twoBlobRows() });
    await expect(proposeClustersForUser(pool, "u1")).rejects.toBeInstanceOf(ProposerUnavailableError);
  });

  it("maps a configured proposer whose call itself failed to ProposerCallFailedError, not an empty result", async () => {
    process.env.NOOK_AI_PROPOSER = "openai";
    process.env.OPENAI_API_KEY = "test-key";
    const { pool } = proposePool({ embedded: twoBlobRows() });
    const fetch = vi.fn(async () => ({ ok: false, status: 500, headers: new Headers() }) as Response);

    await expect(proposeClustersForUser(pool, "u1", undefined, { fetch })).rejects.toBeInstanceOf(
      ProposerCallFailedError,
    );
  });
});

// -- accept -------------------------------------------------------------------

interface AcceptPoolOptions {
  existingLists?: Array<{ id: string; name: string }>;
  /** Ids the filing UPDATE's WHERE clause would actually match — everything
   *  else in a request's `memberIds` is "still requested" but not eligible
   *  (already filed, deleted, or simply not found), which is exactly what
   *  `skipped` counts. Defaults to "every requested id is eligible". */
  eligibleMemberIds?: Set<string>;
  titles?: Record<string, string>;
  previousTaxonomy?: Record<string, unknown>;
}

function acceptPool(options: AcceptPoolOptions = {}) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      const flat = flatten(sql);
      statements.push({ sql: flat, params });
      if (flat.startsWith("SELECT id, data->>'name' AS name FROM nook_records WHERE user_id=$1 AND kind='list'")) {
        return { rows: options.existingLists ?? [] };
      }
      if (flat.startsWith("INSERT INTO nook_records (user_id, kind, id, data, deleted_at)")) {
        return { rows: [], rowCount: 1 };
      }
      if (flat.startsWith("UPDATE nook_records SET")) {
        const ids = params[4] as string[];
        const eligible = options.eligibleMemberIds ?? new Set(ids);
        const filed = ids.filter((id) => eligible.has(id));
        return { rows: filed.map((id) => ({ id })), rowCount: filed.length };
      }
      if (flat.startsWith("SELECT id, data->>'title' AS title FROM nook_records")) {
        const ids = params[1] as string[];
        return { rows: ids.map((id) => ({ id, title: options.titles?.[id] ?? null })) };
      }
      if (flat.includes("FROM nook_ai_taxonomy WHERE user_id = $1")) {
        return { rows: [{ data: options.previousTaxonomy ?? {} }] };
      }
      if (flat.startsWith("INSERT INTO nook_ai_taxonomy")) {
        return { rows: [{ data: JSON.parse(params[1] as string) }] };
      }
      // BEGIN / COMMIT / ROLLBACK / the advisory lock / DELETE FROM
      // nook_ai_decided all fall through here — none of them need a shaped
      // response, only to be recorded so a test can assert they ran.
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn(),
  };
  const pool = { connect: vi.fn(async () => client) };
  return { pool: pool as never, client, statements, ran: (fragment: string) => statements.some((s) => s.sql.includes(fragment)) };
}

describe("acceptClustersForUser", () => {
  it("creates a new list, files every member, and clears nook_ai_decided", async () => {
    const { pool, statements, ran } = acceptPool();
    const newId = () => "new-list-id";

    const result = await acceptClustersForUser(
      pool,
      "u1",
      [{ name: "Reading", memberIds: ["b1", "b2", "b3"], existingListId: null }],
      { now: () => Date.parse("2026-09-26T00:00:00.000Z"), newId },
    );

    expect(result).toEqual({ createdCollections: 1, filed: 3, skipped: 0 });
    expect(ran("INSERT INTO nook_records (user_id, kind, id, data, deleted_at)")).toBe(true);
    expect(ran("DELETE FROM nook_ai_decided WHERE user_id = $1")).toBe(true);

    const update = statements.find((s) => s.sql.startsWith("UPDATE nook_records SET"));
    expect(update?.params[1]).toBe("new-list-id");
    expect(update?.params[2]).toBe("Reading");
    expect(update?.params[4]).toEqual(["b1", "b2", "b3"]);
  });

  it("files into a live collection whose name collides, rather than creating a duplicate", async () => {
    const { pool, statements, ran } = acceptPool({ existingLists: [{ id: "list-1", name: "Reading" }] });

    const result = await acceptClustersForUser(pool, "u1", [
      // Differs only in case from the live "Reading" — same collision fold
      // `acceptTaxonomyForUser` applies via ai-taxonomy.ts's `collectionKey`.
      { name: "reading", memberIds: ["b1"], existingListId: null },
    ]);

    expect(result.createdCollections).toBe(0);
    expect(ran("INSERT INTO nook_records (user_id, kind, id, data, deleted_at)")).toBe(false);
    // No list was created, so there is nothing stale to clear.
    expect(ran("DELETE FROM nook_ai_decided WHERE user_id = $1")).toBe(false);

    const update = statements.find((s) => s.sql.startsWith("UPDATE nook_records SET"));
    expect(update?.params[1]).toBe("list-1");
    expect(update?.params[2]).toBe("Reading");
  });

  it("honours an explicit existingListId even when the requested name doesn't match it", async () => {
    const { pool, statements } = acceptPool({ existingLists: [{ id: "list-1", name: "Reading" }] });

    const result = await acceptClustersForUser(pool, "u1", [
      { name: "Whatever New Name", memberIds: ["b1"], existingListId: "list-1" },
    ]);

    expect(result.createdCollections).toBe(0);
    const update = statements.find((s) => s.sql.startsWith("UPDATE nook_records SET"));
    expect(update?.params[1]).toBe("list-1");
    expect(update?.params[2]).toBe("Reading");
  });

  it("counts a member that is no longer live or unfiled as skipped, not filed", async () => {
    const { pool } = acceptPool({ eligibleMemberIds: new Set(["b1"]) });

    const result = await acceptClustersForUser(pool, "u1", [
      { name: "Reading", memberIds: ["b1", "b2", "b3"], existingListId: null },
    ]);

    expect(result.filed).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("rolls back and rethrows when a statement fails", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (flatten(sql).startsWith("BEGIN")) return { rows: [] };
        throw new Error("boom");
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client) } as never;

    await expect(acceptClustersForUser(pool, "u1", [{ name: "X", memberIds: [], existingListId: null }])).rejects.toThrow(
      "boom",
    );
    expect(client.query).toHaveBeenCalledWith("ROLLBACK");
    expect(client.release).toHaveBeenCalled();
  });
});

// -- request validation -------------------------------------------------------

describe("parseClusterAcceptance", () => {
  it("accepts a well-formed body", () => {
    const parsed = parseClusterAcceptance({
      collections: [{ name: "Reading", memberIds: ["a", "b"], existingListId: "list-1" }],
    });
    expect(parsed.collections).toEqual([{ name: "Reading", memberIds: ["a", "b"], existingListId: "list-1" }]);
  });

  it("defaults a missing existingListId to null rather than requiring it", () => {
    const parsed = parseClusterAcceptance({ collections: [{ name: "Reading", memberIds: ["a"] }] });
    expect(parsed.collections[0].existingListId).toBeNull();
  });

  it("rejects more than 50 collections", () => {
    const collections = Array.from({ length: 51 }, (_, i) => ({ name: `C${i}`, memberIds: [] }));
    expect(() => parseClusterAcceptance({ collections })).toThrow();
  });

  it("accepts exactly the cap of 50 collections", () => {
    const collections = Array.from({ length: MAX_ACCEPTED_COLLECTIONS }, (_, i) => ({ name: `C${i}`, memberIds: [] }));
    expect(() => parseClusterAcceptance({ collections })).not.toThrow();
  });

  it("rejects more than 5,000 member ids across all collections", () => {
    const memberIds = Array.from({ length: MAX_ACCEPTED_MEMBER_IDS + 1 }, (_, i) => `id-${i}`);
    expect(() => parseClusterAcceptance({ collections: [{ name: "Big", memberIds }] })).toThrow();
  });

  it("rejects an empty name", () => {
    expect(() => parseClusterAcceptance({ collections: [{ name: "  ", memberIds: [] }] })).toThrow();
  });

  it("rejects a non-string member id", () => {
    expect(() => parseClusterAcceptance({ collections: [{ name: "X", memberIds: [123] }] })).toThrow();
  });

  it("rejects a malformed existingListId", () => {
    expect(() =>
      parseClusterAcceptance({ collections: [{ name: "X", memberIds: [], existingListId: 5 }] }),
    ).toThrow();
  });

  it("rejects a request that isn't an object, or whose collections isn't an array", () => {
    expect(() => parseClusterAcceptance(null)).toThrow();
    expect(() => parseClusterAcceptance({ collections: "nope" })).toThrow();
  });
});
