import { useMemo } from "react"

import { Button } from "@astryxdesign/core/Button"
import { HStack } from "@astryxdesign/core/Layout"
import { Icon } from "@astryxdesign/core/Icon"
import { Text } from "@astryxdesign/core/Text"
import { pixel } from "@astryxdesign/core/Table"

import type { Bookmark, BookmarkList } from "../../../lib/types"
import { DataTable } from "./data-table"
import type { DataTableColumn, DataTableRow } from "./types"
import type { DataTableViewConfig } from "./view-state"

export const BOOKMARK_TABLE_COLUMNS: DataTableColumn[] = [
  { key: "bookmark", header: "Bookmark", weight: 2.4 },
  { key: "source", header: "Source", weight: 0.8 },
  { key: "saved", header: "Saved", weight: 1 },
  { key: "collection", header: "Collection", weight: 1.2 },
  { key: "tags", header: "Tags", weight: 1.2 },
  { key: "note", header: "Note", weight: 1.5 },
  { key: "actions", header: "", width: pixel(144), align: "end" },
]

export const BOOKMARK_TABLE_VIEW_CONFIG: DataTableViewConfig = {
  columns: BOOKMARK_TABLE_COLUMNS.map((column) => ({
    key: column.key,
    label: typeof column.header === "string" && column.header ? column.header : "Actions",
  })),
  groups: [
    { key: "source", label: "Source" },
    { key: "collection", label: "Collection" },
  ],
  defaultVisibleColumns: ["bookmark", "source", "saved", "collection", "tags", "actions"],
  requiredVisibleColumns: ["bookmark"],
}

function getTitle(item: Bookmark) {
  if (item.source === "chrome") {
    return item.title || item.creator?.name || item.creator?.handle || "Web bookmark"
  }
  return item.creator?.name || item.creator?.handle || "X post"
}

function getDescription(item: Bookmark) {
  return item.description || item.shortDescription || item.title || ""
}

function formatSavedDate(item: Bookmark) {
  const raw = item.savedAt || item.createdAt || item.updatedAt
  if (!raw) return "—"
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) return "—"
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(date)
}

function toRow(
  item: Bookmark,
  collectionName: string,
): DataTableRow {
  const tags = (item.tags ?? []).map((tag) => tag.replace(/^#/, "").trim()).filter(Boolean)
  return {
    id: item.id,
    bookmark: {
      kind: "entity",
      title: getTitle(item),
      subtitle: getDescription(item),
      imageUrl: item.creator?.avatar,
    },
    source: {
      kind: "status",
      label: item.source === "x" ? "X / Twitter" : "Web",
      tone: item.source === "x" ? "info" : "neutral",
    },
    saved: formatSavedDate(item),
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
  const listById = useMemo(() => new Map(lists.map((list) => [list.id, list])), [lists])
  const itemById = useMemo(() => new Map(items.map((item) => [item.id, item])), [items])
  const rows = useMemo(
    () => items.map((item) => {
      const list = item.listId ? listById.get(item.listId) : undefined
      return toRow(item, list?.name || item.listName || "Unorganized")
    }),
    [items, listById],
  )
  const columns = useMemo<DataTableColumn[]>(
    () => BOOKMARK_TABLE_COLUMNS.map((column) =>
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
                      label="Open"
                      variant="ghost"
                      size="sm"
                      icon={<Icon icon="externalLink" size="sm" />}
                      onClick={() => onOpenUrl(url)}
                    />
                  ) : null}
                  <Button
                    label="Details"
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
    [itemById, onOpenDetails, onOpenUrl],
  )

  return (
    <DataTable
      label="Saved bookmarks"
      columns={columns}
      rows={rows}
      empty={<Text type="supporting" color="secondary">No bookmarks to show.</Text>}
    />
  )
}
