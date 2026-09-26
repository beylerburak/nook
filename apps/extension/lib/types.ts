/**
 * Provenance of an automated decision, so the UI can tell the model's work
 * apart from the user's own. Written to `ai` by lib/ai-classify.ts; the data
 * it describes lives in `listId`/`listName`/`tags`, not here.
 */
export interface AiAttribution {
  /** Model version that made the decision, e.g. "jev-1.13.0". */
  model: string;
  /** ISO timestamp of the decision. */
  at: string;
  /** Confidence of the collection assignment. Absent when nothing was filed. */
  collectionConfidence?: number;
  /** noul score per applied tag name. Absent when no tag was added. */
  tagConfidence?: Record<string, number>;
  /** ISO date the taxonomy in force was accepted (stamped by the runner, which owns `ai.taxonomy`). */
  taxonomyAt?: string;
}

export interface Bookmark {
  id: string;
  source: string;
  title?: string;
  shortDescription?: string;
  description?: string;
  /**
   * One or two sentences of plain text summarising `description`, in the
   * content's own language. TOP-LEVEL, and deliberately not inside `ai`:
   *
   * The two are set independently, and `ai` is merged as a *unit* —
   * cloud-merge.ts takes it from whichever side supplied the `listId`, so that
   * a filing and its receipt cannot disagree. A summary is not a receipt for
   * anything, so that rule buys it nothing and costs a real summary: a summary
   * written to an unfiled bookmark would be silently discarded the moment
   * another device assigned it to a collection, because the side that
   * supplied the `listId` supplied the whole `ai` object and the summary
   * riding along inside it went with the old copy.
   *
   * Top-level, it is not in cloud-merge.ts's `BOOKMARK_SPECIAL_KEYS` and
   * therefore takes the generic `pickField` path — newer wins, with the older
   * side filling in when the newer has none. That is the correct rule for "the
   * newest summary of this bookmark wins", and it is the whole reason for the
   * placement.
   *
   * The model's words, not the user's. The server reads records and returns
   * summaries but never writes this field (apps/api/src/summarize.ts): it goes
   * through the normal sync path so every device gets it and the client owns
   * the write. `null` and `""` both mean "no summary", so a cleared one is
   * summarised again rather than merged as a permanent blank.
   */
  summary?: string | null;
  note?: string;
  url?: string | null;
  /** Normalized `url` (tracking params / hash stripped), indexed for dedupe. Maintained by lib/db.ts. */
  urlKey?: string;
  urls?: string[];
  savedAt?: string;
  /** X timeline's bookmark ordering key; larger values appear first. */
  xSortIndex?: string;
  createdAt?: string | null;
  updatedAt?: string;
  deletedAt?: string | null;
  tags?: string[];
  listId?: string | null;
  listName?: string | null;
  /**
   * AI provenance for the `listId`/`tags` above - who filed this, when, and how
   * confident they were. The real data is written to `listId`/`listName`/`tags`;
   * this is only the receipt, and `null` counts as "never classified" so that
   * `ai == null` works as the once-only marker (lib/ai-classify.ts). The open
   * index signature carries it through storage and sync with no schema change.
   */
  ai?: AiAttribution | null;
  category?: string | null;
  media?: Media[];
  attachments?: Media[];
  quote?: Quote | null;
  creator?: Creator;
  [field: string]: unknown;
}

export interface BookmarkList {
  id: string;
  name: string;
  icon?: string;
  emoji?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
  [field: string]: unknown;
}

export interface Media {
  type: "image" | "video" | string;
  /** For videos this is the poster image; the playable file is `videoUrl`. */
  url: string;
  alt?: string;
  /** Playable MP4 for X videos/GIFs. Only the X API provides it; DOM saves carry just the poster. */
  videoUrl?: string;
  [field: string]: unknown;
}

export interface Quote {
  id?: string | null;
  url?: string | null;
  text?: string;
  creator?: Creator;
  media?: Media[];
  createdAt?: string | null;
  [field: string]: unknown;
}

export interface Creator {
  name?: string | null;
  handle?: string | null;
  avatar?: string | null;
}

export interface NookMessageBase {
  type: string;
}

export interface ShowBookmarkToastMessage {
  type: "SHOW_BOOKMARK_TOAST";
  message: string;
  bookmarkId?: string;
  toastType?: "info" | "error";
}

/** Why the page in a tab can't be saved (browser-internal pages, the Web Store, …). */
export type PageUnsavableReason = "restricted" | "no-tab";

/** What the popup shows for the active tab. */
export type ActivePageState =
  | { kind: "unsavable"; reason: PageUnsavableReason; url?: string }
  | {
      kind: "page";
      tabId: number;
      url: string;
      title: string;
      hostname: string;
      favIconUrl?: string;
      /** True on an X post page: saving goes through the X parser, not generic page capture. */
      isXPost: boolean;
      /** The saved Nook bookmark for this page, if any (not soft-deleted). */
      bookmark: Bookmark | null;
    };

/** Editable bookmark fields from the popup's quick-organize controls. */
export type BookmarkPatch = Partial<Pick<Bookmark, "note" | "tags" | "listId" | "listName">>;

/** Messages sent by extension pages (popup / dashboard) to the background. */
export type PopupToBackgroundMessage =
  | { type: "SYNC_CLOUD_NOW" }
  | { type: "GET_ACTIVE_PAGE_STATE" }
  | { type: "SAVE_ACTIVE_PAGE" }
  | { type: "REMOVE_BOOKMARK"; id: string }
  | { type: "UPDATE_BOOKMARK"; id: string; patch: BookmarkPatch }
  // Runs one AI classification pass now, and replies with the AiRunResult.
  | { type: "CLASSIFY_NOW" }
  // best-effort server sign-out, clear token, stop alarm; library untouched
  | { type: "CLOUD_SIGN_OUT" }
  // clear token + owner + sync state for THIS server, stop alarm; library untouched
  | { type: "CLOUD_RESET" };

export interface ActivePageStateResponse {
  success: boolean;
  error?: string;
  state?: ActivePageState;
}

export type ContentToBackgroundMessage =
  | { type: "SAVE_ITEM"; item: Bookmark }
  | { type: "GET_NOOK_BOOKMARK_STATES"; ids: string[] }
  | { type: "TOGGLE_NOOK_BOOKMARK"; item: Bookmark }
  | { type: "UPDATE_BOOKMARK_NOTE"; id: string; note: string }
  | ShowBookmarkToastMessage
  | { type: "SYNC_ITEMS_BATCH"; items: Bookmark[] }
  | { type: "STORE_QUERY_ID"; queryId: string }
  | { type: "GET_QUERY_ID" }
  | { type: "START_AUTO_SYNC_X" }
  | { type: "CLOSE_CURRENT_TAB" };

export type BackgroundToContentMessage =
  | { type: "BEGIN_AUTO_SYNC"; queryId?: string | null }
  | { type: "NOOK_QUERY_ID"; queryId: string }
  | { type: "NOOK_SYNC_BOOKMARKS"; data: XApiResponse }
  /** Ask the X content script to parse the post open in the tab (focal tweet on a status page). */
  | { type: "PARSE_FOCAL_TWEET" }
  /** A bookmark's saved state changed elsewhere (e.g. the popup) — let the in-page Nook button on this tab reflect it, if it's showing that post. */
  | { type: "NOOK_BOOKMARK_STATE_CHANGED"; id: string; saved: boolean }
  | ShowBookmarkToastMessage;

/** Reply to PARSE_FOCAL_TWEET. */
export interface ParseFocalTweetResponse {
  success: boolean;
  error?: string;
  item?: Bookmark;
}

export interface MessageResponse {
  success?: boolean;
  error?: string;
  /** Stable machine-readable error code, e.g. "OWNER_MISMATCH" for CLOUD_SIGN_IN. */
  code?: string;
  count?: number;
  updated?: number;
  uploaded?: number;
  downloaded?: number;
  rejected?: number;
  queryId?: string | null;
  received?: boolean;
  saved?: boolean;
  states?: Record<string, boolean>;
}

/**
 * X's private API is inconsistent and changes without notice. Known fields
 * are optional, and the open index signatures let the parser ignore unknown
 * fields while preserving its defensive behavior when X changes its schema.
 */
export interface XApiResponse {
  data?: XApiNode;
  errors?: Array<{ message?: string; [field: string]: any }>;
  [field: string]: any;
}

export interface XApiNode {
  data?: XApiNode;
  bookmark_timeline_v2?: XApiNode;
  bookmark_timeline?: XApiNode;
  bookmarks?: XApiNode;
  timeline?: XApiNode;
  instructions?: XApiNode[];
  entries?: XApiNode[];
  entry?: XApiNode;
  entryId?: string;
  content?: XApiNode;
  item?: XApiNode;
  itemContent?: XApiNode;
  tweet_results?: XApiNode;
  result?: XApiNode;
  tweet?: XApiNode;
  __typename?: string;
  legacy?: XApiNode;
  core?: XApiNode;
  user_results?: XApiNode;
  user?: XApiNode;
  avatar?: XApiNode;
  image_url?: string;
  name?: string;
  screen_name?: string;
  full_text?: string;
  text?: string;
  [field: string]: any;
}

export interface ParsedTweetBookmark extends Bookmark {
  title: string;
  description: string;
  url: string;
  creator: Creator & { handle: string; name: string };
}

declare global {
  interface Window {
    __nookBookmarkQueryId?: string;
    _nookUrl?: string;
    _nookUpdateSyncLog?: (count: number) => void;
    _nookAutoSyncing?: boolean;
  }

  interface XMLHttpRequest {
    _nookUrl?: string;
  }
}
