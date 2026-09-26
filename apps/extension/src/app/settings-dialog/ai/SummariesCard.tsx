import { Collapsible } from "@astryxdesign/core/Collapsible";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useI18n } from "../../../i18n";
import type { AiStatus, SummarizeStatus } from "../../../../lib/ai-client";
import type { AiSettings } from "../../../../lib/ai-settings";
import { SettingsCard, SettingsRow } from "../settings-shared";
import type { TFunction } from "./shared";

/**
 * "Summaries" — one short switch description plus a collapsed disclosure for
 * the privacy detail, instead of one paragraph long enough to bury the
 * toggle's own point. The counts row is the server's own SQL counts
 * (`summarised`/`pending`), not a client-side guess.
 *
 * Every user-visible string is under `ai.summaries` (plus shared
 * `ai.errors.notAvailable` and `settings.sync.never`, which this row reuses
 * rather than re-translating "Never") — see `src/i18n/locales/en/ai.ts`.
 */
export function SummariesCard({
  settings,
  status,
  commit,
}: {
  settings: AiSettings;
  status: AiStatus | null;
  commit(patch: Partial<AiSettings>): void;
}) {
  const { t } = useI18n();
  const summarise: SummarizeStatus | undefined = status?.summarize;

  return (
    <SettingsCard title={t("ai.summaries.title")}>
      <SettingsRow
        title={t("ai.summaries.switchLabel")}
        description={t("ai.summaries.description")}
        control={
          <Switch
            label={t("ai.summaries.switchLabel")}
            isLabelHidden
            value={settings.autoSummarize}
            onChange={(checked) => commit({ autoSummarize: checked })}
          />
        }
        detail={
          <Collapsible trigger={<Text type="supporting">{t("ai.summaries.privacyTrigger")}</Text>} defaultIsOpen={false}>
            <Text type="supporting" color="secondary">
              {t("ai.summaries.privacyNote")}
            </Text>
          </Collapsible>
        }
      />
      <SettingsRow
        title={t("ai.summaries.countsRowTitle")}
        description={countsDescription(t, settings.autoSummarize, summarise)}
        control={
          <Text color="secondary">
            {t("ai.summaries.lastRunLabel")}{" "}
            {summarise?.lastRunAt ? (
              <Timestamp value={summarise.lastRunAt} format="relative" isLive />
            ) : summarise ? (
              t("settings.sync.never")
            ) : (
              t("ai.summaries.unknown")
            )}
          </Text>
        }
      />
    </SettingsCard>
  );
}

function countsDescription(t: TFunction, isOn: boolean, summarise: SummarizeStatus | undefined): string {
  if (!summarise) return t("ai.summaries.unknown");
  // The same "proposer configured" check `outageKind` in ./shared makes off the
  // whole status; this row only ever has the summarise half, so it is inlined
  // here rather than reconstructing a partial AiStatus to satisfy that helper's
  // shape.
  if (!summarise.available) return t("ai.errors.notAvailable");
  if (summarise.lastError) return summarise.lastError;
  if (!isOn) return t("ai.summaries.off");
  return t("ai.summaries.counts", { count: summarise.summarised, pending: summarise.pending });
}
