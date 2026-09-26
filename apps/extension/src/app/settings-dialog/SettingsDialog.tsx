import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Divider } from "@astryxdesign/core/Divider";
import { useMediaQuery } from "@astryxdesign/core/hooks";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { SideNav, SideNavItem } from "@astryxdesign/core/SideNav";
import { Heading, Text } from "@astryxdesign/core/Text";
import type { ThemeMode } from "@astryxdesign/core/theme";
import { useI18n } from "../../i18n";
import { useNookHost, type NookHost } from "../host/NookHost";
import { AboutPanel } from "./AboutPanel";
import { AccountPanel } from "./AccountPanel";
import { AiPanel } from "./AiPanel";
import { AppearancePanel } from "./AppearancePanel";
import { DataPanel } from "./DataPanel";
import { ProfilePanel } from "./ProfilePanel";
import {
  SETTINGS_DIALOG_HEIGHT,
  SETTINGS_NARROW_QUERY,
  SETTINGS_SECTIONS,
  settingsSectionConfig,
  type SettingsLibrary,
  type SettingsSection,
} from "./settings-shared";
import { SyncPanel } from "./SyncPanel";

export type { SettingsSection };

export interface SettingsDialogProps {
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  initialSection?: SettingsSection;
  appearance: ThemeMode;
  onAppearanceChange(mode: ThemeMode): void;
  library: SettingsLibrary;
  /** Settings → AI's "Open Organize" button: closes this dialog and switches
   *  the dashboard to the Organize page (dashboard/organize/OrganizePage.tsx).
   *  Optional only so a test can render this dialog without wiring it up. */
  onOpenOrganize?(): void;
}

/**
 * Which sections apply to this host: Profile needs a signed-in user (hidden
 * in the extension's local-only mode), Account & security needs
 * `host.account` (web only — a signed-in extension manages its account on
 * the web instead, see `ProfilePanel`), and AI needs a session on either host.
 *
 * AI needs `host.user` for one reason: every AI route is session-guarded, so
 * nothing this section can do — flip a toggle, queue a pass, accept a proposed
 * taxonomy — is possible without an account. The features themselves
 * (classification and the accepted taxonomy) run on Nook's server now, and the
 * settings are the account's own row, so there is no host-specific reason to
 * hide the section: AiPanel is the same panel on both hosts, and the numbers it
 * shows are the account's. See docs/ai.md, "Settings surface".
 *
 * A connected extension has a `user` and no `account`, so gating on
 * `host.user` rather than `host.account` is what keeps this visible where it
 * works, on both hosts.
 */
function visibleSections(host: NookHost): SettingsSection[] {
  const sections: SettingsSection[] = [];
  if (host.user) sections.push("profile");
  if (host.account) sections.push("account");
  sections.push("appearance", "sync");
  if (host.user) sections.push("ai");
  sections.push("data", "about");
  return sections;
}

function resolveSection(requested: SettingsSection | undefined, sections: SettingsSection[]): SettingsSection {
  if (requested && sections.includes(requested)) return requested;
  return sections[0];
}

function renderSection(section: SettingsSection, props: SettingsDialogProps): ReactNode {
  switch (section) {
    case "profile":
      return <ProfilePanel />;
    case "account":
      return <AccountPanel />;
    case "appearance":
      return <AppearancePanel appearance={props.appearance} onAppearanceChange={props.onAppearanceChange} />;
    case "sync":
      return <SyncPanel />;
    case "ai":
      return <AiPanel onOpenOrganize={props.onOpenOrganize} />;
    case "data":
      return <DataPanel library={props.library} />;
    case "about":
      return <AboutPanel />;
  }
}

export function SettingsDialog(props: SettingsDialogProps) {
  const { isOpen, onOpenChange, initialSection } = props;
  const { t } = useI18n();
  const host = useNookHost();
  const sections = useMemo(() => visibleSections(host), [host]);
  const [activeSection, setActiveSection] = useState<SettingsSection>(() => resolveSection(initialSection, sections));
  const isNarrow = useMediaQuery(SETTINGS_NARROW_QUERY);
  const titleId = useId();

  // The content pane's own scroll container — the scrollable `StackItem` in
  // whichever branch (desktop side-nav or narrow tab-strip) is mounted.
  // Reset to the top on every section change so a long scrolled panel
  // doesn't leave the next one scrolled too.
  const contentScrollRef = useRef<HTMLElement | null>(null);
  const setContentScrollRef = useCallback((node: HTMLElement | null) => {
    contentScrollRef.current = node;
  }, []);
  useEffect(() => {
    if (contentScrollRef.current) contentScrollRef.current.scrollTop = 0;
  }, [activeSection]);

  // Re-pick the requested (or first) section each time the dialog opens,
  // and fall back if the active one stopped being visible (e.g. the
  // extension signed out while Settings was open).
  useEffect(() => {
    if (isOpen) setActiveSection(resolveSection(initialSection, sections));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  useEffect(() => {
    if (!sections.includes(activeSection)) setActiveSection(sections[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  const config = settingsSectionConfig(activeSection);
  const heading = (
    <VStack gap={0.5}>
      <Heading level={2}>{t(config.labelKey)}</Heading>
      <Text type="supporting" color="secondary">
        {t(config.descriptionKey)}
      </Text>
    </VStack>
  );
  const panel = renderSection(activeSection, props);

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="form"
      width={isNarrow ? "100vw" : 880}
      maxHeight={SETTINGS_DIALOG_HEIGHT}
      padding={0}
      aria-labelledby={titleId}
    >
      {/*
        `Dialog` only exposes `maxHeight` — its native sizing is
        `height: fit-content` clamped to that cap, so a shorter panel (e.g.
        About) previously rendered a shorter dialog than a taller one (e.g.
        Account & security). Giving this column a `minHeight` equal to that
        same cap forces the fit-content calculation up to the cap on every
        section, so the dialog is always exactly `SETTINGS_DIALOG_HEIGHT`
        tall (or smaller on a short viewport, since both sides of the min()
        shrink together).
      */}
      <VStack height="100%" minHeight={SETTINGS_DIALOG_HEIGHT}>
        <HStack padding={4} justify="between" align="center">
          <Heading level={3} id={titleId}>
            {t("settings.dialog.title")}
          </Heading>
          <IconButton
            label={t("common.close")}
            variant="ghost"
            size="sm"
            icon={<Icon icon="close" size="sm" />}
            onClick={() => onOpenChange(false)}
          />
        </HStack>
        <Divider />

        {/*
          `StackItem size="fill"` is what lets this row shrink to the space
          left under the header: a plain Stack child keeps its content's
          natural (min-content) height and never shrinks, so nothing below it
          could ever become a bounded scroll container.
          It also needs `display: flex; flex-direction: column` (no such
          prop on StackItem, so this falls back to `style`, per AGENTS.md's
          "component props first, else style/className"): a plain StackItem
          fills the space (confirmed by measuring it directly), but it has no
          CSS `height` of its own — only `flex-grow` — so a percentage-height
          child (`height="100%"`, below) can't resolve `100%` against it and
          falls back to its content's height. Making this row a real flex
          container lets its child resolve `height="100%"` via flexbox's
          flex-basis percentage resolution (against a definite flex main
          size) instead of CSS's plain percentage-of-height-property rule,
          which requires an ancestor with a real, non-auto `height`.
        */}
        <StackItem size="fill" style={{ display: "flex", flexDirection: "column" }}>
          {isNarrow ? (
            <VStack gap={0} height="100%" minHeight={0}>
              {/*
                Same reason as the side nav below: \`isScrollable\` gives this
                strip \`overflow: auto\`, which lets a flex child shrink below
                its content, so the fill pane squeezed it until the tab labels
                were clipped. \`size="static"\` keeps it at its own height.
              */}
              <StackItem size="static">
                <HStack as="nav" aria-label={t("settings.dialog.sectionsLabel")} gap={1} wrap="nowrap" isScrollable paddingInline={3} paddingBlock={2}>
                  {sections.map((id) => {
                    const section = settingsSectionConfig(id);
                    return (
                      <Button
                        key={id}
                        label={t(section.labelKey)}
                        icon={<Icon icon={section.icon} size="sm" />}
                        variant={id === activeSection ? "secondary" : "ghost"}
                        size="sm"
                        onClick={() => setActiveSection(id)}
                      />
                    );
                  })}
                </HStack>
              </StackItem>
              <Divider />
              {/*
                The scrollable pane itself is the StackItem (`size="fill"
                isScrollable`), not the VStack inside it — a Stack with
                `isScrollable` but no `StackItem` wrapper keeps the same
                content-based min-height, so it still can't shrink far
                enough to ever actually overflow and scroll.
              */}
              <StackItem size="fill" isScrollable ref={setContentScrollRef}>
                <VStack padding={4} gap={4}>
                  {heading}
                  {panel}
                </VStack>
              </StackItem>
            </VStack>
          ) : (
            /*
              Deliberately not `Layout` here: `Layout` is a page-frame
              component — its content wrapper sizes itself off a
              `--container-max-height` custom property (inherited straight
              from `Dialog`'s own cap) rather than off this row's actual
              (smaller) height, so nested inside a fixed-height dialog its
              scroll pane rendered at the dialog's full height and
              overflowed past this row, clipping the bottom of the content
              (e.g. Account & security's Danger zone) with no way to scroll
              to it. A plain `HStack` + `StackItem` — the same flex
              primitives the narrow branch above already uses successfully —
              sizes purely from flexbox, with no such inherited cap.
            */
            <HStack gap={0} height="100%" minHeight={0}>
              {/*
                `StackItem size="static"` is what keeps the nav at its own
                (260px) width: a bare `SideNav` here is a plain flex child of
                `HStack` and gets the browser's default `flex-shrink: 1`, so
                the content pane's wide rows (e.g. AiPanel) squeezed it down
                to icons-plus-a-letter ("P..", "A..", "S.."). `size="static"`
                sets `flex-shrink: 0` (see stackItem.stylex.ts), so the nav
                never gives up width to its sibling — the sibling's own
                `size="fill"` is what has to shrink instead.
              */}
              <StackItem size="static">
                <SideNav aria-label={t("settings.dialog.sectionsLabel")}>
                  {sections.map((id) => {
                    const section = settingsSectionConfig(id);
                    return (
                      <SideNavItem
                        key={id}
                        label={t(section.labelKey)}
                        icon={<Icon icon={section.icon} size="sm" />}
                        isSelected={id === activeSection}
                        onClick={() => setActiveSection(id)}
                      />
                    );
                  })}
                </SideNav>
              </StackItem>
              <StackItem size="fill" isScrollable ref={setContentScrollRef}>
                <VStack padding={4} gap={4}>
                  {heading}
                  {panel}
                </VStack>
              </StackItem>
            </HStack>
          )}
        </StackItem>
      </VStack>
    </Dialog>
  );
}

export default SettingsDialog;
