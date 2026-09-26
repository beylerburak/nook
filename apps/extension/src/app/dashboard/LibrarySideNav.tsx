import { Badge } from "@astryxdesign/core/Badge";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { SideNav, SideNavItem, SideNavSection } from "@astryxdesign/core/SideNav";
import { Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../i18n";
import { SparkGlyph } from "../settings-dialog/glyphs";
import { BookmarkGlyph, XGlyph, PlusGlyph } from "./glyphs";
import type { LibraryView } from "./bookmark-utils";
import type { BookmarkList } from "../../../lib/types";

export interface LibrarySideNavProps {
  view: LibraryView;
  counts: { all: number; x: number; chrome: number; unorganized: number };
  lists: BookmarkList[];
  listCounts: Map<string, number>;
  tags: [string, number][];
  onSelectView: (view: LibraryView) => void;
  onCreateList: () => void;
  onRequestDeleteList: (list: BookmarkList) => void;
}

/** The library's left rail: built-in views, collections and tags. */
export function LibrarySideNav({
  view,
  counts,
  lists,
  listCounts,
  tags,
  onSelectView,
  onCreateList,
  onRequestDeleteList,
}: LibrarySideNavProps) {
  const { t } = useI18n();
  return (
    <SideNav className="nook-glass-sidenav" aria-label={t("dashboard.sideNav.ariaLabel")} collapsible>
      <SideNavSection title={t("dashboard.sideNav.libraryTitle")}>
        <SideNavItem
          label={t("dashboard.views.all")}
          icon={<Icon icon={BookmarkGlyph} />}
          isSelected={view.kind === "all"}
          endContent={<Badge label={counts.all} />}
          onClick={() => onSelectView({ kind: "all" })}
        />
        <SideNavItem
          // "X / Twitter" is the brand pairing — kept untranslated on purpose.
          label="X / Twitter"
          icon={<Icon icon={XGlyph} />}
          isSelected={view.kind === "x"}
          endContent={<Badge label={counts.x} />}
          onClick={() => onSelectView({ kind: "x" })}
        />
        <SideNavItem
          label={t("dashboard.views.web")}
          icon={<Icon icon="externalLink" />}
          isSelected={view.kind === "chrome"}
          endContent={<Badge label={counts.chrome} />}
          onClick={() => onSelectView({ kind: "chrome" })}
        />
        <SideNavItem
          label={t("dashboard.views.unorganized")}
          icon={<Icon icon="moreHorizontal" />}
          isSelected={view.kind === "unorganized"}
          endContent={<Badge label={counts.unorganized} />}
          onClick={() => onSelectView({ kind: "unorganized" })}
        />
        <SideNavItem
          label={t("dashboard.views.organize")}
          icon={<Icon icon={SparkGlyph} />}
          isSelected={view.kind === "organize"}
          endContent={<Badge label={counts.unorganized} />}
          onClick={() => onSelectView({ kind: "organize" })}
        />
      </SideNavSection>

      <SideNavSection
        title={t("dashboard.sideNav.collectionsTitle")}
        endContent={
          <Button
            label={t("dashboard.sideNav.createCollection")}
            variant="ghost"
            size="sm"
            isIconOnly
            icon={<Icon icon={PlusGlyph} />}
            onClick={onCreateList}
          />
        }
      >
        {lists.length === 0 ? (
          <Text type="supporting" color="secondary">{t("dashboard.sideNav.noCollections")}</Text>
        ) : (
          lists.map((list) => (
            <SideNavItem
              key={list.id}
              label={(list.icon || list.emoji || "📁") + " " + list.name}
              isSelected={view.kind === "list" && view.id === list.id}
              endContent={<Badge label={listCounts.get(list.id) ?? 0} />}
              actions={
                <Button
                  label={t("dashboard.sideNav.deleteCollection", { name: list.name })}
                  variant="ghost"
                  size="sm"
                  isIconOnly
                  icon={<Icon icon="close" size="sm" />}
                  onClick={(event) => {
                    event.stopPropagation();
                    onRequestDeleteList(list);
                  }}
                />
              }
              onClick={() => onSelectView({ kind: "list", id: list.id })}
            />
          ))
        )}
      </SideNavSection>

      <SideNavSection title={t("dashboard.sideNav.tagsTitle")}>
        {tags.length === 0 ? (
          <Text type="supporting" color="secondary">{t("dashboard.sideNav.noTags")}</Text>
        ) : (
          tags.map(([tag, count]) => (
            <SideNavItem
              key={tag}
              label={"#" + tag}
              isSelected={view.kind === "tag" && view.id === tag}
              endContent={<Badge label={count} />}
              onClick={() => onSelectView({ kind: "tag", id: tag })}
            />
          ))
        )}
      </SideNavSection>
    </SideNav>
  );
}
