import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import { useI18n } from "../../../i18n";
import { requestClassificationRun, type AiStatus } from "../../../../lib/ai-client";
import type { AiSettings } from "../../../../lib/ai-settings";
import { outageKind, type TFunction, useIsMounted } from "./shared";

/**
 * Step 2 — "File bookmarks automatically".
 *
 * The switch is `autoClassify`. Once it is on, Nook's server does not wait for
 * new saves only: the per-minute worker tops up its queue from every eligible
 * bookmark in the account — `data->'ai' IS NULL AND data->'listId' IS NULL`,
 * unfiled and never yet decided, whatever its age (see
 * `topUpClassificationQueue` in apps/api/src/ai-jobs.ts) — 25 at a time, and a
 * larger 500-row top-up every 15 minutes. **Organize unfiled bookmarks now**
 * does not do anything the toggle would not eventually do on its own; it only
 * skips the wait for the next tick, which is why the description below says
 * both things plainly instead of implying the button is required.
 *
 * Every user-visible string is under `ai.autoFile` (plus shared `ai.errors`) —
 * see `src/i18n/locales/en/ai.ts`.
 */
export function AutoFileStep({
  settings,
  status,
  commit,
  onRefresh,
}: {
  settings: AiSettings;
  status: AiStatus | null;
  commit(patch: Partial<AiSettings>): void;
  onRefresh(): void;
}) {
  const { t, formatNumber } = useI18n();
  const toast = useToast();
  const isMounted = useIsMounted();
  const [isQueuing, setIsQueuing] = useState(false);

  const run = status?.run;
  const pending = status?.pending ?? 0;
  // The button's own toggle gates *what it is next to*, but the route behind
  // it (`POST /api/ai/run`) queues both passes, each on its own toggle — so a
  // summarize-only account still has a reason to click it, and the button
  // must not look dead for them.
  const somethingToQueue = settings.autoClassify || settings.autoSummarize;
  const isDisabled = isQueuing || !somethingToQueue;
  const tooltip = !somethingToQueue ? t("ai.autoFile.tooltipNeitherOn") : isQueuing ? t("ai.autoFile.tooltipBusy") : t("ai.autoFile.tooltipOn");

  const organizeNow = async () => {
    setIsQueuing(true);
    try {
      // This calls the same route the toggle's own tick uses (`POST
      // /api/ai/run`), which queues *both* passes, each gated on its own
      // toggle server-side — so an account with summarising on too gets that
      // queued as a side effect of this click, and the toast has to say so
      // rather than only ever mentioning filing.
      const result = await requestClassificationRun();
      onRefresh();
      if (!isMounted()) return;
      toast({
        body: result === null ? t("ai.errors.couldNotStart") : queuedBody(t, result.queued, result.summariesQueued),
        ...(result === null ? { type: "error" as const } : {}),
      });
    } catch (error) {
      console.error("[Nook] Could not queue an AI pass:", error);
      if (isMounted()) toast({ body: t("ai.errors.couldNotStart"), type: "error" });
    } finally {
      if (isMounted()) setIsQueuing(false);
    }
  };

  return (
    <VStack gap={2} width="100%">
      <VStack gap={2}>
        <Text type="supporting" color="secondary">
          {t("ai.autoFile.description")}
        </Text>
        <HStack justify="start">
          <Switch label={t("ai.organize.step2Label")} value={settings.autoClassify} onChange={(checked) => commit({ autoClassify: checked })} />
        </HStack>
      </VStack>

      {outageKind(status) === "classify" ? (
        <Text type="supporting" color="secondary">
          {t("ai.errors.notAvailable")}
        </Text>
      ) : null}

      <HStack justify="end">
        <Button
          label={t("ai.autoFile.organizeButton")}
          variant="secondary"
          size="sm"
          isLoading={isQueuing}
          isDisabled={isDisabled}
          tooltip={tooltip}
          onClick={() => void organizeNow()}
        />
      </HStack>

      {pending > 0 ? (
        <HStack gap={2} align="center">
          <StatusDot variant="accent" label={t("ai.status.working")} isPulsing />
          <Text type="supporting" color="secondary">
            {t("ai.autoFile.working", { count: pending })}
          </Text>
        </HStack>
      ) : null}

      {run && (run.lastRunAt || run.lastError) ? (
        <HStack gap={2} align="center" wrap="wrap">
          <Text type="supporting" color="secondary">
            {run.lastError ?? t("ai.autoFile.filedResult", { assigned: formatNumber(run.assigned), skipped: formatNumber(run.skipped) })}
          </Text>
          {run.lastRunAt ? (
            <Text type="supporting" color="secondary">
              (<Timestamp value={run.lastRunAt} format="relative" isLive />)
            </Text>
          ) : null}
        </HStack>
      ) : status ? (
        <Text type="supporting" color="secondary">
          {t("ai.autoFile.neverRun")}
        </Text>
      ) : null}
    </VStack>
  );
}

/** Mirrors the old combined "Run now" toast: report only the halves that
 *  actually queued something, and never claim a pass ran — the route can only
 *  enqueue (docs/ai.md, "Settings surface"). */
function queuedBody(t: TFunction, queued: number, summariesQueued: number): string {
  const parts: string[] = [];
  if (queued > 0) parts.push(t("ai.autoFile.bookmarksToOrganize", { count: queued }));
  if (summariesQueued > 0) parts.push(t("ai.autoFile.pagesToSummarise", { count: summariesQueued }));
  if (parts.length === 0) return t("ai.autoFile.nothingToOrganize");
  return t("ai.autoFile.startedToast", { parts: parts.join(` ${t("ai.suggest.and")} `) });
}
