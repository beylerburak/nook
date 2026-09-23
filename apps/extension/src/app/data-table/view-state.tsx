import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react"

export type DataTableDensity = "compact" | "balanced" | "spacious"
export type DataTableStickyCount = "none" | "one" | "two"

export type DataTableViewColumn = { key: string; label: string }
/** A group is keyed by a table column so view configuration stays declarative. */
export type DataTableViewGroup = {
  key: string
  label: string
}

export type DataTableViewConfig = {
  columns: DataTableViewColumn[]
  groups?: DataTableViewGroup[]
  defaultVisibleColumns?: string[]
  /** Columns that must remain visible (usually the row's identity column). */
  requiredVisibleColumns?: string[]
}

type DataTableViewState = {
  visibleColumns: string[]
  density: DataTableDensity
  stickyStart: DataTableStickyCount
  stickyEnd: DataTableStickyCount
  groupBy: string | null
  collapsedGroups: Set<string>
  toggleGroup: (key: string) => void
  setVisibleColumns: (keys: string[]) => void
  setDensity: (density: DataTableDensity) => void
  setStickyStart: (count: DataTableStickyCount) => void
  setStickyEnd: (count: DataTableStickyCount) => void
  setGroupBy: (key: string | null) => void
  config?: DataTableViewConfig
}

const ViewContext = createContext<DataTableViewState | null>(null)

export function DataTableViewProvider({
  children,
  config,
}: {
  children: ReactNode
  config: DataTableViewConfig
}) {
  const columnKeys = useMemo(
    () => new Set(config.columns.map((column) => column.key)),
    [config.columns]
  )
  const requiredColumns = useMemo(
    () =>
      (config.requiredVisibleColumns ?? [config.columns[0]?.key]).filter(
        (key): key is string => Boolean(key) && columnKeys.has(key)
      ),
    [config.columns, config.requiredVisibleColumns, columnKeys]
  )
  const normalizeVisibleColumns = useCallback(
    (keys: string[]) => {
      const normalized = keys.filter(
        (key, index) => columnKeys.has(key) && keys.indexOf(key) === index
      )
      const next = [...normalized]
      for (const required of requiredColumns) {
        if (next.includes(required)) continue
        const requiredIndex = config.columns.findIndex(
          (column) => column.key === required
        )
        const insertAt = next.findIndex(
          (key) =>
            config.columns.findIndex((column) => column.key === key) >
            requiredIndex
        )
        next.splice(insertAt < 0 ? next.length : insertAt, 0, required)
      }
      return next
    },
    [columnKeys, config.columns, requiredColumns]
  )
  const defaultColumns =
    config.defaultVisibleColumns ?? config.columns.map((column) => column.key)
  const [visibleColumns, setVisibleColumnsState] = useState(() =>
    normalizeVisibleColumns(defaultColumns)
  )
  const setVisibleColumns = useCallback(
    (keys: string[]) => setVisibleColumnsState(normalizeVisibleColumns(keys)),
    [normalizeVisibleColumns]
  )
  const [density, setDensity] = useState<DataTableDensity>("compact")
  const [stickyStart, setStickyStart] = useState<DataTableStickyCount>("none")
  const [stickyEnd, setStickyEnd] = useState<DataTableStickyCount>("none")
  const [groupBy, setGroupBy] = useState<string | null>(null)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
  const toggleGroup = (key: string) =>
    setCollapsedGroups((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const value = useMemo(
    () => ({
      visibleColumns,
      density,
      stickyStart,
      stickyEnd,
      groupBy,
      collapsedGroups,
      toggleGroup,
      setVisibleColumns,
      setDensity,
      setStickyStart,
      setStickyEnd,
      setGroupBy,
      config,
    }),
    [
      visibleColumns,
      density,
      stickyStart,
      stickyEnd,
      groupBy,
      collapsedGroups,
      setVisibleColumns,
      config,
    ]
  )

  return <ViewContext.Provider value={value}>{children}</ViewContext.Provider>
}

export function useDataTableView() {
  return useContext(ViewContext)
}
