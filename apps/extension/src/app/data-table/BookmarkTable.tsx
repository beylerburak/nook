import { useMemo } from "react"

import { Button } from "@astryxdesign/core/Button"
import { HStack } from "@astryxdesign/core/Layout"
import { Icon } from "@astryxdesign/core/Icon"
import { Text } from "@astryxdesign/core/Text"
import { pixel } from "@astryxdesign/core/Table"

import type { Bookmark, BookmarkList } from "../../../lib/types"
import { useI18n, type I18nContextValue } from "../../i18n"
import { itemTitle, visibleText } from "../dashboard/bookmark-utils"
import { DataTable } from "./data-table"
import type { DataTableColumn, DataTableRow } from "./types"
import type { DataTableViewConfig } from "./view-state"

type TranslateFn = I18nContextValue["t"]
type FormatDateFn = I18nContextValue["formatDate"]

function buildColumns(t: TranslateFn): DataTableColumn[] {
  return [
    { key: "bookmark", header: t("dashboard.table.bookmarkHeader"), weight: 2.4 },
    { key: "source", header: t("dashboard.table.sourceHeader"), weight: 0.8 },
    { key: "saved", header: t("dashboard.table.savedHeader"), weight: 1 },
    { key: "collection", header: t("dashboard.table.collectionHeader"), weight: 1.2 },
    { key: "tags", header: t("dashboard.table.tagsHeader"), weight: 1.2 },
    { key: "note", header: t("dashboard.table.noteHeader"), weight: 1.5 },
    { key: "actions", header: "", width: pixel(144), align: "end" },
  ]
}

/**
 * The static view-config passed to `<DataTableViewProvider>` from
 * `DashboardApp.tsx`, so it needs a `t` from that component's own
 * `useI18n()` rather than reading one internally.
 */
export function getBookmarkTableViewConfig(t: TranslateFn): DataTableViewConfig {
  const columns = buildColumns(t)
  return {
    columns: columns.map((column) => ({
      key: column.key,
      label: typeof column.header === "string" && column.header ? column.header : t("dashboard.table.actionsHeader"),
    })),
    groups: [
      { key: "source", label: t("dashboard.table.sourceHeader") },
      { key: "collection", label: t("dashboard.table.collectionHeader") },
    ],
    defaultVisibleColumns: ["bookmark", "source", "saved", "collection", "tags", "actions"],
    requiredVisibleColumns: ["bookmark"],
  }
}

function formatSavedDate(item: Bookmark, formatDate: FormatDateFn) {
  const raw = item.savedAt || item.createdAt || item.updatedAt
  if (!raw) return "—"
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return "—"
  return formatDate(date, { dateStyle: "medium" })
}

function toRow(
  item: Bookmark,
  collectionName: string,
  t: TranslateFn,
  formatDate: FormatDateFn,
): DataTableRow {
  const tags = (item.tags ?? []).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean)
  return {
    id: item.id,
    bookmark: {
      kind: "entity",
      title: itemTitle(item, t),
      subtitle: visibleText(item),
      imageUrl: item.creator?.avatar,
    },
    source: {
      kind: "status",
      // "X / Twitter" is the brand pairing — kept untranslated on purpose.
      label: item.source === "x" ? "X / Twitter" : t("dashboard.table.sourceWeb"),
      tone: item.source === "x" ? "info" : "neutral",
    },
    saved: formatSavedDate(item, formatDate),
    collection: collectionName,
    tags: tags.length ? { kind: "tokens", labels: tags, total: tags.length } : "—",
    note: item.note?.trim() || "—",
    actions: null,
  }
}

export function BookmarkTable({
  items,
  lists,
  onOpenDetails,
  onOpenUrl,
}: {
  items: Bookmark[]
  lists: BookmarkList[]
  onOpenDetails: (item: Bookmark) => void
  onOpenUrl: (url: string) => void
}) {
  const { t, formatDate } = useI18n()
  const listById = useMemo(() => new Map(lists.map((list) => [list.id, list])), [lists])
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const rows = useMemo(
    () => items.map((item) => {
      const list = item.listId ? listById.get(item.listId) : undefined
      return toRow(item, list?.name || item.listName || t("dashboard.views.unorganized"), t, formatDate)
    }),
    [items, listById, t, formatDate],
  )
  const columns = useMemo<DataTableColumn[]>(
    () => buildColumns(t).map((column) =>
      column.key === "actions"
        ? {
            ...column,
            renderCell: (row: DataTableRow) => {
              const item = itemById.get(row.id)
              if (!item) return null
              const url = item.url || item.urls?.[0]
              return (
                <HStack gap={1} vAlign="center" hAlign="end" wrap="nowrap">
                  {url ? (
                    <Button
                      label={t("dashboard.table.open")}
                      variant="ghost"
                      size="sm"
                      icon={<Icon icon="externalLink" size="sm" />}
                      onClick={() => onOpenUrl(url)}
                    />
                  ) : null}
                  <Button
                    label={t("dashboard.card.details")}
                    variant="secondary"
                    size="sm"
                    onClick={() => onOpenDetails(item)}
                  />
                </HStack>
              )
            },
          }
        : column,
    ),
    [t, itemById, onOpenDetails, onOpenUrl],
  )

  return (
    <DataTable
      label={t("dashboard.table.ariaLabel")}
      columns={columns}
      rows={rows}
      empty={<Text type="supporting" color="secondary">{t("dashboard.table.empty")}</Text>}
    />
  )
}
