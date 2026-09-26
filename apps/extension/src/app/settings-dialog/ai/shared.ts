import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "@astryxdesign/core/Toast";
import { useI18n } from "../../../i18n";
import { loadAiStatus, subscribeToAiStatus, type AiStatus } from "../../../../lib/ai-client";
import { loadAiSettings, saveAiSettings, subscribeToAiSettings, type AiSettings } from "../../../../lib/ai-settings";

/** `t` on its own, for a module-level helper that builds a string outside a
 *  component and so can't call `useI18n()` itself — every file under `ai/`
 *  threads this through instead of re-deriving the type. */
export type TFunction = ReturnType<typeof useI18n>["t"];

/**
 * Async panel work outlives the dialog: a status read or a proposal can land
 * after the user has closed Settings, and a state update then is a wasted
 * render at best. Shared by every file under `ai/`, so a component that reads
 * or writes across an await always has the same guard available.
 */
export function useIsMounted(): () => boolean {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return useCallback(() => mounted.current, []);
}

/**
 * `settings` is `null` until `ai.settings` has been read. `commit` patches the
 * stored value; the loader normalises whatever comes back, so a control can't
 * put an out-of-range number into the store.
 */
export function useAiSettings(): { settings: AiSettings | null; commit(patch: Partial<AiSettings>): void } {
  const toast = useToast();
  const { t } = useI18n();
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const isMounted = useIsMounted();

  useEffect(() => {
    // Another extension context can save settings while the panel is open, so
    // the subscription — not just the initial load — keeps every row honest.
    void loadAiSettings().then((loaded) => {
      if (isMounted()) setSettings(loaded);
    });
    return subscribeToAiSettings((next) => {
      if (isMounted()) setSettings(next);
    });
  }, [isMounted]);

  const commit = useCallback(
    (patch: Partial<AiSettings>) => {
      void saveAiSettings(patch).then(
        (saved) => {
          if (isMounted()) setSettings(saved);
        },
        (error: unknown) => {
          console.error("[Nook] Failed to save AI settings:", error);
          toast({ body: t("ai.errors.couldNotSaveSettings"), type: "error" });
        },
      );
    },
    [isMounted, toast, t],
  );

  return { settings, commit };
}

/** How often the status is re-read while a queue is draining. Fast enough that
 *  the depth visibly falls, slow enough that watching it is not a request every
 *  second for a batch that takes tens of seconds anyway. */
export const STATUS_POLL_MS = 4000;

/**
 * The panel's live view of `GET /api/ai/status`.
 *
 * A pass is not a request this browser can hold open: `POST /api/ai/run`
 * enqueues the account's eligible work and returns immediately, the work
 * happens in a worker on the server. The panel's only way to show a queue
 * draining is to re-read the depths every few seconds and stop the moment
 * both are empty — keyed on the depth itself, so React tears the timer down on
 * unmount and on every change of depth.
 */
export function useAiStatus(settings: AiSettings | null): { status: AiStatus | null; isLoading: boolean; refresh(): void } {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const isMounted = useIsMounted();

  const refresh = useCallback(() => {
    void loadAiStatus().then((next) => {
      if (!isMounted()) return;
      setStatus(next);
      setIsLoading(false);
    });
  }, [isMounted]);

  useEffect(() => {
    // The same "nook-db" channel a settings save announces on, so a toggle
    // flipped in another tab — or a run requested there — refreshes the status
    // here without this panel having to poll for it.
    return subscribeToAiStatus((next) => {
      if (!isMounted()) return;
      setStatus(next);
      setIsLoading(false);
    });
  }, [isMounted]);

  // Re-read when the account's settings change: turning a feature on is the
  // moment a run is most likely to start.
  useEffect(() => {
    if (settings) refresh();
  }, [refresh, settings]);

  // Both queues, because both drain in the same worker.
  const pending = (status?.pending ?? 0) + (status?.summarize.pending ?? 0);
  useEffect(() => {
    if (pending <= 0) return;
    const timer = setInterval(refresh, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, [pending, refresh]);

  return { status, isLoading, refresh };
}

/** Two decimals, so a dragged 0.9 reads as the 0.90 the default is stored as. */
export function formatConfidence(value: number): string {
  return value.toFixed(2);
}

/**
 * Which of the two independent server deployments is missing, from one status
 * read. `classify` needs `TYPESAFE_API_KEY`; `summarize` covers both
 * summarising *and* proposing collections/tags, because both routes resolve
 * the same `NOOK_AI_PROPOSER` + provider key on the server
 * (`aiAvailability().proposeTaxonomy` in apps/api/src/ai.ts and
 * `summarizeAvailability().summarize` in apps/api/src/summarize.ts are the same
 * `Boolean(resolveProposer())` check) — there is no separate wire field for
 * "can propose collections", and `status.summarize.available` is it.
 *
 * `"all"` is the one case worth a single banner at the top of the panel; the
 * other two are worth a short note on just the step they affect, so nothing
 * gets told twice.
 */
export type AiOutage = "none" | "classify" | "summarize" | "all";

export function outageKind(status: AiStatus | null): AiOutage {
  if (!status) return "none";
  const classifyDown = !status.available;
  const summarizeDown = !status.summarize.available;
  if (classifyDown && summarizeDown) return "all";
  if (classifyDown) return "classify";
  if (summarizeDown) return "summarize";
  return "none";
}
