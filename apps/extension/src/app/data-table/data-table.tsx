import { useCallback, useMemo, type ReactNode } from "react"

import {
  Table,
  proportional,
  useTableGroupedRows,
  useTableStickyColumns,
} from "@astryxdesign/core/Table"
import type { TableColumn } from "@astryxdesign/core/Table"

import { Cell } from "./cell"
import type {
  CellValue,
  DataTableColumn,
  DataTableRow,
} from "./types"
import { useDataTableView } from "./view-state"

export type DataTableProps = {
  /** Accessible name of the table. */
  label: string
  columns: DataTableColumn[]
  rows: DataTableRow[]
  /** Rendered instead of the table body when `rows` is empty. */
  empty: ReactNode
}

function cellValueToGroupKey(value: CellValue): string {
  if (value === null) return "—"
  if (typeof value === "string" || typeof value === "number") {
    return String(value)
  }
  if (value.kind === "entity") return value.title
  if (value.kind === "status") return value.label
  return value.labels.join(", ") || "—"
}

export function DataTable({ label, columns, rows, empty }: DataTableProps) {
  const view = useDataTableView()
  const visibleColumns =
    view?.visibleColumns ?? columns.map((column) => column.key)
  const shownColumns = useMemo(
    () =>
      visibleColumns
        .map((key) => columns.find((column) => column.key === key))
        .filter((column): column is DataTableColumn => column != null),
    [columns, visibleColumns],
  )
  // Stable column identity keeps Astryx's per-row memoization effective.
  const tableColumns = useMemo<TableColumn<DataTableRow>[]>(
    () =>
      shownColumns.map((column) => ({
        key: column.key,
        header: column.header,
        width: column.width ?? proportional(column.weight ?? 1),
        align: column.align,
        // Rich mapped values use the shared Astryx `Cell`; feature-specific
        // actions can provide their own Astryx composition through renderCell.
        renderCell: (row) =>
          column.renderCell ? (
            column.renderCell(row)
          ) : (
            <Cell value={row[column.key]} />
          ),
      })),
    [shownColumns]
  )

  const group = view?.config?.groups?.find(
    (option) => option.key === view.groupBy
  )
  const groupBy = useCallback(
    (row: DataTableRow) =>
      group ? cellValueToGroupKey(row[group.key] ?? null) : "—",
    [group]
  )
  const grouped = useTableGroupedRows({
    data: rows,
    groupBy,
    collapsedGroups: view?.collapsedGroups ?? new Set<string>(),
    onToggleGroup: view?.toggleGroup ?? (() => undefined),
    getRowKey: (row) => row.id,
  })
  const sticky = useTableStickyColumns<DataTableRow>({
    startKeys:
      view?.stickyStart === "none"
        ? []
        : shownColumns
            .slice(0, view?.stickyStart === "two" ? 2 : 1)
            .map((column) => column.key),
    endKeys:
      view?.stickyEnd === "none"
        ? []
        : shownColumns
            .slice(view?.stickyEnd === "two" ? -2 : -1)
            .map((column) => column.key),
  })

  return (
    <Table
      aria-label={label}
      data={group ? grouped.data : rows}
      columns={tableColumns}
      idKey={group ? grouped.idKey : "id"}
      // Compact + hover suit a dense commerce admin list; `emptyState` is
      // Astryx's own slot (default: a compact "no data" EmptyState) so we
      // hand it `empty` instead of branching on `rows.length` ourselves.
      density={view?.density ?? "compact"}
      hasHover
      plugins={
        group
          ? { grouped: grouped.plugin, sticky }
          : view != null &&
              (view.stickyStart !== "none" || view.stickyEnd !== "none")
            ? { sticky }
            : undefined
      }
      emptyState={empty}
    />
  )
}
