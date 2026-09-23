export interface Bookmark {
  id: string;
  source: string;
  title?: string;
  shortDescription?: string;
  description?: string;
  note?: string;
  url?: string | null;
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

export type ContentToBackgroundMessage =
  | { type: "SAVE_ITEM"; item: Bookmark }
  | { type: "UPDATE_BOOKMARK_NOTE"; id: string; note: string }
  | { type: "SYNC_ITEMS_BATCH"; items: Bookmark[] }
  | { type: "STORE_QUERY_ID"; queryId: string }
  | { type: "GET_QUERY_ID" }
  | { type: "START_AUTO_SYNC_X" }
  | { type: "CLOSE_CURRENT_TAB" };

export type BackgroundToContentMessage =
  | { type: "BEGIN_AUTO_SYNC"; queryId?: string | null }
  | { type: "NOOK_QUERY_ID"; queryId: string }
  | { type: "NOOK_SYNC_BOOKMARKS"; data: XApiResponse };

export interface MessageResponse {
  success?: boolean;
  error?: string;
  count?: number;
  updated?: number;
  queryId?: string | null;
  received?: boolean;
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
