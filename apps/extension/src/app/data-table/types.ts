import type { ReactNode } from "react"
import type { ColumnWidth } from "@astryxdesign/core/Table"

/**
 * The normalized view model a list screen hands to `DataTable`. The feature
 * adapter formats dates and picks a cell kind, leaving this component focused
 * on rendering shared table content.
 */
export type StatusTone = "neutral" | "success" | "warning" | "danger" | "info"

/** The row's identity: optional image, a title (optionally a link), a secondary line. */
export type EntityCell = {
  kind: "entity"
  title: string
  subtitle?: string
  imageUrl?: string | null
  href?: string
}

export type StatusCell = { kind: "status"; label: string; tone: StatusTone }

export type TokensCell = {
  kind: "tokens"
  labels: string[]
  /** The real count when `labels` is already a truncated list. */
  total?: number
}

/** Already-formatted text, or one of the rich cell kinds. */
export type CellValue =
  string | number | null | EntityCell | StatusCell | TokensCell

export type DataTableColumn = {
  key: string
  header: string
  /** Relative width (Astryx `proportional`); defaults to 1. */
  weight?: number
  /** Exact Astryx column width, for fixed utility columns. */
  width?: ColumnWidth
  align?: "start" | "end"
  /** Optional Astryx cell composition for feature-specific row actions. */
  renderCell?: (row: DataTableRow) => ReactNode
}

export type DataTableRow = { id: string; [key: string]: CellValue }
