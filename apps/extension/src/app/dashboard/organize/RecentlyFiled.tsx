import { Item } from "@astryxdesign/core/Item";
import { VStack } from "@astryxdesign/core/Layout";
import { Heading, Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../../i18n";
import type { AiLogEntry } from "../../../../lib/ai-client";
import type { Bookmark, BookmarkList } from "../../../../lib/types";
import { describeRemainder, recentlyFiledRows, remainderCounts } from "./organize-utils";

export interface RecentlyFiledProps {
  log: AiLogEntry[];
  items: Bookmark[];
  lists: BookmarkList[];
  /** `settings.collectionMinConfidence` — see `remainderCounts` for why the
   *  threshold, not just the raw log, is what tells "wasn't sure" apart from
   *  "none fit". */
  collectionMinConfidence: number;
}

/**
 * "Recently filed" — dense rows (Item, not Card: this is a list of records,
 * not a set of standalone widgets — see AGENTS.md), plus a plain-language
 * line for whatever the same pass didn't file. Both read straight off
 * `status.run.log`, so this needs no server route of its own.
 */
export function RecentlyFiled({ log, items, lists, collectionMinConfidence }: RecentlyFiledProps) {
  const { t } = useI18n();
  const rows = recentlyFiledRows(log, items, lists, t);
  const remainder = describeRemainder(t, remainderCounts(log, collectionMinConfidence));

  return (
    <VStack gap={2} width="100%">
      <Heading level={3}>{t("dashboard.organize.recentlyFiledTitle")}</Heading>
      {rows.length === 0 ? (
        <Text type="supporting" color="secondary">
          {t("dashboard.organize.recentlyFiledEmpty")}
        </Text>
      ) : (
        <VStack as="ul" role="list" gap={0}>
          {rows.map((row) => (
            <Item
              key={row.id}
              as="li"
              density="compact"
              label={row.title}
              description={[row.author, row.collectionName].filter(Boolean).join(" · ") || undefined}
            />
          ))}
        </VStack>
      )}
      {remainder.map((line) => (
        <Text key={line} type="supporting" color="secondary">
          {line}
        </Text>
      ))}
    </VStack>
  );
}
