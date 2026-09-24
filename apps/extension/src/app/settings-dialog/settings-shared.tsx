import { Children, type ComponentProps, type ReactNode } from "react";
import { Card, HStack, Stack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon } from "@astryxdesign/core/Icon";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Text } from "@astryxdesign/core/Text";
import { CloudGlyph, DatabaseGlyph, PaletteGlyph, ShieldGlyph, UserGlyph } from "./glyphs";

/** Sections the Settings dialog can show — see product-contract.md section 4. */
export type SettingsSection = "profile" | "account" | "appearance" | "sync" | "data" | "about";

/** Anything `Icon`'s own `icon` prop accepts — a semantic name or an SVG component. */
export type SettingsIcon = ComponentProps<typeof Icon>["icon"];

export interface SettingsSectionConfig {
  id: SettingsSection;
  label: string;
  description: string;
  icon: SettingsIcon;
}

export const SETTINGS_SECTIONS: SettingsSectionConfig[] = [
  { id: "profile", label: "Profile", description: "Your name, photo and account basics.", icon: UserGlyph },
  { id: "account", label: "Account & security", description: "Password, sessions and account deletion.", icon: ShieldGlyph },
  { id: "appearance", label: "Appearance", description: "Choose how Nook looks on this device.", icon: PaletteGlyph },
  { id: "sync", label: "Sync", description: "Cloud sync status and the browser extension link.", icon: CloudGlyph },
  { id: "data", label: "Data", description: "Import, export and clear your library.", icon: DatabaseGlyph },
  { id: "about", label: "About", description: "Version and app information.", icon: "info" },
];

export function settingsSectionConfig(id: SettingsSection): SettingsSectionConfig {
  return SETTINGS_SECTIONS.find((section) => section.id === id) ?? SETTINGS_SECTIONS[0];
}

/** The panel column stacks its rows to one column below this width. */
export const SETTINGS_NARROW_QUERY = "(max-width: 640px)";

/**
 * The Settings dialog's height on every section, so switching sections never
 * resizes the dialog — only the content pane's own scroll position changes.
 * `min()` still shrinks it to fit short/narrow viewports.
 *
 * Shared between `Dialog`'s `maxHeight` (which only caps the height) and the
 * content column's matching `minHeight` (which forces it up to that same
 * cap) — see `SettingsDialog` for how the two combine into a fixed height.
 */
export const SETTINGS_DIALOG_HEIGHT = "min(720px, calc(100dvh - 2rem))";

/** The `library` prop `SettingsDialog` takes — see product-contract.md section 4. */
export interface SettingsLibrary {
  bookmarkCount: number;
  collectionCount: number;
  isImporting: boolean;
  importBookmarks(file: File): Promise<boolean>;
  exportBookmarks(): void;
  clearAllBookmarks(): Promise<boolean>;
}

/**
 * A muted card grouping one subject's settings rows, with hairlines between
 * them — mirrors the Astryx settings-dialog template's `SettingsCard`
 * (see `astryx template settings-dialog`), rewritten without StyleX (this
 * project doesn't compile it — see AGENTS.md).
 */
export function SettingsCard({ title, children }: { title?: string; children: ReactNode }) {
  const rows = Children.toArray(children);
  return (
    <VStack gap={1.5}>
      {title != null ? (
        <Text type="supporting" weight="semibold" color="secondary">
          {title}
        </Text>
      ) : null}
      <Card padding={0} width="100%" variant="muted">
        <VStack as="ul" role="list" gap={0}>
          {rows.map((row, index) => (
            <VStack key={index} as="li" gap={0}>
              {index > 0 ? <Divider variant="subtle" /> : null}
              {row}
            </VStack>
          ))}
        </VStack>
      </Card>
    </VStack>
  );
}

export interface SettingsRowProps {
  title: string;
  description?: ReactNode;
  icon?: SettingsIcon;
  control?: ReactNode;
  /** Content that belongs to this row but doesn't fit beside it — a form, a list. */
  detail?: ReactNode;
}

/**
 * One setting: name and explanation on the left, the control on the right —
 * or, on a narrow dialog, the control underneath and full width.
 */
export function SettingsRow({ title, description, icon, control, detail }: SettingsRowProps) {
  const isNarrow = useMediaQuery(SETTINGS_NARROW_QUERY);
  return (
    <VStack padding={4} gap={2}>
      <Stack
        direction={isNarrow ? "vertical" : "horizontal"}
        gap={isNarrow ? 2 : 3}
        align={isNarrow ? "stretch" : "center"}
      >
        <StackItem size="fill">
          <HStack gap={2} align="start">
            {icon ? (
              <VStack paddingBlockStart={0.5}>
                <Icon icon={icon} size="sm" color="secondary" />
              </VStack>
            ) : null}
            <VStack gap={0.5}>
              <Text type="label">{title}</Text>
              {description != null ? (
                <Text type="supporting" color="secondary">
                  {description}
                </Text>
              ) : null}
            </VStack>
          </HStack>
        </StackItem>
        {control != null ? <VStack hAlign={isNarrow ? "stretch" : "end"}>{control}</VStack> : null}
      </Stack>
      {detail}
    </VStack>
  );
}
