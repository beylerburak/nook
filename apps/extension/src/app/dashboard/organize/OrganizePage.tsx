import { useCallback } from "react";
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
import { RecentlyFiled } from "./RecentlyFiled";
import { SuggestionReview } from "./SuggestionReview";
import { describeProgress, describeSuggestPrompt, describeWorking, libraryProgress } from "./organize-utils";
import { noteLabel, useSuggestCollections } from "./useSuggestCollections";

export interface OrganizePageProps {
  items: Bookmark[];
  lists: BookmarkList[];
  /** Opens Settings on the AI section — the "AI settings" link at the
   *  bottom of the page. */
  onOpenAiSettings(): void;
}

/**
 * The Organize page: suggest collections, watch Nook file into them, see what
 * got filed. This used to be a Stepper wedged into Settings → AI's 880px
 * dialog — a primary workflow squeezed into a settings surface, with the
 * accept button clipped off the edge and a stray Stepper rail down the left.
 * It is a full page now, reached from the side nav ("Organize", badge = the
 * unfiled count) or the "Open Organize" button in Settings → AI.
 *
 * State, top to bottom:
 *   1. signed out / AI not set up on this server -> a banner, nothing else
 *   2. a review in progress (`useSuggestCollections`) -> the full-width step
 *   3. a filing pass draining (`status.pending > 0`) -> live progress
 *   4. otherwise -> the next thing to do: suggest collections for what's
 *      still unfiled, or "everything is filed" once there's nothing left
 * "Recently filed" and the plain-language remainder line are always shown
 * beneath whichever of those is active, because they're historical — they
 * don't depend on what's happening right now.
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
 * Split from `OrganizePage` so `useSuggestCollections` (and every hook this
 * body calls) only ever mounts once `settings` is confirmed non-null — the
 * parent's early returns above happen before this component exists at all,
 * rather than after a conditional hook call, which the rules of hooks forbid.
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
  const onAccepted = useCallback(() => refresh(), [refresh]);
  const suggest = useSuggestCollections({ status, settings, commit, onAccepted });

  const progress = libraryProgress(items);
  const pending = status?.pending ?? 0;
  const outage = outageKind(status);
  const hasAcceptedBefore = Boolean(status?.taxonomy.acceptedAt);

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

      {suggest.state.note ? (
        <HStack gap={2} align="start">
          <StatusDot variant={suggest.state.note.variant} label={noteLabel(t, suggest.state.note.variant)} />
          <Text type="supporting" color="secondary">
            {suggest.state.note.text}
          </Text>
        </HStack>
      ) : null}
      {suggest.state.autoFileJustEnabled ? (
        <Text type="supporting" color="secondary">
          {t("dashboard.organize.autoFileEnabledNote")}
        </Text>
      ) : null}

      {suggest.isReviewing ? (
        <SuggestionReview suggest={suggest} />
      ) : pending > 0 ? (
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
      ) : outage !== "all" ? (
        <Card padding={4} width="100%" variant="muted">
          <VStack gap={2}>
            {progress.unfiled > 0 ? (
              <>
                <Text>{describeSuggestPrompt(t, progress.unfiled)}</Text>
                <HStack justify="end">
                  <Button
                    label={hasAcceptedBefore ? t("dashboard.organize.suggestMoreButton") : t("ai.suggest.button")}
                    variant="primary"
                    isLoading={suggest.isReading}
                    isDisabled={Boolean(suggest.disabledReason) || suggest.isBusy}
                    tooltip={suggest.disabledReason ?? t("ai.suggest.buttonTooltip")}
                    onClick={suggest.ask}
                  />
                </HStack>
              </>
            ) : (
              <Banner status="success" title={t("dashboard.organize.allCaughtUp")} />
            )}
            {suggest.isReading ? (
              <HStack gap={2} align="center">
                <StatusDot variant="accent" label={t("ai.suggest.reading")} isPulsing />
                <Text type="supporting" color="secondary">
                  {t("ai.suggest.readingBody")}
                </Text>
              </HStack>
            ) : null}
          </VStack>
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
