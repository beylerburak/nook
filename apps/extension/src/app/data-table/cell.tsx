import { Avatar } from "@astryxdesign/core/Avatar"
import { HStack, VStack } from "@astryxdesign/core/Layout"
import { Link } from "@astryxdesign/core/Link"
import { StatusDot } from "@astryxdesign/core/StatusDot"
import { Text } from "@astryxdesign/core/Text"
import { Token } from "@astryxdesign/core/Token"

import type { CellValue, StatusTone } from "./types"

// StatusDot's variant names aren't the same words as our tone names; "info"
// has no direct match, so it borrows the "accent" (highlight) variant.
const STATUS_VARIANT: Record<
  StatusTone,
  "success" | "warning" | "error" | "accent" | "neutral"
> = {
  neutral: "neutral",
  success: "success",
  warning: "warning",
  danger: "error",
  info: "accent",
}

const MAX_VISIBLE_TOKENS = 3

/**
 * Renders one table cell for every `CellValue` kind. This is the only place
 * a list screen's data reaches an Astryx component — columns never render
 * Astryx directly, they hand their value to `Cell`.
 */
export function Cell({ value }: { value: CellValue }) {
  if (value === null) {
    return null
  }

  if (typeof value === "string" || typeof value === "number") {
    // maxLines keeps every row a single line tall; Text's own truncation
    // shows the full value in a tooltip when it's clipped.
    return (
      <Text type="body" maxLines={1}>
        {value}
      </Text>
    )
  }

  if (value.kind === "entity") {
    return (
      <HStack gap={2} vAlign="center">
        {/* Avatar, not Thumbnail (a fixed 64px upload tile). Decorative: the
            title beside it is the accessible name; `name` only feeds the
            initials fallback. */}
        <Avatar
          src={value.imageUrl ?? undefined}
          name={value.title}
          shape="rounded"
          tooltip={false}
          aria-hidden
        />
        <VStack gap={0}>
          {value.href ? (
            <Link href={value.href} weight="medium" maxLines={1}>
              {value.title}
            </Link>
          ) : (
            <Text type="body" weight="medium" maxLines={1}>
              {value.title}
            </Text>
          )}
          {value.subtitle ? (
            <Text type="supporting" maxLines={1}>
              {value.subtitle}
            </Text>
          ) : null}
        </VStack>
      </HStack>
    )
  }

  if (value.kind === "status") {
    return (
      <HStack gap={1.5} vAlign="center">
        <StatusDot variant={STATUS_VARIANT[value.tone]} label={value.label} />
        <Text type="body">{value.label}</Text>
      </HStack>
    )
  }

  const visible = value.labels.slice(0, MAX_VISIBLE_TOKENS)
  const hiddenCount = (value.total ?? value.labels.length) - visible.length

  return (
    <HStack gap={1} vAlign="center">
      {visible.map((label, index) => (
        <Token key={`${index}-${label}`} label={label} size="sm" />
      ))}
      {hiddenCount > 0 ? <Token label={`+${hiddenCount}`} size="sm" /> : null}
    </HStack>
  )
}
