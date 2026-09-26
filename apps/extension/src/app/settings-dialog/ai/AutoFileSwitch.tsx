import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../../i18n";
import type { AiStatus } from "../../../../lib/ai-client";
import type { AiSettings } from "../../../../lib/ai-settings";
import { SettingsCard, SettingsRow } from "../settings-shared";
import { outageKind } from "./shared";

/**
 * "File bookmarks automatically" — just the switch now. The button that used
 * to sit under it ("Organize unfiled bookmarks now"), the queue depth, and the
 * run history all moved to the Organize page
 * (`dashboard/organize/OrganizePage.tsx`, `useAutoFileRun` there) — this row
 * only decides whether the per-minute worker tops up its queue from the
 * account's eligible bookmarks at all (docs/ai.md).
 *
 * Every user-visible string is under `ai.organize`/`ai.autoFile.description`
 * (plus shared `ai.errors`) — see `src/i18n/locales/en/ai.ts`.
 */
export function AutoFileSwitch({
  settings,
  status,
  commit,
}: {
  settings: AiSettings;
  status: AiStatus | null;
  commit(patch: Partial<AiSettings>): void;
}) {
  const { t } = useI18n();
  return (
    <SettingsCard title={t("ai.organize.title")}>
      <SettingsRow
        title={t("ai.organize.step2Label")}
        description={t("ai.autoFile.description")}
        control={
          <Switch
            label={t("ai.organize.step2Label")}
            isLabelHidden
            value={settings.autoClassify}
            onChange={(checked) => commit({ autoClassify: checked })}
          />
        }
        detail={
          outageKind(status) === "classify" ? (
            <Text type="supporting" color="secondary">
              {t("ai.errors.notAvailable")}
            </Text>
          ) : undefined
        }
      />
    </SettingsCard>
  );
}
