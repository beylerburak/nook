import { VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import type { ThemeMode } from "@astryxdesign/core/theme";
import { useI18n, type LocaleSetting } from "../../i18n";
import { SettingsCard, SettingsRow } from "./settings-shared";

export function AppearancePanel({
  appearance,
  onAppearanceChange,
}: {
  appearance: ThemeMode;
  onAppearanceChange: (mode: ThemeMode) => void;
}) {
  const { t, localeSetting, setLocale } = useI18n();

  return (
    <VStack gap={4}>
      <SettingsCard title={t("settings.appearance.themeSectionTitle")}>
        <SettingsRow
          title={t("settings.appearance.appearanceRowTitle")}
          description={t("settings.appearance.appearanceRowDescription")}
          control={
            <SegmentedControl
              label={t("settings.appearance.appearanceRowTitle")}
              value={appearance}
              onChange={(value) => onAppearanceChange(value as ThemeMode)}
              size="sm"
            >
              <SegmentedControlItem value="system" label={t("common.system")} />
              <SegmentedControlItem value="light" label={t("settings.appearance.modeLight")} />
              <SegmentedControlItem value="dark" label={t("settings.appearance.modeDark")} />
            </SegmentedControl>
          }
        />
      </SettingsCard>

      <SettingsCard title={t("settings.appearance.languageSectionTitle")}>
        <SettingsRow
          title={t("settings.appearance.languageRowTitle")}
          description={t("settings.appearance.languageRowDescription")}
          control={
            <SegmentedControl
              label={t("settings.appearance.languageRowTitle")}
              value={localeSetting}
              onChange={(value) => setLocale(value as LocaleSetting)}
              size="sm"
            >
              <SegmentedControlItem value="system" label={t("common.system")} />
              <SegmentedControlItem value="en" label={t("settings.appearance.languageEnglish")} />
              <SegmentedControlItem value="tr" label={t("settings.appearance.languageTurkish")} />
            </SegmentedControl>
          }
        />
      </SettingsCard>
    </VStack>
  );
}
