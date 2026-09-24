import { describe, expect, it } from "vitest";
import { parseSyncRequest, validateChange, type RawChange } from "../src/sync.js";

function change(overrides: Partial<RawChange> = {}): RawChange {
  return {
    kind: "bookmark",
    id: "b1",
    baseVersion: null,
    data: { id: "b1", title: "hello" },
    ...overrides,
  };
}

describe("parseSyncRequest", () => {
  it("accepts a minimal request and defaults cursor to \"0\"", () => {
    const parsed = parseSyncRequest({ changes: [] });
    expect(parsed).toEqual({ cursor: "0", epoch: undefined, changes: [] });
  });

  it("passes epoch through when present", () => {
    const parsed = parseSyncRequest({ cursor: "5", epoch: "abc", changes: [] });
    expect(parsed.epoch).toBe("abc");
  });

  it("rejects a non-object body", () => {
    expect(() => parseSyncRequest(null)).toThrow();
    expect(() => parseSyncRequest("nope")).toThrow();
  });

  it("rejects a non-array changes field", () => {
    expect(() => parseSyncRequest({ changes: {} })).toThrow("Invalid changes array");
  });

  it("rejects more than 100 changes", () => {
    const changes = Array.from({ length: 101 }, (_, i) => change({ id: `b${i}` }));
    expect(() => parseSyncRequest({ changes })).toThrow("Invalid changes array");
  });

  it("rejects an invalid cursor", () => {
    expect(() => parseSyncRequest({ cursor: "not-a-number", changes: [] })).toThrow("Invalid cursor");
    expect(() => parseSyncRequest({ cursor: -1, changes: [] })).toThrow("Invalid cursor");
  });

  it("rejects a non-string epoch", () => {
    expect(() => parseSyncRequest({ changes: [], epoch: 123 })).toThrow("Invalid epoch");
  });

  it("rejects duplicate kind+id pairs", () => {
    expect(() =>
      parseSyncRequest({ changes: [change({ id: "dup" }), change({ id: "dup" })] }),
    ).toThrow("Duplicate changes");
  });

  it("rejects a change that isn't an object", () => {
    expect(() => parseSyncRequest({ changes: ["nope"] })).toThrow("Invalid change");
  });

  it("rejects a change lacking a string kind or id", () => {
    expect(() => parseSyncRequest({ changes: [{ id: "b1", data: {} }] })).toThrow("Invalid change");
    expect(() => parseSyncRequest({ changes: [{ kind: "bookmark", data: {} }] })).toThrow("Invalid change");
    expect(() => parseSyncRequest({ changes: [{ kind: 1, id: "b1", data: {} }] })).toThrow("Invalid change");
  });

  it("does NOT reject a structurally valid but semantically bad change at the whole-request level", () => {
    // Bad id length, mismatched data.id, junk kind value: all per-change concerns,
    // handled later by validateChange so one bad record can't 400 the whole batch.
    const parsed = parseSyncRequest({
      changes: [
        change({ id: "" }),
        change({ kind: "not-a-real-kind" }),
        change({ id: "b2", data: { id: "different" } }),
      ],
    });
    expect(parsed.changes).toHaveLength(3);
  });
});

describe("validateChange", () => {
  it("accepts a well-formed change", () => {
    const result = validateChange(change());
    expect(result).toHaveProperty("mutation");
    if ("mutation" in result) {
      expect(result.mutation).toEqual({
        kind: "bookmark",
        id: "b1",
        baseVersion: null,
        data: { id: "b1", title: "hello" },
      });
    }
  });

  it("normalizes a numeric-string baseVersion", () => {
    const result = validateChange(change({ baseVersion: "007" }));
    expect("mutation" in result && result.mutation.baseVersion).toBe("7");
  });

  it("rejects an invalid kind", () => {
    const result = validateChange(change({ kind: "note" }));
    expect("rejected" in result && result.rejected.error).toBe("Invalid kind");
  });

  it("rejects an empty or overlong id", () => {
    expect("rejected" in validateChange(change({ id: "" })) &&
      (validateChange(change({ id: "" })) as any).rejected.error).toBe("Invalid id");
    const longId = "x".repeat(257);
    const result = validateChange(change({ id: longId, data: { id: longId } }));
    expect("rejected" in result && result.rejected.error).toBe("Invalid id");
  });

  it("rejects data that isn't a plain object", () => {
    expect("rejected" in validateChange(change({ data: null })) &&
      (validateChange(change({ data: null })) as any).rejected.error).toBe("Invalid record");
    const arrayResult = validateChange(change({ data: [] }));
    expect("rejected" in arrayResult && arrayResult.rejected.error).toBe("Invalid record");
  });

  it("rejects a data.id that doesn't match the change id", () => {
    const result = validateChange(change({ id: "b1", data: { id: "b2" } }));
    expect("rejected" in result && result.rejected.error).toBe("Record id mismatch");
  });

  it("rejects a record whose UTF-8 byte size (not UTF-16 length) exceeds the limit", () => {
    // Each "😀" is 2 UTF-16 code units but 4 UTF-8 bytes. Use enough of them to stay
    // under 512,000 UTF-16 units while exceeding 512,000 UTF-8 bytes.
    const emoji = "\u{1F600}".repeat(140_000); // 280,000 UTF-16 units, 560,000 UTF-8 bytes
    const result = validateChange(change({ data: { id: "b1", title: emoji } }));
    expect("rejected" in result && result.rejected.error).toBe("Record too large");
  });

  it("accepts a record within the byte limit even with multi-byte characters", () => {
    const result = validateChange(change({ data: { id: "b1", title: "héllo wörld 😀" } }));
    expect(result).toHaveProperty("mutation");
  });

  it("rejects an invalid deletedAt", () => {
    const result = validateChange(change({ data: { id: "b1", deletedAt: "not-a-date" } }));
    expect("rejected" in result && result.rejected.error).toBe("Invalid deletion time");
  });

  it("accepts a null deletedAt and a valid ISO deletedAt", () => {
    expect(validateChange(change({ data: { id: "b1", deletedAt: null } }))).toHaveProperty("mutation");
    expect(
      validateChange(change({ data: { id: "b1", deletedAt: new Date().toISOString() } })),
    ).toHaveProperty("mutation");
  });

  it("rejects a record containing a U+0000 character, including nested", () => {
    const top = validateChange(change({ data: { id: "b1", title: "a\u0000b" } }));
    expect("rejected" in top && top.rejected.error).toBe("Record contains a null character");
    const nested = validateChange(change({ data: { id: "b1", tags: ["ok", "bad\u0000"] } }));
    expect("rejected" in nested && nested.rejected.error).toBe("Record contains a null character");
  });

  it("rejects an invalid baseVersion", () => {
    const result = validateChange(change({ baseVersion: "not-a-number" }));
    expect("rejected" in result && result.rejected.error).toBe("Invalid base version");
  });
});
