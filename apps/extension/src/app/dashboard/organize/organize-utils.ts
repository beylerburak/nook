/**
 * Pure helpers for the Organize page (OrganizePage.tsx) — everything that can
 * be computed without rendering anything, so it can be unit-tested without a
 * DOM. Nothing here calls a hook or touches the network; `OrganizePage.tsx`
 * and `RecentlyFiled.tsx` are the only callers.
 */
import type { AiLogEntry, ClusterProposal, ReviewItem } from "../../../../lib/ai-client";
import type { Bookmark, BookmarkList } from "../../../../lib/types";
import { itemTitle, visibleText, type TranslateFn } from "../bookmark-utils";

/** How many bookmarks the server's per-minute worker files, roughly — see
 *  docs/ai.md and CLASSIFY_BATCH_SIZE/the per-minute tick in apps/api/src/ai-jobs.ts.
 *  The tick moved from once a minute to once every 10 seconds, a 6x jump; just
 *  enough precision for "about N minutes", not a promise. */
const BOOKMARKS_PER_MINUTE = 150;

/** `>= this` is shown as "Likely", below it as "Maybe" — never the raw
 *  decimal (docs/ai.md's `collectionMinConfidence` already gates which guesses
 *  reach the review list at all; this only decides which of two plain words a
 *  guess that cleared that gate gets). */
export const REVIEW_LIKELY_THRESHOLD = 0.6;

export interface LibraryProgress {
  total: number;
  filed: number;
  unfiled: number;
}

/** `listId` set is Nook's own definition of "filed" — see `bookmarkNeedsClassification`
 *  in apps/api/src/ai-classify.ts, which this mirrors on the client's own copy
 *  of the library (a bookmark the user filed by hand counts as filed too). */
export function libraryProgress(items: Bookmark[]): LibraryProgress {
  const filed = items.filter((item) => Boolean(item.listId)).length;
  return { total: items.length, filed, unfiled: items.length - filed };
}

/** A queue this size takes about this many minutes at the measured rate —
 *  rounded up, and never zero while anything is actually pending, so "about 0
 *  min" never reads as "already done" a moment before it is. */
export function estimateMinutesRemaining(pending: number): number {
  if (pending <= 0) return 0;
  return Math.max(1, Math.ceil(pending / BOOKMARKS_PER_MINUTE));
}

export function describeWorking(t: TranslateFn, pending: number): string {
  return t("dashboard.organize.workingBody", { count: pending, minutes: estimateMinutesRemaining(pending) });
}

/** The header's one-line progress summary — always both counts, so "0 filed"
 *  on a brand-new library reads as a true fact rather than a missing number. */
export function describeProgress(t: TranslateFn, progress: LibraryProgress): string {
  const filed = t("dashboard.organize.filedCount", { count: progress.filed });
  const unfiled = t("dashboard.organize.unfiledCount", { count: progress.unfiled });
  return `${filed} · ${unfiled}`;
}

export interface RecentlyFiledRow {
  id: string;
  title: string;
  /** Who posted it, for an X post — `itemTitle` is the author there, which says
   *  nothing about what was filed, so the text leads and the author follows. */
  author: string | null;
  collectionName: string | null;
  at: string;
}

/**
 * `status.run.log` (last 200 decisions, oldest first — see `pushLogEntry` in
 * apps/api/src/ai-store.ts) mapped onto the bookmarks this client already has
 * synced locally. Only `assigned: true` entries are "recently filed"; the
 * rest feed `remainderCounts` below instead. An id the local library doesn't
 * have (not yet synced, or since deleted) is dropped rather than shown with a
 * blank title.
 *
 * Newest first, capped at `limit` — this is a glance, not the full history.
 */
export function recentlyFiledRows(
  log: AiLogEntry[],
  items: Bookmark[],
  lists: BookmarkList[],
  t: TranslateFn,
  limit = 8,
): RecentlyFiledRow[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const listNameById = new Map(lists.map((list) => [list.id, list.name]));
  const rows: RecentlyFiledRow[] = [];
  for (let index = log.length - 1; index >= 0 && rows.length < limit; index--) {
    const entry = log[index];
    if (!entry.assigned) continue;
    const item = byId.get(entry.id);
    if (!item) continue;
    const collectionName = (item.listId && listNameById.get(item.listId)) || item.listName || null;
    rows.push({ id: item.id, ...rowText(item, t), collectionName, at: entry.at });
  }
  return rows;
}

const SNIPPET_LENGTH = 90;

/** Exported for `reviewRows`/`clusterMemberTitles` below — the same
 *  "snippet + author for an X post, title for everything else" reading of a
 *  bookmark, wherever a row needs to show one without a route of its own. */
export function rowText(item: Bookmark, t: TranslateFn): { title: string; author: string | null } {
  if (item.source === "chrome") return { title: itemTitle(item, t), author: null };
  const text = visibleText(item).replace(/\s+/g, " ").trim();
  const author = item.creator?.name || item.creator?.handle || null;
  if (!text) return { title: itemTitle(item, t), author: null };
  const title = text.length > SNIPPET_LENGTH ? `${text.slice(0, SNIPPET_LENGTH).trimEnd()}…` : text;
  return { title, author };
}

export interface RemainderCounts {
  /** Confidently said no collection fit (the model's `__none__` answer). */
  noneFit: number;
  /** A collection looked plausible, but under the confidence setting —
   *  or the "none fit" answer itself was a close call. Either way, the
   *  honest thing to say is "wasn't sure", not "didn't fit". */
  unsure: number;
}

/**
 * Buckets every `assigned: false` log entry by whether its confidence cleared
 * the account's own threshold.
 *
 * The log (`AiLogEntry`) only carries `{ id, confidence, assigned, at }` — no
 * collection id and no reason — so this is the only signal available for
 * "why". It happens to be suffient: reading `decideClassification` in
 * apps/api/src/ai.ts, the `skipped: "low-confidence"` outcome is only ever
 * returned when `confidence < settings.collectionMinConfidence`, so any
 * unassigned entry *at or above* the threshold can only be the `"none-fit"`
 * outcome (the model chose `__none__`, confidently). Below the threshold, the
 * two outcomes are genuinely indistinguishable from this log alone — but both
 * mean the same true thing to a user: Nook wasn't confident enough to act, so
 * they're one bucket ("unsure") rather than a guess dressed as two.
 */
export function remainderCounts(log: AiLogEntry[], collectionMinConfidence: number): RemainderCounts {
  let noneFit = 0;
  let unsure = 0;
  for (const entry of log) {
    if (entry.assigned) continue;
    if (entry.confidence >= collectionMinConfidence) noneFit++;
    else unsure++;
  }
  return { noneFit, unsure };
}

/** One or two plain sentences describing the remainder, or `[]` when there is
 *  nothing to say yet (a fresh account, or a log with no skips in it). */
export function describeRemainder(t: TranslateFn, counts: RemainderCounts): string[] {
  const lines: string[] = [];
  if (counts.noneFit > 0) lines.push(t("dashboard.organize.remainderNoneFit", { count: counts.noneFit }));
  if (counts.unsure > 0) lines.push(t("dashboard.organize.remainderUnsure", { count: counts.unsure }));
  return lines;
}

// -- "Needs your review" (ReviewList.tsx, useReviewList.tsx) ----------------

/** "Likely" at or above `REVIEW_LIKELY_THRESHOLD`, "Maybe" below — the whole
 *  point being that a raw decimal never reaches the screen (copy rule: no
 *  "confidence score" in the UI). */
export function reviewConfidenceLabel(t: TranslateFn, confidence: number): string {
  return t(confidence >= REVIEW_LIKELY_THRESHOLD ? "dashboard.organize.review.likely" : "dashboard.organize.review.maybe");
}

export interface ReviewRow {
  bookmarkId: string;
  title: string;
  author: string | null;
  listId: string;
  listName: string;
  confidence: number;
}

/**
 * `GET /api/ai/review`'s items, mapped onto the local library the same way
 * `recentlyFiledRows` maps the run log: an id the local library doesn't have
 * (not yet synced, or since deleted) is dropped rather than shown as a blank
 * row. Order is whatever the server sent (highest confidence first, per the
 * contract) — this does no re-sorting of its own.
 */
export function reviewRows(reviewItems: ReviewItem[], items: Bookmark[], t: TranslateFn): ReviewRow[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const rows: ReviewRow[] = [];
  for (const entry of reviewItems) {
    const item = byId.get(entry.bookmarkId);
    if (!item) continue;
    rows.push({ bookmarkId: entry.bookmarkId, ...rowText(item, t), listId: entry.listId, listName: entry.listName, confidence: entry.confidence });
  }
  return rows;
}

// -- "Suggest collections" (ClusterProposals.tsx, useSuggestClusters.ts) ---

/**
 * A proposal's `memberIds` resolved to titles from the local library, for the
 * "show all" expansion — the server already sent `sampleTitles` for the
 * collapsed preview, but the full membership is a client-side lookup since
 * this browser already holds every bookmark the server could have named.
 * An id the local library doesn't have yet is dropped, same as everywhere else
 * on this page.
 */
export function clusterMemberTitles(memberIds: string[], items: Bookmark[], t: TranslateFn): string[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const titles: string[] = [];
  for (const id of memberIds) {
    const item = byId.get(id);
    if (item) titles.push(rowText(item, t).title);
  }
  return titles;
}

/** The sticky footer's label — "Create {parts}", where each part is already
 *  pluralized on its own noun ("6 collections", "412 bookmarks") rather than
 *  one plural table trying to cover two different nouns at once. */
export function describeClusterFooterLabel(t: TranslateFn, collectionCount: number, bookmarkCount: number): string {
  // Every ticked group joins a collection that already exists: nothing is
  // created, so saying "Create 0 collections" would be wrong as well as odd.
  if (collectionCount === 0 && bookmarkCount > 0) {
    return t("dashboard.organize.clusters.fileOnlyLabel", {
      bookmarks: t("dashboard.organize.clusters.bookmarksCount", { count: bookmarkCount }),
    });
  }
  return t("dashboard.organize.clusters.createLabel", {
    collections: t("dashboard.organize.clusters.collectionsCount", { count: collectionCount }),
    bookmarks: t("dashboard.organize.clusters.bookmarksCount", { count: bookmarkCount }),
  });
}

/** The honest line about what didn't form a group, or `null` once there's
 *  nothing left unclustered to mention. */
export function describeUnclustered(t: TranslateFn, unclustered: number): string | null {
  if (unclustered <= 0) return null;
  return t("dashboard.organize.clusters.unclusteredNote", { count: unclustered });
}

/** Total bookmarks the ticked proposals would file — the footer's second
 *  number, and independent of `size` (which may disagree with `memberIds`'s
 *  own length by construction — see `readClusterProposals` in ai-client.ts). */
export function tickedClusterCounts(proposals: ClusterProposal[], acceptedIds: string[]): { collections: number; bookmarks: number } {
  const accepted = proposals.filter((proposal) => acceptedIds.includes(proposal.id));
  const bookmarks = accepted.reduce((total, proposal) => total + proposal.memberIds.length, 0);
  // Only groups that make a new collection count as "created" — one matched to
  // an existing collection files into it and creates nothing.
  const collections = accepted.filter((proposal) => !proposal.existingListId).length;
  return { collections, bookmarks };
}
