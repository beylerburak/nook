import { Badge } from "@astryxdesign/core/Badge";
import {
  DropdownMenu,
  DropdownMenuDivider,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSubMenu,
} from "@astryxdesign/core/DropdownMenu";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import type { ThemeMode } from "@astryxdesign/core/theme";
import { useI18n } from "../../i18n";

export interface PopupHeaderProps {
  totalCount: number;
  appearanceMode: ThemeMode;
  onAppearanceChange: (mode: ThemeMode) => void;
  onOpenDashboard: () => void;
}

/**
 * Wordmark + total count, and a single overflow menu for the popup's
 * secondary controls (Appearance, Open dashboard). Appearance is inlined
 * here as a submenu with the same DropdownMenuRadioGroup content as
 * AppearanceMenu (src/app/components/AppearanceMenu.tsx) and driven by the
 * same useAppearance state passed down from PopupApp: AppearanceMenu itself
 * is a full top-level DropdownMenu trigger, which can't be nested inside
 * another menu's item, so the shared piece here is the appearance state and
 * the radio-group markup, not the AppearanceMenu component instance.
 */
export function PopupHeader({ totalCount, appearanceMode, onAppearanceChange, onOpenDashboard }: PopupHeaderProps) {
  const { t } = useI18n();

  return (
    <HStack justify="between" align="center" gap={2}>
      <HStack align="center" gap={2}>
        <Text type="large" weight="bold">Nook</Text>
        <Badge label={totalCount} />
      </HStack>
      <DropdownMenu
        button={{
          label: t("popup.header.moreOptions"),
          variant: "ghost",
          size: "sm",
          isIconOnly: true,
          icon: <Icon icon="moreHorizontal" size="sm" />,
        }}
        hasChevron={false}
        alignment="end"
      >
        <DropdownMenuSubMenu label={t("popup.header.appearance")}>
          <DropdownMenuRadioGroup
            label={t("popup.header.appearance")}
            value={appearanceMode}
            onChange={(value) => onAppearanceChange(value as ThemeMode)}
          >
            <DropdownMenuRadioItem value="system" label={t("common.system")} />
            <DropdownMenuRadioItem value="light" label={t("settings.appearance.modeLight")} />
            <DropdownMenuRadioItem value="dark" label={t("settings.appearance.modeDark")} />
          </DropdownMenuRadioGroup>
        </DropdownMenuSubMenu>
        <DropdownMenuDivider />
        <DropdownMenuItem label={t("popup.header.openDashboard")} icon="externalLink" onClick={onOpenDashboard} />
      </DropdownMenu>
    </HStack>
  );
}
