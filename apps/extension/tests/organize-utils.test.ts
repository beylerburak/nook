import { describe, expect, it } from "vitest";
import { translate } from "../src/i18n/core";
import type { AiLogEntry, ClusterProposal, ReviewItem } from "../lib/ai-client";
import type { Bookmark, BookmarkList } from "../lib/types";
import {
  clusterMemberTitles,
  describeClusterFooterLabel,
  describeProgress,
  describeRemainder,
  describeUnclustered,
  describeWorking,
  estimateMinutesRemaining,
  libraryProgress,
  recentlyFiledRows,
  remainderCounts,
  reviewConfidenceLabel,
  reviewRows,
  tickedClusterCounts,
} from "../src/app/dashboard/organize/organize-utils";

const t = <K extends Parameters<typeof translate>[1]>(key: K, params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params as never);

// "chrome" source so `itemTitle` (bookmark-utils.ts) reads the plain `title`
// field — an "x" bookmark's title comes from `creator.name`/`handle`
// instead, which isn't what these tests are about.
function bookmark(overrides: Partial<Bookmark> & { id: string }): Bookmark {
  return { source: "chrome", ...overrides };
}

function logEntry(overrides: Partial<AiLogEntry> & { id: string }): AiLogEntry {
  return { confidence: 0, assigned: false, at: "2026-09-20T10:00:00.000Z", ...overrides };
}

describe("organize-utils — libraryProgress", () => {
  it("counts a bookmark with a listId as filed, everything else as unfiled", () => {
    const items = [
      bookmark({ id: "1", listId: "list-1" }),
      bookmark({ id: "2", listId: null }),
      bookmark({ id: "3" }),
    ];
    expect(libraryProgress(items)).toEqual({ total: 3, filed: 1, unfiled: 2 });
  });

  it("is all-zero for an empty library", () => {
    expect(libraryProgress([])).toEqual({ total: 0, filed: 0, unfiled: 0 });
  });
});

describe("organize-utils — estimateMinutesRemaining", () => {
  it("is zero once nothing is pending", () => {
    expect(estimateMinutesRemaining(0)).toBe(0);
  });

  it("rounds up, and is never zero while something is pending", () => {
    expect(estimateMinutesRemaining(1)).toBe(1);
    expect(estimateMinutesRemaining(150)).toBe(1);
    expect(estimateMinutesRemaining(151)).toBe(2);
    expect(estimateMinutesRemaining(600)).toBe(4);
  });
});

describe("organize-utils — copy helpers", () => {
  it("describes a working queue with both the count and the minute estimate", () => {
    expect(describeWorking(t, 300)).toBe("About 300 bookmarks left — about 2 min.");
    expect(describeWorking(t, 1)).toBe("About 1 bookmark left — about 1 min.");
  });

  it("joins the filed and unfiled counts into one progress line", () => {
    expect(describeProgress(t, { total: 10, filed: 3, unfiled: 7 })).toBe("3 bookmarks filed · 7 left to organize");
  });
});

describe("organize-utils — recentlyFiledRows", () => {
  const items: Bookmark[] = [
    bookmark({ id: "a", title: "Post about design", listId: "list-design" }),
    bookmark({ id: "b", title: "Post about servers", listId: "list-infra", listName: "Infra (stale copy)" }),
    bookmark({ id: "c", title: "Never filed" }),
  ];
  const lists: BookmarkList[] = [
    { id: "list-design", name: "Design", createdAt: "", updatedAt: "" } as BookmarkList,
    { id: "list-infra", name: "Infrastructure", createdAt: "", updatedAt: "" } as BookmarkList,
  ];

  it("keeps only assigned entries, newest first, mapped onto local bookmarks", () => {
    const log: AiLogEntry[] = [
      logEntry({ id: "a", assigned: true, at: "2026-09-20T09:00:00.000Z" }),
      logEntry({ id: "c", assigned: false, at: "2026-09-20T09:30:00.000Z" }),
      logEntry({ id: "b", assigned: true, at: "2026-09-20T10:00:00.000Z" }),
    ];

    const rows = recentlyFiledRows(log, items, lists, t);
    expect(rows.map((row) => row.id)).toEqual(["b", "a"]);
    expect(rows[0]).toMatchObject({ title: "Post about servers", collectionName: "Infrastructure" });
  });

  it("prefers the live list name over the bookmark's own cached listName", () => {
    const log: AiLogEntry[] = [logEntry({ id: "b", assigned: true })];
    const [row] = recentlyFiledRows(log, items, lists, t);
    expect(row.collectionName).toBe("Infrastructure");
  });

  it("leads an X post with its text and keeps the author as a byline", () => {
    const post = bookmark({
      id: "x:1",
      source: "x",
      creator: { name: "Dhruval", handle: "dhruvalgolakiya" },
      description: "Full onboarding flow in 2 prompts for a mac app",
      listId: "list-infra",
    });
    const [row] = recentlyFiledRows([logEntry({ id: "x:1", assigned: true })], [post], lists, t);
    expect(row).toMatchObject({ title: "Full onboarding flow in 2 prompts for a mac app", author: "Dhruval" });
  });

  it("drops an id the local library doesn't have, rather than rendering a blank row", () => {
    const log: AiLogEntry[] = [logEntry({ id: "unknown-id", assigned: true })];
    expect(recentlyFiledRows(log, items, lists, t)).toEqual([]);
  });

  it("caps at the given limit", () => {
    const manyItems = Array.from({ length: 10 }, (_, index) => bookmark({ id: `id-${index}`, title: `Item ${index}`, listId: "list-design" }));
    const log: AiLogEntry[] = manyItems.map((item, index) =>
      logEntry({ id: item.id, assigned: true, at: `2026-09-20T${String(10 + index).padStart(2, "0")}:00:00.000Z` }),
    );
    expect(recentlyFiledRows(log, manyItems, lists, t, 3)).toHaveLength(3);
  });
});

describe("organize-utils — remainderCounts and describeRemainder", () => {
  const threshold = 0.75;

  it("buckets an unassigned entry at or above the threshold as 'none fit'", () => {
    const log: AiLogEntry[] = [logEntry({ id: "1", assigned: false, confidence: 0.9 })];
    expect(remainderCounts(log, threshold)).toEqual({ noneFit: 1, unsure: 0 });
  });

  it("buckets an unassigned entry below the threshold as 'unsure'", () => {
    const log: AiLogEntry[] = [logEntry({ id: "1", assigned: false, confidence: 0.5 })];
    expect(remainderCounts(log, threshold)).toEqual({ noneFit: 0, unsure: 1 });
  });

  it("ignores assigned entries entirely", () => {
    const log: AiLogEntry[] = [logEntry({ id: "1", assigned: true, confidence: 0.95 })];
    expect(remainderCounts(log, threshold)).toEqual({ noneFit: 0, unsure: 0 });
  });

  it("treats a confidence exactly at the threshold as 'none fit', matching decideClassification's >= rule", () => {
    const log: AiLogEntry[] = [logEntry({ id: "1", assigned: false, confidence: threshold })];
    expect(remainderCounts(log, threshold)).toEqual({ noneFit: 1, unsure: 0 });
  });

  it("describes both counts as separate, honestly-worded sentences", () => {
    const lines = describeRemainder(t, { noneFit: 25, unsure: 33 });
    expect(lines).toEqual([
      "25 bookmarks didn't fit any collection.",
      "33 came close, but below your confidence setting.",
    ]);
  });

  it("says nothing when there's nothing to report", () => {
    expect(describeRemainder(t, { noneFit: 0, unsure: 0 })).toEqual([]);
  });
});

describe("organize-utils — reviewConfidenceLabel", () => {
  it("is 'Likely' at or above the threshold, 'Maybe' below it — never a raw decimal", () => {
    expect(reviewConfidenceLabel(t, 0.6)).toBe("Likely");
    expect(reviewConfidenceLabel(t, 0.95)).toBe("Likely");
    expect(reviewConfidenceLabel(t, 0.59)).toBe("Maybe");
  });
});

describe("organize-utils — reviewRows", () => {
  const items: Bookmark[] = [
    bookmark({ id: "a", title: "Post about design" }),
    bookmark({ id: "b", title: "Never synced locally, unused" }),
  ];

  function reviewItem(overrides: Partial<ReviewItem> & { bookmarkId: string }): ReviewItem {
    return { listId: "list-1", listName: "Design", confidence: 0.7, ...overrides };
  }

  it("maps review items onto the local library, in the order given", () => {
    const rows = reviewRows([reviewItem({ bookmarkId: "a", confidence: 0.82 })], items, t);
    expect(rows).toEqual([{ bookmarkId: "a", title: "Post about design", author: null, listId: "list-1", listName: "Design", confidence: 0.82 }]);
  });

  it("drops an id the local library doesn't have", () => {
    const rows = reviewRows([reviewItem({ bookmarkId: "unknown-id" })], items, t);
    expect(rows).toEqual([]);
  });
});

describe("organize-utils — clusterMemberTitles", () => {
  const items: Bookmark[] = [
    bookmark({ id: "a", title: "Post about design" }),
    bookmark({ id: "b", title: "Post about servers" }),
  ];

  it("resolves member ids to local titles, dropping ids not yet synced", () => {
    expect(clusterMemberTitles(["a", "unknown", "b"], items, t)).toEqual(["Post about design", "Post about servers"]);
  });
});

describe("organize-utils — cluster footer helpers", () => {
  function proposal(overrides: Partial<ClusterProposal> & { id: string; memberIds: string[] }): ClusterProposal {
    return { name: "Design", why: "", size: overrides.memberIds.length, sampleTitles: [], existingListId: null, ...overrides };
  }

  it("composes the sticky footer's label from two independently-pluralized parts", () => {
    expect(describeClusterFooterLabel(t, 6, 412)).toBe("Create 6 collections and file 412 bookmarks");
    expect(describeClusterFooterLabel(t, 1, 1)).toBe("Create 1 collection and file 1 bookmark");
  });

  it("counts only the ticked proposals' own members, ignoring a possibly-stale size", () => {
    const proposals = [
      proposal({ id: "p1", memberIds: ["a", "b"], size: 99 }),
      proposal({ id: "p2", memberIds: ["c"] }),
    ];
    expect(tickedClusterCounts(proposals, ["p1"])).toEqual({ collections: 1, bookmarks: 2 });
    expect(tickedClusterCounts(proposals, ["p1", "p2"])).toEqual({ collections: 2, bookmarks: 3 });
    expect(tickedClusterCounts(proposals, [])).toEqual({ collections: 0, bookmarks: 0 });
  });

  it("doesn't count a group that joins an existing collection as created", () => {
    const proposals = [
      proposal({ id: "p1", memberIds: ["a", "b"] }),
      proposal({ id: "p2", memberIds: ["c"], existingListId: "list-1" }),
    ];
    expect(tickedClusterCounts(proposals, ["p1", "p2"])).toEqual({ collections: 1, bookmarks: 3 });
    expect(tickedClusterCounts(proposals, ["p2"])).toEqual({ collections: 0, bookmarks: 1 });
    expect(describeClusterFooterLabel(t, 0, 1)).toBe("File 1 bookmark");
  });

  it("says nothing once there's nothing unclustered to mention", () => {
    expect(describeUnclustered(t, 0)).toBeNull();
    expect(describeUnclustered(t, 1)).toBe("1 bookmark didn't form a clear group — you can file it by hand below or suggest again later.");
    expect(describeUnclustered(t, 87)).toBe("87 bookmarks didn't form a clear group — you can file them by hand below or suggest again later.");
  });
});
