import { useEffect, useMemo, useRef, useState } from "react";
import {
  isSearchConfigured,
  localResults,
  resolveServerIds,
  searchLibrary,
  shouldUseServerSearch,
  type SearchDeps,
  type SearchFallback,
  type SearchFilters,
  type SearchOutcome,
  type SearchReason,
} from "../../../lib/retrieval";
import { translate } from "../../i18n/core";
import type { MessageKey, ParamsFor } from "../../i18n/types";
import type { Bookmark, Media } from "../../../lib/types";

/**
 * The shape of `useI18n().t` — accepted as a parameter by the plain (non-React)
 * helpers below instead of a hook call, so they stay pure and unit-testable
 * without rendering. Every helper defaults its `t` param to English (see
 * `defaultT`) so existing callers that don't pass one keep returning the same
 * English copy they always have.
 */
export type TranslateFn = <K extends MessageKey>(key: K, params?: ParamsFor<K>) => string;

const defaultT: TranslateFn = (key, params) => translate("en", key, params);

// The dashboard names the reason a search stayed local, so the type travels with
// the hook that reports it rather than making every caller reach into lib/ for it.
export type { SearchFallback } from "../../../lib/retrieval";

export type LibraryView =
  | { kind: "all" | "x" | "chrome" | "unorganized" }
  | { kind: "list"; id: string }
  | { kind: "tag"; id: string };
export type MediaFilter = "all" | "media" | "text";
export type BookmarkViewMode = "cards" | "table";
export type LightboxState = { media: Media[]; index: number } | null;

export const DEFAULT_CARD_PAGE_SIZE = 24;
export const DEFAULT_TABLE_PAGE_SIZE = 25;
export const DEFAULT_VIEW: LibraryView = { kind: "all" };
export const LIST_EMOJIS = ["📁", "✦", "♡", "✈️", "☕", "🎨", "📚", "🌿"];

/**
 * How long typing has to pause before the server is asked.
 *
 * The dashboard search box has no debounce of its own — the local pass is one
 * substring match per bookmark and is meant to run on every keystroke — so this
 * is the only gate between a burst of typing and a request. 200ms matches the
 * other user-input debounce in this app (`useBookmarkLibrary`'s 150ms library
 * reload is the closest, `subscribeCloudStatus` uses 250ms) and sits well under
 * the ~50ms of work a request actually costs, so a query still feels answered the
 * moment the user stops typing.
 */
export const SEARCH_DEBOUNCE_MS = 200;

export function hasNote(item: Bookmark) {
  return Boolean(item.note?.trim());
}

export function hasMedia(item: Bookmark) {
  return Boolean(
    (item.media?.length || item.attachments?.length || 0) > 0 ||
    (item.quote?.media?.length || 0) > 0,
  );
}

export function itemMedia(item: Bookmark): Media[] {
  return item.media?.length ? item.media : item.attachments || [];
}

export function allItemMedia(item: Bookmark): Media[] {
  return [...itemMedia(item), ...(item.quote?.media || [])];
}

export function visibleText(item: Bookmark) {
  return item.description || item.shortDescription || item.title || "";
}

export function itemTitle(item: Bookmark, t: TranslateFn = defaultT) {
  if (item.source === "chrome") {
    return item.title || item.creator?.name || item.creator?.handle || t("dashboard.detail.webBookmarkFallback");
  }
  return item.creator?.name || item.creator?.handle || t("dashboard.detail.xPostFallback");
}

export function getTags(items: Bookmark[]) {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const rawTag of item.tags || []) {
      const tag = rawTag.trim().toLowerCase().replace(/^#/, "");
      if (tag) counts.set(tag, (counts.get(tag) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1]);
}

/**
 * The view pipeline: everything the sidebar, the media tabs and the notes toggle
 * decide, and nothing about the search box.
 *
 * Split out from the search on purpose. A server answer is a set of ids, and the
 * view the user is looking at has to stay authoritative over it: the index knows
 * about collections, tags and sources, but not about "with media" or "with notes",
 * and it must never widen the view the user picked. So the visible set is always
 * `this` filtered by whatever the current pass admitted.
 */
export function matchesLibraryView(
  item: Bookmark,
  view: LibraryView,
  mediaFilter: MediaFilter,
  notesOnly: boolean,
): boolean {
  if (view.kind === "x" && item.source !== "x") return false;
  if (view.kind === "chrome" && item.source !== "chrome") return false;
  if (view.kind === "unorganized" && item.listId) return false;
  if (view.kind === "list" && item.listId !== view.id) return false;
  if (
    view.kind === "tag" &&
    !(item.tags || []).some((tag) => tag.toLowerCase().replace(/^#/, "") === view.id)
  ) return false;
  if (mediaFilter === "media" && !hasMedia(item)) return false;
  if (mediaFilter === "text" && hasMedia(item)) return false;
  if (notesOnly && !hasNote(item)) return false;
  return true;
}

/**
 * The facets to send with a query, so the server ranks inside the view the user
 * is already looking at rather than the whole library.
 *
 * Only the three facets the route accepts: `unorganized` and the media/notes
 * toggles have no server-side equivalent and stay local, which
 * `matchesLibraryView` then applies to whatever comes back.
 */
export function searchFiltersForView(view: LibraryView): SearchFilters {
  if (view.kind === "list") return { collections: [view.id] };
  if (view.kind === "tag") return { tags: [view.id] };
  if (view.kind === "x") return { sources: ["x"] };
  if (view.kind === "chrome") return { sources: ["chrome"] };
  return {};
}

// -- library search ---------------------------------------------------------

/** What the server's ids mean for the list the user is looking at. */
export interface SemanticSearch {
  /** Matches the server found after filtering, before the limit slice. */
  total: number;
  /** The server's own reason, when it sent one alongside the ids. */
  reason?: SearchReason;
}

export interface LibrarySearch {
  /** What to render: the local pass, or the server's ids resolved onto the view. */
  items: Bookmark[];
  /** Set only when the server's ids are what `items` is. */
  semantic: SemanticSearch | null;
  /** Why the local pass stands instead, when the server could not answer. */
  fallback: SearchFallback | null;
  /** A request is in flight, so a local empty result is not the final answer. */
  isPending: boolean;
}

export interface UseLibrarySearchOptions {
  /** Everything the view pipeline already admitted — see `matchesLibraryView`. */
  items: Bookmark[];
  /** The raw search box value. */
  query: string;
  /** Whether a request may be made at all (signed in, and not offline). */
  canSearch: boolean;
  /** Why not, while `canSearch` is false. Null while the answer is still unknown. */
  blockedReason?: SearchFallback | null;
  /** Facets mirroring the current view. */
  filters?: SearchFilters;
  /** Injected by tests; production passes nothing and gets the cloud session. */
  deps?: SearchDeps;
  debounceMs?: number;
}

/**
 * The library's search, as one hook: the local pass now, the server pass when it
 * is worth one, and the visible set that the two of them add up to.
 *
 * Three properties this owns, because each of them is a way the feature breaks:
 *
 * 1. **The list is never empty because a request is in flight.** `items` is the
 *    local pass from the first keystroke; a server answer only ever *replaces* it.
 * 2. **A slow answer cannot overwrite a newer one.** Every eligible query takes a
 *    ticket from a counter that only goes up, and a response is dropped unless it
 *    still holds the current ticket. Re-typing during a request is the normal
 *    case, not the edge case, and the second answer is the one the user is
 *    waiting for. The answer is also keyed by the query that produced it, so a
 *    mismatch cannot be applied even if the counter were somehow wrong.
 * 3. **Nothing the server says can empty the view.** A signed-out browser, an
 *    offline one, an index that does not exist, a 5xx and a body we cannot read
 *    all leave `items` on the local pass — see `describeSearchSignal` for what,
 *    if anything, the user is told about it.
 */
export function useLibrarySearch(options: UseLibrarySearchOptions): LibrarySearch {
  const { items, query, canSearch, blockedReason, filters, deps, debounceMs = SEARCH_DEBOUNCE_MS } = options;
  const trimmed = query.trim();

  const local = useMemo(() => localResults(items, trimmed), [items, trimmed]);

  // Read through a ref inside the timer callback rather than closed over, so the
  // effect never has to depend on an object identity: `deps` and `filters` are
  // fresh literals on every render, and depending on them would re-arm the timer
  // on every render, forever.
  const latest = useRef({ deps, filters });
  const [answered, setAnswered] = useState<{ query: string; outcome: SearchOutcome } | null>(null);
  const [isPending, setIsPending] = useState(false);
  const ticketRef = useRef(0);

  useEffect(() => {
    latest.current = { deps, filters };
  });

  useEffect(() => {
    // A mount that goes away must not be written to by a request it started, so
    // retiring every outstanding ticket on unmount is all the guard that needs.
    return () => {
      ticketRef.current++;
    };
  }, []);

  useEffect(() => {
    // Taken before the eligibility checks, not after: a query that never reaches
    // the server still retires the answer of the one before it, which is the whole
    // point when the user deletes a character mid-request.
    const ticket = ++ticketRef.current;
    // Nothing to wait for means nothing pending. A `#tag` query typed over an
    // in-flight bare query must stop claiming to be looking.
    if (!trimmed || !canSearch || !shouldUseServerSearch(trimmed)) {
      setIsPending(false);
      return;
    }
    // Learned from a previous answer, so a server with no index is not asked again
    // on every pause in typing. Checked here and again inside `searchLibrary`,
    // which is what makes the library safe on its own.
    if (!isSearchConfigured()) {
      setIsPending(false);
      return;
    }

    const timer = setTimeout(() => {
      setIsPending(true);
      void searchLibrary(trimmed, { ...latest.current.deps, filters: latest.current.filters })
        .then((outcome) => {
          if (ticketRef.current !== ticket) return;
          setAnswered({ query: trimmed, outcome });
        })
        .catch((error) => {
          // `searchLibrary` reports its own failures as outcomes, so reaching this
          // is a bug in it — and an unhandled rejection here would take the whole
          // dashboard down over a search box, which is the one thing the feature
          // must never do.
          console.error("[Nook] Search failed unexpectedly:", error);
        })
        .finally(() => {
          if (ticketRef.current === ticket) setIsPending(false);
        });
    }, debounceMs);

    return () => clearTimeout(timer);
  }, [trimmed, canSearch, debounceMs]);

  // The answer is only in play for the query that asked for it, which is also what
  // makes clearing the box return the normal view on the keystroke rather than on
  // the arrival of whatever request was still in flight.
  const active = answered && answered.query === trimmed ? answered.outcome : null;
  const semantic = active && active.ids.length > 0 && active.fallback === null ? active : null;

  // Signing out or going offline drops back to the local pass rather than leaving
  // an answer on screen that a request the user is no longer entitled to made.
  if (!canSearch) {
    return { items: local, semantic: null, fallback: blockedReason ?? null, isPending: false };
  }
  if (semantic) {
    // Resolved against `items`, never against `local`: a semantic hit is by
    // definition one the substring pass would have missed, so intersecting with it
    // would throw the feature's own results away.
    return {
      items: resolveServerIds(items, semantic.ids),
      semantic: { total: semantic.total, ...(semantic.reason ? { reason: semantic.reason } : {}) },
      fallback: null,
      isPending,
    };
  }
  return {
    items: local,
    semantic: null,
    fallback: active ? active.fallback : null,
    isPending,
  };
}

// -- what the search says ---------------------------------------------------

export interface SearchSignalInfo {
  /** Short, non-colour name of the state, and the StatusDot's accessible name. */
  label: string;
  /** The sentence shown next to it. */
  detail: string;
  variant: "accent" | "neutral" | "warning";
}

/**
 * The one line that says which pass produced the list, or null when there is
 * nothing worth saying.
 *
 * The silence is the design decision here. `unconfigured` means an operator has
 * not set a key on a server the user never asked to run a model on, and `failed`
 * is either a bug of ours or a 5xx — neither is something the user can act on, and
 * a red dot for a feature they did not turn on teaches them that a feature is
 * broken. So those stay quiet, and the local pass simply is the answer. Signed-out
 * and offline *do* get a line, because the user can leave both of those states and
 * the sync indicator already reports them elsewhere in the frame.
 */
export function describeSearchSignal(search: LibrarySearch, t: TranslateFn = defaultT): SearchSignalInfo | null {
  if (search.semantic) {
    return {
      label: t("dashboard.search.semanticLabel"),
      detail: t("dashboard.search.semanticDetail"),
      variant: "accent",
    };
  }
  switch (search.fallback) {
    case "signed-out":
      return {
        label: t("dashboard.search.keywordLabel"),
        detail: t("dashboard.search.signedOutDetail"),
        variant: "neutral",
      };
    case "offline":
      return {
        label: t("dashboard.search.keywordLabel"),
        detail: t("dashboard.search.offlineDetail"),
        variant: "warning",
      };
    case "unsearchable":
      return {
        label: t("dashboard.search.keywordLabel"),
        detail: t("dashboard.search.unsearchableDetail"),
        variant: "neutral",
      };
    default:
      return null;
  }
}

/**
 * The count line. `total` is the server's count before it sliced the page, so a
 * query that matched more than one request's worth of bookmarks says so instead of
 * implying the library only holds that many.
 */
export function describeSearchCount(
  search: LibrarySearch,
  shown: number,
  query: string,
  t: TranslateFn = defaultT,
): string {
  if (!query) return t("dashboard.itemCount", { count: shown });
  const total = search.semantic?.total ?? 0;
  if (total > shown) {
    return t("dashboard.search.countWithQueryTotal", { count: shown, shown, total, query });
  }
  return t("dashboard.search.countWithQuery", { count: shown, query });
}

export interface EmptySearchCopy {
  title: string;
  description: string;
}

/**
 * The empty state, told apart by which pass produced nothing — a user who searched
 * for a word nothing contains deserves to know the index was asked too, because
 * that is the difference between "not here" and "not anywhere".
 */
export function describeEmptySearch(
  search: LibrarySearch,
  query: string,
  libraryCount: number,
  t: TranslateFn = defaultT,
): EmptySearchCopy {
  if (libraryCount === 0) {
    return {
      title: t("dashboard.emptyState.libraryReadyTitle"),
      description: t("dashboard.emptyState.libraryReadyDescription"),
    };
  }
  const noResultsTitle = query
    ? t("dashboard.emptyState.noResultsForQuery", { query })
    : t("dashboard.emptyState.noMatchingBookmarks");
  if (search.isPending) {
    return {
      title: noResultsTitle,
      description: t("dashboard.emptyState.stillLookingDescription"),
    };
  }
  if (search.fallback === "unsearchable") {
    return {
      title: noResultsTitle,
      description: t("dashboard.emptyState.nothingMatchesDescription"),
    };
  }
  return {
    title: t("dashboard.emptyState.noMatchingBookmarks"),
    description: t("dashboard.emptyState.tryAnotherSearchDescription"),
  };
}
