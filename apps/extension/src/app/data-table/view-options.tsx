import { useId, useState, type SVGProps } from "react"

import { Button } from "@astryxdesign/core/Button"
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout"
import { Icon } from "@astryxdesign/core/Icon"
import { IconButton } from "@astryxdesign/core/IconButton"
import { Item } from "@astryxdesign/core/Item"
import { List } from "@astryxdesign/core/List"
import { Popover } from "@astryxdesign/core/Popover"
import { RadioList, RadioListItem } from "@astryxdesign/core/RadioList"
import { Section } from "@astryxdesign/core/Section"
import { Heading, Text } from "@astryxdesign/core/Text"
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden"

import {
  useDataTableView,
  type DataTableDensity,
  type DataTableStickyCount,
} from "./view-state"

function GripDotsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" {...props}>
      {[3, 8, 13].flatMap((y) =>
        [5, 11].map((x) => (
          <circle
            key={x + "-" + y}
            cx={x}
            cy={y}
            r="1.25"
            fill="currentColor"
          />
        )),
      )}
    </svg>
  )
}

function TableCellsIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3.5" y="4" width="17" height="16" rx="1.5" />
      <path d="M3.5 9.3h17M3.5 14.7h17M9.2 4v16M14.8 4v16" />
    </svg>
  )
}

function PlusIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

function MapPinIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M19 10c0 5.2-7 11-7 11s-7-5.8-7-11a7 7 0 1 1 14 0Z" />
      <circle cx="12" cy="10" r="2.4" />
    </svg>
  )
}

function AdjustmentsHorizontalIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4 6h16M4 12h16M4 18h16" />
      <path d="M8 4v4m8 2v4m-5 2v4" />
    </svg>
  )
}

type ViewSection = "columns" | "density" | "sticky" | "grouping"

export type DataTableViewOptionsMessages = {
  label: string
  columnsLabel: {
    title: string
    displayed: string
    available: string
    restore: string
    selectAll: string
    emptyDisplayed: string
    emptyAvailable: string
    required: string
    reorder: string
    reorderHint: string
    remove: string
    add: string
  }
  densityLabel: string
  stickyLabel: string
  stickyStartLabel: string
  stickyEndLabel: string
  stickyNoneLabel: string
  stickyOneLabel: string
  stickyTwoLabel: string
  groupingLabel: string
  groupingNoneLabel: string
  densityLabels: Record<DataTableDensity, string>
}

export function DataTableViewOptions({
  label,
  columnsLabel,
  densityLabel,
  stickyLabel,
  stickyStartLabel,
  stickyEndLabel,
  stickyNoneLabel,
  stickyOneLabel,
  stickyTwoLabel,
  groupingLabel,
  groupingNoneLabel,
  densityLabels,
}: DataTableViewOptionsMessages) {
  const view = useDataTableView()
  const [section, setSection] = useState<ViewSection>("columns")
  const [draggedColumn, setDraggedColumn] = useState<string | null>(null)
  const columnPanelId = useId()

  if (!view?.config) return null

  const { config } = view
  const groups = config.groups ?? []
  const requiredColumns = new Set(
    config.requiredVisibleColumns ?? [config.columns[0]?.key].filter(Boolean),
  )
  const displayedColumns = view.visibleColumns
  const availableColumns = config.columns.filter(
    (column) => !displayedColumns.includes(column.key),
  )
  const defaultColumns =
    config.defaultVisibleColumns ?? config.columns.map((column) => column.key)

  const moveColumn = (key: string, delta: -1 | 1) => {
    const index = displayedColumns.indexOf(key)
    const target = index + delta

    if (index < 0 || target < 0 || target >= displayedColumns.length) return

    const next = [...displayedColumns]
    ;[next[index], next[target]] = [next[target], next[index]]
    view.setVisibleColumns(next)
  }

  const moveColumnTo = (
    source: string,
    target: string,
    position: "before" | "after",
  ) => {
    if (source === target) return

    const next = displayedColumns.filter((key) => key !== source)
    const targetIndex = next.indexOf(target)

    if (targetIndex < 0) return

    next.splice(targetIndex + (position === "after" ? 1 : 0), 0, source)
    view.setVisibleColumns(next)
  }

  const sectionItems = [
    {
      key: "columns" as const,
      label: columnsLabel.title,
      icon: <Icon icon="viewColumns" size="sm" />,
    },
    {
      key: "density" as const,
      label: densityLabel,
      icon: <Icon icon={TableCellsIcon} size="sm" />,
    },
    {
      key: "sticky" as const,
      label: stickyLabel,
      icon: <Icon icon={MapPinIcon} size="sm" />,
    },
    {
      key: "grouping" as const,
      label: groupingLabel,
      icon: <Icon icon={TableCellsIcon} size="sm" />,
    },
  ]
  const activeLabel = sectionItems.find((item) => item.key === section)?.label

  const panel = (() => {
    switch (section) {
      case "columns":
        return (
          <VStack
            gap={0}
            minHeight={0}
            className="nook-data-table-transfer-root"
          >
            <HStack
              gap={0}
              minHeight={0}
              width="100%"
              className="nook-data-table-transfer-panels"
            >
              <VStack
                gap={0}
                role="group"
                aria-labelledby={columnPanelId + "-displayed"}
                className="nook-data-table-transfer-panel"
              >
                <HStack
                  gap={2}
                  hAlign="between"
                  vAlign="center"
                  paddingBlock={2}
                  className="nook-data-table-transfer-header nook-data-table-transfer-pad-start"
                >
                  <Text
                    id={columnPanelId + "-displayed"}
                    type="label"
                    color="secondary"
                  >
                    {columnsLabel.displayed}
                  </Text>
                  <Button
                    label={columnsLabel.restore}
                    variant="ghost"
                    size="sm"
                    className="nook-data-table-transfer-header-action"
                    onClick={() => view.setVisibleColumns(defaultColumns)}
                  />
                </HStack>
                <VStack gap={0} className="nook-data-table-transfer-body">
                  {displayedColumns.length === 0 ? (
                    <VStack
                      gap={0}
                      vAlign="center"
                      hAlign="center"
                      minHeight="100%"
                      paddingBlock={4}
                      className="nook-data-table-transfer-empty nook-data-table-transfer-pad-start"
                    >
                      <Text type="supporting" color="secondary">
                        {columnsLabel.emptyDisplayed}
                      </Text>
                    </VStack>
                  ) : (
                    <List
                      density="compact"
                      header={
                        <VisuallyHidden>
                          {columnsLabel.displayed}
                        </VisuallyHidden>
                      }
                    >
                      {displayedColumns.map((key) => {
                        const column = config.columns.find(
                          (item) => item.key === key,
                        )
                        if (!column) return null

                        const locked = requiredColumns.has(key)

                        return (
                          <Item
                            key={key}
                            as="li"
                            density="compact"
                            label={column.label}
                            className="nook-data-table-transfer-item nook-data-table-transfer-pad-start"
                            onDragOver={(event) => {
                              event.preventDefault()
                              event.dataTransfer.dropEffect = "move"
                            }}
                            onDrop={(event) => {
                              if (draggedColumn != null) {
                                const bounds =
                                  event.currentTarget.getBoundingClientRect()
                                const position =
                                  event.clientY > bounds.top + bounds.height / 2
                                    ? "after"
                                    : "before"
                                moveColumnTo(draggedColumn, key, position)
                              }

                              setDraggedColumn(null)
                            }}
                            startContent={
                              <IconButton
                                label={columnsLabel.reorder.replace(
                                  "{column}",
                                  column.label,
                                )}
                                variant="ghost"
                                size="sm"
                                icon={<Icon icon={GripDotsIcon} size="sm" />}
                                tooltip={columnsLabel.reorderHint}
                                className="nook-data-table-transfer-grip"
                                draggable
                                onDragStart={(event) => {
                                  event.dataTransfer.effectAllowed = "move"
                                  event.dataTransfer.setData("text/plain", key)
                                  setDraggedColumn(key)
                                }}
                                onDragEnd={() => setDraggedColumn(null)}
                                onKeyDown={(event) => {
                                  if (event.key === "ArrowUp") {
                                    event.preventDefault()
                                    moveColumn(key, -1)
                                  } else if (event.key === "ArrowDown") {
                                    event.preventDefault()
                                    moveColumn(key, 1)
                                  }
                                }}
                              />
                            }
                            endContent={
                              <IconButton
                                label={columnsLabel.remove.replace(
                                  "{column}",
                                  column.label,
                                )}
                                variant="ghost"
                                size="sm"
                                isDisabled={locked}
                                tooltip={
                                  locked ? columnsLabel.required : undefined
                                }
                                icon={<Icon icon="close" size="sm" />}
                                className="nook-data-table-transfer-end-action"
                                onClick={() =>
                                  view.setVisibleColumns(
                                    displayedColumns.filter(
                                      (item) => item !== key,
                                    ),
                                  )
                                }
                              />
                            }
                          />
                        )
                      })}
                    </List>
                  )}
                </VStack>
              </VStack>
              <VStack
                gap={0}
                role="group"
                aria-labelledby={columnPanelId + "-available"}
                className="nook-data-table-transfer-panel nook-data-table-transfer-divider"
              >
                <HStack
                  gap={2}
                  hAlign="between"
                  vAlign="center"
                  paddingBlock={2}
                  className="nook-data-table-transfer-header nook-data-table-transfer-pad-end"
                >
                  <Text
                    id={columnPanelId + "-available"}
                    type="label"
                    color="secondary"
                  >
                    {columnsLabel.available}
                  </Text>
                  <Button
                    label={columnsLabel.selectAll}
                    variant="ghost"
                    size="sm"
                    isDisabled={availableColumns.length === 0}
                    className="nook-data-table-transfer-header-action"
                    onClick={() =>
                      view.setVisibleColumns(
                        config.columns.map((column) => column.key),
                      )
                    }
                  />
                </HStack>
                <VStack gap={0} className="nook-data-table-transfer-body">
                  {availableColumns.length === 0 ? (
                    <VStack
                      gap={0}
                      vAlign="center"
                      hAlign="center"
                      minHeight="100%"
                      paddingBlock={4}
                      className="nook-data-table-transfer-empty nook-data-table-transfer-pad-end"
                    >
                      <Text type="supporting" color="secondary">
                        {columnsLabel.emptyAvailable}
                      </Text>
                    </VStack>
                  ) : (
                    <List
                      density="compact"
                      header={
                        <VisuallyHidden>
                          {columnsLabel.available}
                        </VisuallyHidden>
                      }
                    >
                      {availableColumns.map((column) => (
                        <Item
                          key={column.key}
                          as="li"
                          density="compact"
                          label={column.label}
                          className="nook-data-table-transfer-item nook-data-table-transfer-pad-end"
                          endContent={
                            <IconButton
                              label={columnsLabel.add.replace(
                                "{column}",
                                column.label,
                              )}
                              variant="ghost"
                              size="sm"
                              icon={<Icon icon={PlusIcon} size="sm" />}
                              className="nook-data-table-transfer-end-action"
                              onClick={() =>
                                view.setVisibleColumns([
                                  ...displayedColumns,
                                  column.key,
                                ])
                              }
                            />
                          }
                        />
                      ))}
                    </List>
                  )}
                </VStack>
              </VStack>
            </HStack>
          </VStack>
        )

      case "density":
        return (
          <VStack gap={0} paddingInline={4} paddingBlockEnd={4}>
            <RadioList
              label={densityLabel}
              isLabelHidden
              value={view.density}
              onChange={(value) => view.setDensity(value as DataTableDensity)}
            >
              {Object.entries(densityLabels).map(([value, text]) => (
                <RadioListItem key={value} value={value} label={text} />
              ))}
            </RadioList>
          </VStack>
        )

      case "sticky":
        return (
          <VStack gap={4} paddingInline={4} paddingBlockEnd={4}>
            <RadioList
              label={stickyStartLabel}
              value={view.stickyStart}
              onChange={(value) =>
                view.setStickyStart(value as DataTableStickyCount)
              }
            >
              <RadioListItem value="none" label={stickyNoneLabel} />
              <RadioListItem value="one" label={stickyOneLabel} />
              <RadioListItem value="two" label={stickyTwoLabel} />
            </RadioList>
            <RadioList
              label={stickyEndLabel}
              value={view.stickyEnd}
              onChange={(value) =>
                view.setStickyEnd(value as DataTableStickyCount)
              }
            >
              <RadioListItem value="none" label={stickyNoneLabel} />
              <RadioListItem value="one" label={stickyOneLabel} />
              <RadioListItem value="two" label={stickyTwoLabel} />
            </RadioList>
          </VStack>
        )

      case "grouping":
        return groups.length > 0 ? (
          <VStack gap={0} paddingInline={4} paddingBlockEnd={4}>
            <RadioList
              label={groupingLabel}
              isLabelHidden
              value={view.groupBy ?? "none"}
              onChange={(value) =>
                view.setGroupBy(value === "none" ? null : value)
              }
            >
              <RadioListItem value="none" label={groupingNoneLabel} />
              {groups.map((group) => (
                <RadioListItem
                  key={group.key}
                  value={group.key}
                  label={group.label}
                />
              ))}
            </RadioList>
          </VStack>
        ) : (
          <Text type="supporting" color="secondary">
            {groupingNoneLabel}
          </Text>
        )
    }
  })()

  const content = (
    <HStack gap={0} width={660} className="nook-data-table-view-popover">
      <Section
        variant="transparent"
        width={184}
        padding={1}
        dividers={["end"]}
        className="nook-data-table-view-rail"
      >
        <VStack gap={1}>
          {sectionItems.map((item) => (
            <Button
              key={item.key}
              label={item.label}
              icon={item.icon}
              variant={section === item.key ? "secondary" : "ghost"}
              size="md"
              width="100%"
              className="nook-data-table-view-rail-item"
              onClick={() => setSection(item.key)}
            />
          ))}
        </VStack>
      </Section>
      <StackItem size="fill">
        <VStack
          gap={0}
          minHeight={0}
          className="nook-data-table-view-panel"
        >
          <VStack gap={0} padding={4} paddingBlockEnd={3}>
            {activeLabel ? <Heading level={3}>{activeLabel}</Heading> : null}
          </VStack>
          {panel}
        </VStack>
      </StackItem>
    </HStack>
  )

  return (
    <Popover
      content={content}
      placement="below"
      alignment="end"
      width={660}
      label={label}
      className="nook-data-table-view-popover-surface"
    >
      <Button
        label={label}
        variant="ghost"
        size="md"
        isIconOnly
        className="nook-data-table-view-trigger"
        icon={<Icon icon={AdjustmentsHorizontalIcon} size="md" />}
      />
    </Popover>
  )
}
