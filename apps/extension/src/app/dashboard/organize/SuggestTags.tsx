import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../../i18n";
import type { AiStatus } from "../../../../lib/ai-client";
import type { AiSettings } from "../../../../lib/ai-settings";
import { noteLabel, useSuggestCollections } from "./useSuggestCollections";
import { SuggestionReview } from "./SuggestionReview";

/**
 * "Suggest tags" — the secondary, collapsed action beneath the primary
 * cluster-suggestion block. New collection names are `ClusterProposals.tsx`'s
 * job now; this is what's left of the old propose/accept flow
 * (`useSuggestCollections.ts`, `tagsOnly: true`) once collections are out of
 * it — a way to grow the tag vocabulary without a second "create
 * collections" path competing with the one above it.
 */
export function SuggestTags({
  settings,
  status,
  commit,
}: {
  settings: AiSettings;
  status: AiStatus | null;
  commit(patch: Partial<AiSettings>): void;
}) {
  const { t } = useI18n();
  const suggest = useSuggestCollections({ status, settings, commit, tagsOnly: true });

  return (
    <Collapsible trigger={<Text weight="semibold">{t("dashboard.organize.suggestTagsTrigger")}</Text>} defaultIsOpen={false}>
      <VStack gap={3} paddingBlockStart={2}>
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
        ) : (
          <HStack justify="start">
            <Button
              label={t("ai.suggest.button")}
              variant="secondary"
              size="sm"
              isLoading={suggest.isReading}
              isDisabled={Boolean(suggest.disabledReason) || suggest.isBusy}
              tooltip={suggest.disabledReason ?? t("ai.suggest.buttonTooltip")}
              onClick={suggest.ask}
            />
          </HStack>
        )}
      </VStack>
    </Collapsible>
  );
}
