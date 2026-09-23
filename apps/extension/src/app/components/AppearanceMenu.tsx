import { DropdownMenu, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@astryxdesign/core/DropdownMenu";
import type { ThemeMode } from "@astryxdesign/core/theme";

interface AppearanceMenuProps {
  mode: ThemeMode;
  onChange: (mode: ThemeMode) => void;
}

export function AppearanceMenu({ mode, onChange }: AppearanceMenuProps) {
  return (
    <DropdownMenu
      button={{ label: "Appearance", variant: "ghost", size: "sm" }}
      alignment="end"
    >
      <DropdownMenuRadioGroup
        label="Appearance"
        value={mode}
        onChange={(value) => onChange(value as ThemeMode)}
      >
        <DropdownMenuRadioItem value="system" label="System" />
        <DropdownMenuRadioItem value="light" label="Light" />
        <DropdownMenuRadioItem value="dark" label="Dark" />
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}
