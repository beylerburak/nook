import { useCallback, useEffect, useRef, useState } from "react";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card, HStack, VStack } from "@astryxdesign/core/Layout";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../../i18n";
import type { Bookmark, BookmarkList } from "../../../../lib/types";
import type { AiStatus } from "../../../../lib/ai-client";
import type { AiSettings } from "../../../../lib/ai-settings";
import { useNookHost, type NookHost } from "../../host/NookHost";
import { AiUnavailableBanner } from "../../settings-dialog/ai/AiOutageBanner";
import { outageKind, useAiSettings, useAiStatus } from "../../settings-dialog/ai/shared";
import { ClusterProposals } from "./ClusterProposals";
import { RecentlyFiled } from "./RecentlyFiled";
import { ReviewList } from "./ReviewList";
import { SuggestTags } from "./SuggestTags";
import { describeProgress, describeWorking, libraryProgress } from "./organize-utils";
import { noteLabel } from "./useSuggestCollections";
import { useSuggestClusters } from "./useSuggestClusters";
import { useReviewList } from "./useReviewList";

export interface OrganizePageProps {
  items: Bookmark[];
  lists: BookmarkList[];
  /** Opens Settings on the AI section — the "AI settings" link at the
   *  bottom of the page. */
  onOpenAiSettings(): void;
}

/**
 * The Organize page: suggest collections, review what Jev wasn't sure
 * about, watch progress. Reached from the side nav ("Organize", badged with
 * `reviewCount` when there's something waiting, else the unfiled count) or
 * the "Open Organize" button in Settings → AI.
 *
 * Three blocks, in this order of prominence:
 *   1. **Suggest collections** (`ClusterProposals.tsx`/`useSuggestClusters.ts`)
 *      — the primary action: groups of unfiled bookmarks Jev found, each
 *      with an editable name, ready to become real collections.
 *   2. **Needs your review** (`ReviewList.tsx`/`useReviewList.tsx`) — guesses
 *      that came in below the confidence threshold, shown only while there
 *      are any. Focus moves here right after a successful cluster accept —
 *      the two flows feed each other: accepting groups is often exactly what
 *      turns up new low-confidence guesses to look at.
 *   3. **Progress / recently filed** (`RecentlyFiled.tsx`) — always shown,
 *      compact.
 * A signed-out session or a server with neither AI deployment configured
 * collapses this to a single banner; otherwise, once there is truly nothing
 * to do (nothing unfiled, nothing to review), the page says so plainly
 * instead of showing three empty blocks.
 */
export function OrganizePage({ items, lists, onOpenAiSettings }: OrganizePageProps) {
  const { t } = useI18n();
  const host = useNookHost();
  const { settings, commit } = useAiSettings();
  const { status, refresh } = useAiStatus(settings);

  if (!host.user) return <SignedOut host={host} />;

  if (!settings) {
    return (
      <VStack padding={4}>
        <Text color="secondary">{t("ai.loadingSettings")}</Text>
      </VStack>
    );
  }

  return (
    <OrganizePageReady
      items={items}
      lists={lists}
      onOpenAiSettings={onOpenAiSettings}
      settings={settings}
      commit={commit}
      status={status}
      refresh={refresh}
    />
  );
}

/**
 * Split from `OrganizePage` so every hook this body calls only ever mounts
 * once `settings` is confirmed non-null — the parent's early returns above
 * happen before this component exists at all, rather than after a
 * conditional hook call, which the rules of hooks forbid.
 */
function OrganizePageReady({
  items,
  lists,
  onOpenAiSettings,
  settings,
  commit,
  status,
  refresh,
}: OrganizePageProps & {
  settings: AiSettings;
  commit(patch: Partial<AiSettings>): void;
  status: AiStatus | null;
  refresh(): void;
}) {
  const { t } = useI18n();
  const reviewList = useReviewList();
  const reviewBlockRef = useRef<HTMLElement>(null);
  const [focusReviewPending, setFocusReviewPending] = useState(false);
  const previousClusterPhase = useRef<string>("idle");

  const onClustersAccepted = useCallback(() => {
    refresh();
    reviewList.refresh();
  }, [refresh, reviewList]);

  const clusters = useSuggestClusters({ settings, status, onAccepted: onClustersAccepted });

  // Move focus to "Needs your review" right after a successful cluster
  // accept — see this file's header comment. Watches the phase transition
  // rather than firing straight out of `onAccepted` because the review list
  // itself hasn't necessarily finished refreshing by then; the second effect
  // below re-checks every time `reviewList.items` changes and focuses the
  // moment there is something there to land on.
  useEffect(() => {
    const wasDone = previousClusterPhase.current === "done";
    if (clusters.state.phase === "done" && !wasDone) setFocusReviewPending(true);
    else if (clusters.state.phase !== "done") setFocusReviewPending(false);
    previousClusterPhase.current = clusters.state.phase;
  }, [clusters.state.phase]);

  useEffect(() => {
    if (!focusReviewPending || reviewList.items.length === 0) return;
    reviewBlockRef.current?.focus();
    setFocusReviewPending(false);
  }, [focusReviewPending, reviewList.items.length]);

  const progress = libraryProgress(items);
  const pending = status?.pending ?? 0;
  const outage = outageKind(status);
  const hasReviewItems = reviewList.items.length > 0;
  const nothingToDo = !clusters.isReviewing && !clusters.isReading && progress.unfiled === 0 && !hasReviewItems;

  return (
    <VStack gap={5} width="100%">
      <VStack gap={2}>
        <Heading level={1}>{t("dashboard.organize.title")}</Heading>
        <Text color="secondary">{t("dashboard.organize.description")}</Text>
        <VStack gap={1}>
          <ProgressBar
            label={t("dashboard.organize.title")}
            isLabelHidden
            value={progress.filed}
            max={Math.max(progress.total, 1)}
            variant="accent"
          />
          <Text type="supporting" color="secondary">
            {describeProgress(t, progress)}
          </Text>
        </VStack>
      </VStack>

      {outage === "all" ? <AiUnavailableBanner /> : null}

      {outage !== "all" && nothingToDo ? (
        <Banner
          status="success"
          title={t("dashboard.organize.empty.title")}
          endContent={<Button label={t("dashboard.organize.empty.suggestAgain")} variant="ghost" size="sm" onClick={clusters.ask} />}
        />
      ) : null}

      {outage !== "all" && !nothingToDo ? (
        <VStack gap={3} width="100%">
          {clusters.isReviewing ? (
            <ClusterProposals suggest={clusters} items={items} lists={lists} />
          ) : (
            <Card padding={4} width="100%" variant="muted">
              <VStack gap={2}>
                {clusters.state.note ? (
                  <HStack gap={2} align="start">
                    <StatusDot variant={clusters.state.note.variant} label={noteLabel(t, clusters.state.note.variant)} />
                    <Text type="supporting" color="secondary">
                      {clusters.state.note.text}
                    </Text>
                  </HStack>
                ) : null}
                <HStack justify="between" align="center" wrap="wrap" gap={2}>
                  <Text>{t("dashboard.organize.clusters.cta", { count: progress.unfiled })}</Text>
                  <Button
                    label={t("dashboard.organize.clusters.button")}
                    variant="primary"
                    isLoading={clusters.isReading}
                    isDisabled={Boolean(clusters.disabledReason) || clusters.isBusy}
                    tooltip={clusters.disabledReason ?? t("dashboard.organize.clusters.buttonTooltip")}
                    onClick={clusters.ask}
                  />
                </HStack>
                {clusters.isReading ? (
                  <HStack gap={2} align="center">
                    <StatusDot variant="accent" label={t("dashboard.organize.clusters.reading")} isPulsing />
                    <Text type="supporting" color="secondary">
                      {t("dashboard.organize.clusters.readingBody")}
                    </Text>
                  </HStack>
                ) : null}
              </VStack>
            </Card>
          )}

          <SuggestTags settings={settings} status={status} commit={commit} />
        </VStack>
      ) : null}

      {hasReviewItems ? (
        <VStack ref={reviewBlockRef} tabIndex={-1} gap={3} width="100%" style={{ outline: "none" }}>
          <ReviewList items={items} lists={lists} />
        </VStack>
      ) : null}

      {pending > 0 ? (
        <Card padding={4} width="100%" variant="muted">
          <HStack gap={2} align="center">
            <StatusDot variant="accent" label={t("ai.status.working")} isPulsing />
            <VStack gap={0.5}>
              <Text weight="semibold">{t("dashboard.organize.workingTitle")}</Text>
              <Text type="supporting" color="secondary">
                {describeWorking(t, pending)}
              </Text>
            </VStack>
          </HStack>
        </Card>
      ) : null}

      <RecentlyFiled
        log={status?.run.log ?? []}
        items={items}
        lists={lists}
        collectionMinConfidence={settings.collectionMinConfidence}
      />

      <HStack justify="start">
        <Button label={t("dashboard.organize.openAiSettings")} variant="ghost" size="sm" onClick={onOpenAiSettings} />
      </HStack>
    </VStack>
  );
}

function SignedOut({ host }: { host: NookHost }) {
  const { t } = useI18n();
  return (
    <Banner
      status="info"
      title={t("ai.signIn.title")}
      description={t("ai.signIn.description")}
      endContent={
        host.kind === "extension" && host.openWebApp ? (
          <Button label={t("ai.signIn.button")} variant="primary" size="sm" onClick={() => host.openWebApp?.("/?connect=extension")} />
        ) : null
      }
    />
  );
}
