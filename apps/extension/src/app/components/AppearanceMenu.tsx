import { DropdownMenu, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@astryxdesign/core/DropdownMenu";
import type { ThemeMode } from "@astryxdesign/core/theme";
import { useI18n } from "../../i18n";

interface AppearanceMenuProps {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}

export function AppearanceMenu({ mode, onChange }: AppearanceMenuProps) {
  const { t } = useI18n();
  return (
    <DropdownMenu
      button={{ label: t("dashboard.appearanceMenu.label"), variant: "ghost", size: "sm" }}
      alignment="end"
    >
      <DropdownMenuRadioGroup
        label={t("dashboard.appearanceMenu.label")}
        value={mode}
        onChange={(value) => onChange(value as ThemeMode)}
      >
        <DropdownMenuRadioItem value="system" label={t("common.system")} />
        <DropdownMenuRadioItem value="light" label={t("dashboard.appearanceMenu.light")} />
        <DropdownMenuRadioItem value="dark" label={t("dashboard.appearanceMenu.dark")} />
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}
