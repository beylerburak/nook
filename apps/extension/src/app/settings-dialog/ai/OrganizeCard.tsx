import { Card, VStack } from "@astryxdesign/core/Layout";
import { Step, Stepper } from "@astryxdesign/core/Stepper";
import { Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../../i18n";
import type { AiStatus } from "../../../../lib/ai-client";
import type { AiSettings } from "../../../../lib/ai-settings";
import { AutoFileStep } from "./AutoFileStep";
import { SuggestCollectionsStep } from "./SuggestCollections";

/**
 * "Organize your library" — the two things that actually get bookmarks out of
 * "Unorganized": suggest collections and tags, then let Nook file into them.
 * Presented as steps because that is the order that produces something —
 * filing has nothing to file *into* until at least one collection exists —
 * but neither step is locked: a step is marked done for the user's own
 * information, not to gate the other one.
 *
 * Every user-visible string is under `ai.organize` — see
 * `src/i18n/locales/en/ai.ts`. `step2Label` doubles as `AutoFileStep`'s own
 * switch label, since it's the same phrase in both places.
 */
export function OrganizeCard({
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
  const { t } = useI18n();
  // A step reads as "done" once the account has accepted at least one round of
  // suggestions — it stays revisitable either way, this only moves the
  // checkmark and the active highlight.
  const step1Done = Boolean(status?.taxonomy.acceptedAt);

  return (
    <VStack gap={1.5}>
      <Text type="supporting" weight="semibold" color="secondary">
        {t("ai.organize.title")}
      </Text>
      <Card padding={4} width="100%" variant="muted">
        <Stepper orientation="vertical" activeStep={step1Done ? 1 : 0} label={t("ai.organize.title")}>
          <Step step={0} label={t("ai.organize.step1Label")} description={t("ai.organize.step1Description")}>
            <SuggestCollectionsStep status={status} settings={settings} commit={commit} />
          </Step>
          <Step step={1} label={t("ai.organize.step2Label")} description={t("ai.organize.step2Description")}>
            <AutoFileStep settings={settings} status={status} commit={commit} onRefresh={onRefresh} />
          </Step>
        </Stepper>
      </Card>
    </VStack>
  );
}
