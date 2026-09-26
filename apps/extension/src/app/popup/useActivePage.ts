import { useCallback, useEffect, useRef, useState } from "react";
import { translate, useI18n, type Locale } from "../../i18n";
import type {
  ActivePageState,
  ActivePageStateResponse,
  BookmarkPatch,
  MessageResponse,
  PopupToBackgroundMessage,
} from "../../../lib/types";

export type ActivePagePhase = "loading" | "ready" | "error";

/**
 * Wraps chrome.runtime.sendMessage in a promise and treats the two ways a
 * background handler can fail to answer (chrome.runtime.lastError, or a
 * response that never arrives because no listener returned true/handled it)
 * as ordinary rejections, so callers get one error-handling path instead of
 * having to check chrome.runtime.lastError by hand after every call.
 */
function sendToBackground<TResponse>(message: PopupToBackgroundMessage, locale: Locale): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(message, (response: TResponse) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          reject(new Error(lastError.message || translate(locale, "extension.errors.backgroundNotResponding")));
          return;
        }
        if (response === undefined) {
          reject(new Error(translate(locale, "extension.errors.backgroundNotResponding")));
          return;
        }
        resolve(response);
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export interface UseActivePageResult {
  /** What the popup should show for the tab it was opened on; null while still loading or on error. */
  state: ActivePageState | null;
  phase: ActivePagePhase;
  /** Set on the "error" phase, and also surfaced (non-fatally) when save/remove/patch fail. */
  error: string | null;
  isSaving: boolean;
  isRemoving: boolean;
  /** Re-fetches GET_ACTIVE_PAGE_STATE, e.g. for a "Retry" button after a failed load. */
  refresh: () => Promise<void>;
  /** Sends SAVE_ACTIVE_PAGE and adopts the returned state. Throws on failure so callers can toast. */
  save: () => Promise<void>;
  /** Removes the current page's bookmark (optimistically clears it from state). Throws on failure. */
  remove: () => Promise<void>;
  /** Patches the current page's bookmark (note/tags/collection). Optimistic with rollback; never throws. */
  patchBookmark: (patch: BookmarkPatch) => Promise<boolean>;
}

/**
 * Owns everything the popup needs to know about the tab it was opened on:
 * loading/error/ready state for GET_ACTIVE_PAGE_STATE, and the save/remove/
 * patch actions from the popup contract in lib/types.ts. The background
 * handlers for these messages are being built in parallel, so every call
 * degrades to a catchable error (never an unhandled rejection or a silent
 * hang) when the handler isn't there yet.
 */
export function useActivePage(): UseActivePageResult {
  const { t, locale } = useI18n();
  const [state, setState] = useState<ActivePageState | null>(null);
  const [phase, setPhase] = useState<ActivePagePhase>("loading");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const isMountedRef = useRef(true);

  useEffect(() => () => {
    isMountedRef.current = false;
  }, []);

  const refresh = useCallback(async () => {
    setPhase((current) => (current === "ready" ? current : "loading"));
    setError(null);
    try {
      const response = await sendToBackground<ActivePageStateResponse>({ type: "GET_ACTIVE_PAGE_STATE" }, locale);
      if (!response.success || !response.state) {
        throw new Error(response.error || t("popup.errors.readError"));
      }
      if (!isMountedRef.current) return;
      setState(response.state);
      setPhase("ready");
    } catch (err) {
      if (!isMountedRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setPhase("error");
    }
  }, [locale, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async () => {
    setIsSaving(true);
    setError(null);
    try {
      const response = await sendToBackground<ActivePageStateResponse>({ type: "SAVE_ACTIVE_PAGE" }, locale);
      if (!response.success || !response.state) {
        throw new Error(response.error || t("popup.errors.saveFailed"));
      }
      if (isMountedRef.current) setState(response.state);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isMountedRef.current) setError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      if (isMountedRef.current) setIsSaving(false);
    }
  }, [locale, t]);

  const remove = useCallback(async () => {
    if (!state || state.kind !== "page" || !state.bookmark) return;
    const id = state.bookmark.id;
    setIsRemoving(true);
    setError(null);
    try {
      const response = await sendToBackground<MessageResponse>({ type: "REMOVE_BOOKMARK", id }, locale);
      if (!response.success) {
        throw new Error(response.error || t("popup.errors.removeFailed"));
      }
      if (isMountedRef.current) {
        setState((current) => (current && current.kind === "page" ? { ...current, bookmark: null } : current));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (isMountedRef.current) setError(message);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      if (isMountedRef.current) setIsRemoving(false);
    }
  }, [state, locale, t]);

  const patchBookmark = useCallback(async (patch: BookmarkPatch): Promise<boolean> => {
    if (!state || state.kind !== "page" || !state.bookmark) return false;
    const id = state.bookmark.id;
    const previousBookmark = state.bookmark;
    // Optimistic: the popup is small and reused across tags/note/collection
    // edits, so waiting on a round trip for every keystroke-adjacent action
    // would make it feel sluggish. Rolled back on failure below.
    setState((current) =>
      current && current.kind === "page" && current.bookmark
        ? { ...current, bookmark: { ...current.bookmark, ...patch } }
        : current,
    );
    try {
      const response = await sendToBackground<MessageResponse>({ type: "UPDATE_BOOKMARK", id, patch }, locale);
      if (!response.success) throw new Error(response.error || t("popup.errors.saveChangesFailed"));
      return true;
    } catch (err) {
      if (isMountedRef.current) {
        setState((current) =>
          current && current.kind === "page" ? { ...current, bookmark: previousBookmark } : current,
        );
        setError(err instanceof Error ? err.message : String(err));
      }
      return false;
    }
  }, [state, locale, t]);

  return { state, phase, error, isSaving, isRemoving, refresh, save, remove, patchBookmark };
}
