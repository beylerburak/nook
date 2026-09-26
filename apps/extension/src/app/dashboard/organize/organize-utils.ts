/**
 * Pure helpers for the Organize page (OrganizePage.tsx) — everything that can
 * be computed without rendering anything, so it can be unit-tested without a
 * DOM. Nothing here calls a hook or touches the network; `OrganizePage.tsx`
 * and `RecentlyFiled.tsx` are the only callers.
 */
import type { AiLogEntry } from "../../../../lib/ai-client";
import type { Bookmark, BookmarkList } from "../../../../lib/types";
import { itemTitle, visibleText, type TranslateFn } from "../bookmark-utils";

/** How many bookmarks the server's per-minute worker files, roughly — see
 *  docs/ai.md and CLASSIFY_BATCH_SIZE/the per-minute tick in apps/api/src/ai-jobs.ts.
 *  Just enough precision for "about N minutes", not a promise. */
const BOOKMARKS_PER_MINUTE = 25;

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

export function describeSuggestPrompt(t: TranslateFn, unfiledCount: number): string {
  return t("dashboard.organize.suggestPrompt", { count: unfiledCount });
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

function rowText(item: Bookmark, t: TranslateFn): { title: string; author: string | null } {
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
