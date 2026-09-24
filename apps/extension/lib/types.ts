export interface Bookmark {
  id: string;
  source: string;
  title?: string;
  shortDescription?: string;
  description?: string;
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
  url: string;
  alt?: string;
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
  | { type: "GET_ACTIVE_PAGE_STATE" }
  | { type: "SAVE_ACTIVE_PAGE" }
  | { type: "REMOVE_BOOKMARK"; id: string }
  | { type: "UPDATE_BOOKMARK"; id: string; patch: BookmarkPatch };

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
  count?: number;
  updated?: number;
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
