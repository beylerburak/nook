import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  announceAiStatusChange,
  loadReview,
  resolveReview,
  subscribeToAiStatus,
  type ReviewItem,
  type ResolveReviewItemInput,
} from "../../../../lib/ai-client";
import { useNookHost } from "../../host/NookHost";
import { useIsMounted } from "../../settings-dialog/ai/shared";
import { REVIEW_LIKELY_THRESHOLD } from "./organize-utils";

/**
 * The review list (`GET /api/ai/review`) as one piece of shared state,
 * loaded once and read by two very different consumers: the "Needs your
 * review" block on the Organize page (`ReviewList.tsx`) and the small
 * "Suggested: X" chip on every `BookmarkCard` (only the ones actually in this
 * list render one at all). Both need the same rows and the same
 * accept/reject action, so this is a context rather than a hook each of them
 * would otherwise call on its own — one `GET`, not one per card.
 *
 * Mounted once in `DashboardApp.tsx`, above both consumers. Refreshes on
 * mount, whenever the shared "nook-db" AI-status channel announces a change
 * (a run requested, a taxonomy or cluster accepted elsewhere), and after every
 * resolve this context makes itself.
 *
 * Resolving is optimistic: the resolved rows leave `items` the instant the
 * request is sent, and only come back (via a fresh read of the whole list)
 * if the server said the call failed outright — a partial `skipped` count in
 * an otherwise-successful response is not treated as a failure, since the
 * three-way split *is* the server's honest answer, not a sign this client's
 * guess about what to remove was wrong.
 */
export interface ReviewListState {
  items: ReviewItem[];
  isLoading: boolean;
  /** True once a load has come back but named a reason rather than a list —
   *  signed out, unavailable, throttled, or a network failure. The Organize
   *  page's "Needs your review" block reads this to show why the block is
   *  empty rather than rendering "nothing to review" for a read that never
   *  actually succeeded. */
  loadFailed: boolean;
  /** Rows at or above `REVIEW_LIKELY_THRESHOLD` — what "Accept all likely"
   *  acts on. */
  likelyItems: ReviewItem[];
  refresh(): void;
  /** Resolves one or many rows at once (a bulk "accept all likely" is one
   *  call, not N). Returns the server's three-way split, or `null` when the
   *  call failed outright — the optimistically-removed rows are restored in
   *  that case. */
  resolve(resolved: ResolveReviewItemInput[]): Promise<{ filed: number; rejected: number; skipped: number } | null>;
}

const ReviewListContext = createContext<ReviewListState | null>(null);

export function ReviewListProvider({ children }: { children: ReactNode }) {
  const value = useReviewListState();
  return <ReviewListContext.Provider value={value}>{children}</ReviewListContext.Provider>;
}

/** Reads the shared review list. Must render under `ReviewListProvider`
 *  (mounted once in `DashboardApp.tsx`). */
export function useReviewList(): ReviewListState {
  const context = useContext(ReviewListContext);
  if (!context) throw new Error("useReviewList must be used within a ReviewListProvider");
  return context;
}

function useReviewListState(): ReviewListState {
  const host = useNookHost();
  const isMounted = useIsMounted();
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);

  const refresh = useCallback(() => {
    void loadReview().then((outcome) => {
      if (!isMounted()) return;
      if (outcome.kind === "items") {
        setItems(outcome.items);
        setLoadFailed(false);
      } else {
        setItems([]);
        setLoadFailed(true);
      }
      setIsLoading(false);
    });
  }, [isMounted]);

  useEffect(() => {
    refresh();
    // The same channel a settings save, a run request or a cluster accept
    // announces on — see ai-client.ts's `announceAiStatusChange`.
    return subscribeToAiStatus(() => refresh());
  }, [refresh]);

  const resolve = useCallback(
    async (resolved: ResolveReviewItemInput[]) => {
      if (resolved.length === 0) return { filed: 0, rejected: 0, skipped: 0 };
      const ids = new Set(resolved.map((entry) => entry.bookmarkId));
      let previous: ReviewItem[] = [];
      setItems((current) => {
        previous = current;
        return current.filter((item) => !ids.has(item.bookmarkId));
      });

      const outcome = await resolveReview({ items: resolved });
      if (outcome.kind !== "resolved") {
        if (isMounted()) setItems(previous);
        return null;
      }
      // A resolve that filed a bookmark changed which collection it's in —
      // the local library needs a sync to see that. A pure reject changed
      // nothing the sync layer tracks, so there's nothing worth a round trip
      // for.
      if (outcome.filed > 0) void host.sync.requestSync();
      announceAiStatusChange();
      return { filed: outcome.filed, rejected: outcome.rejected, skipped: outcome.skipped };
    },
    [isMounted, host],
  );

  const likelyItems = useMemo(() => items.filter((item) => item.confidence >= REVIEW_LIKELY_THRESHOLD), [items]);

  return { items, isLoading, loadFailed, likelyItems, refresh, resolve };
}
