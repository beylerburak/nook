import type { ReactNode } from "react";
import { AppShell } from "@astryxdesign/core/AppShell";
import { Layout, LayoutContent, LayoutPanel } from "@astryxdesign/core/Layout";
import { ResizeHandle, useResizable } from "@astryxdesign/core/Resizable";
import { useI18n } from "../../i18n";

/**
 * Reusable Nook application frame. AppShell owns Nook navigation; the nested
 * Layout preserves the canvas-editor template's adjustable end inspector and
 * scrollable work area for any feature that supplies its own content.
 */
export interface CanvasEditorShellProps {
  topNav: ReactNode;
  sideNav: ReactNode;
  children: ReactNode;
  inspector?: ReactNode;
  inspectorLabel?: string;
}

export function CanvasEditorShell({
  topNav,
  sideNav,
  children,
  inspector,
  inspectorLabel,
}: CanvasEditorShellProps) {
  const { t } = useI18n();
  const resolvedInspectorLabel = inspectorLabel ?? t("dashboard.canvasEditor.defaultInspectorLabel");
  const inspectorSize = useResizable({
    defaultSize: 288,
    minSize: 264,
    maxSize: 400,
    autoSaveId: "nook-bookmark-details",
  });

  return (
    <AppShell
      className="nook-app-shell"
      height="fill"
      variant="section"
      contentPadding={0}
      topNav={topNav}
      sideNav={sideNav}
    >
      <Layout
        className="nook-editor-layout"
        height="fill"
        padding={0}
        content={<LayoutContent className="nook-main-content" padding={0}>{children}</LayoutContent>}
        end={inspector ? (
          <>
            <ResizeHandle
              resizable={inspectorSize.props}
              isReversed
              isAlwaysVisible={false}
              pillPlacement="center"
              label={t("dashboard.canvasEditor.resizeHandleLabel")}
            />
            <LayoutPanel
              className="nook-inspector-panel"
              resizable={inspectorSize.props}
              hasDivider
              padding={4}
              isScrollable
              label={resolvedInspectorLabel}
            >
              {inspector}
            </LayoutPanel>
          </>
        ) : undefined}
      />
    </AppShell>
  );
}
