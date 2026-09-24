import { VStack } from "@astryxdesign/core/Layout";
import { SegmentedControl, SegmentedControlItem } from "@astryxdesign/core/SegmentedControl";
import type { ThemeMode } from "@astryxdesign/core/theme";
import { SettingsCard, SettingsRow } from "./settings-shared";

export function AppearancePanel({
  appearance,
  onAppearanceChange,
}: {
  appearance: ThemeMode;
  onAppearanceChange: (mode: ThemeMode) => void;
}) {
  return (
    <VStack gap={4}>
      <SettingsCard title="Theme">
        <SettingsRow
          title="Appearance"
          description="Match your system, or pick light or dark."
          control={
            <SegmentedControl
              label="Appearance"
              value={appearance}
              onChange={(value) => onAppearanceChange(value as ThemeMode)}
              size="sm"
            >
              <SegmentedControlItem value="system" label="System" />
              <SegmentedControlItem value="light" label="Light" />
              <SegmentedControlItem value="dark" label="Dark" />
            </SegmentedControl>
          }
        />
      </SettingsCard>
    </VStack>
  );
}
