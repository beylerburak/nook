import { Children, type ComponentProps, type ReactNode } from "react";
import { Card, HStack, Stack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Divider } from "@astryxdesign/core/Divider";
import { Icon } from "@astryxdesign/core/Icon";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Text } from "@astryxdesign/core/Text";
import type { MessageKey } from "../../i18n";
import { CloudGlyph, DatabaseGlyph, PaletteGlyph, ShieldGlyph, SparkGlyph, UserGlyph } from "./glyphs";

/** Sections the Settings dialog can show — see product-contract.md section 4. */
export type SettingsSection = "profile" | "account" | "appearance" | "sync" | "ai" | "data" | "about";

/** Anything `Icon`'s own `icon` prop accepts — a semantic name or an SVG component. */
export type SettingsIcon = ComponentProps<typeof Icon>["icon"];

/**
 * Message keys rather than resolved strings — this is a module-level
 * constant (evaluated once, outside any component), so it can't call
 * `useI18n()` itself. Callers resolve `labelKey`/`descriptionKey` with
 * `t()` at render time (see `SettingsDialog.tsx`).
 */
export interface SettingsSectionConfig {
  id: SettingsSection;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  icon: SettingsIcon;
}

export const SETTINGS_SECTIONS: SettingsSectionConfig[] = [
  { id: "profile", labelKey: "settings.sections.profile.label", descriptionKey: "settings.sections.profile.description", icon: UserGlyph },
  { id: "account", labelKey: "settings.sections.account.label", descriptionKey: "settings.sections.account.description", icon: ShieldGlyph },
  { id: "appearance", labelKey: "settings.sections.appearance.label", descriptionKey: "settings.sections.appearance.description", icon: PaletteGlyph },
  { id: "sync", labelKey: "settings.sections.sync.label", descriptionKey: "settings.sections.sync.description", icon: CloudGlyph },
  { id: "ai", labelKey: "settings.sections.ai.label", descriptionKey: "settings.sections.ai.description", icon: SparkGlyph },
  { id: "data", labelKey: "settings.sections.data.label", descriptionKey: "settings.sections.data.description", icon: DatabaseGlyph },
  { id: "about", labelKey: "settings.sections.about.label", descriptionKey: "settings.sections.about.description", icon: "info" },
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
        // `SETTINGS_NARROW_QUERY` is a viewport-width query, not a
        // container-width one — the desktop side-nav branch keeps this row
        // horizontal on any wide screen even though its own content column
        // is only ~600px (880 dialog − a fixed-width SideNav). A control with
        // its own fixed width (e.g. AiPanel's `<Slider width={200}>`) is a
        // plain flex child here, not a `StackItem`, so it keeps the browser's
        // default content-based `min-width` and refuses to shrink — without
        // `wrap`, that forces this row wider than the column and the content
        // pane's `isScrollable` turns that into a horizontal scrollbar
        // instead of the row simply breaking onto two lines the way the
        // narrow layout already does.
        wrap={isNarrow ? "nowrap" : "wrap"}
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
