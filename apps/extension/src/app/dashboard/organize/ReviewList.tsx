import { useMemo, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { useToast } from "@astryxdesign/core/Toast";
import { useI18n } from "../../../i18n";
import type { Bookmark, BookmarkList } from "../../../../lib/types";
import { reviewConfidenceLabel, reviewRows, type ReviewRow } from "./organize-utils";
import { useReviewList } from "./useReviewList";

/**
 * "Needs your review" — Jev's guesses that came in below the confidence
 * threshold (`GET /api/ai/review`). Each row is one bookmark, one guessed
 * collection, and three ways to settle it: accept as guessed, accept into a
 * different collection, or dismiss. The same list backs the small chip on
 * `BookmarkCard` — this block and that chip both read `useReviewList()`
 * rather than each fetching their own copy.
 *
 * The caller (`OrganizePage.tsx`) only mounts this once
 * `reviewList.items.length > 0`, so every render here assumes there is
 * something to show.
 */
export function ReviewList({ items, lists }: { items: Bookmark[]; lists: BookmarkList[] }) {
  const { t } = useI18n();
  const toast = useToast();
  const reviewList = useReviewList();
  const rows = useMemo(() => reviewRows(reviewList.items, items, t), [reviewList.items, items, t]);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set());
  const [isBulkBusy, setIsBulkBusy] = useState(false);
  const likelyCount = reviewList.likelyItems.length;

  const withBusy = async (ids: string[], run: () => Promise<unknown>) => {
    setBusyIds((current) => new Set([...current, ...ids]));
    try {
      await run();
    } finally {
      setBusyIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
    }
  };

  const resolveOne = (bookmarkId: string, action: "accept" | "reject", listId?: string) =>
    void withBusy([bookmarkId], async () => {
      const result = await reviewList.resolve([{ bookmarkId, action, ...(listId ? { listId } : {}) }]);
      if (result === null) toast({ body: t("dashboard.organize.review.actionFailed"), type: "error" });
    });

  const acceptAllLikely = () =>
    void withBusy(
      reviewList.likelyItems.map((item) => item.bookmarkId),
      async () => {
        const resolved = reviewList.likelyItems.map((item) => ({ bookmarkId: item.bookmarkId, action: "accept" as const }));
        setIsBulkBusy(true);
        try {
          const result = await reviewList.resolve(resolved);
          if (result === null) {
            toast({ body: t("dashboard.organize.review.actionFailed"), type: "error" });
            return;
          }
          toast({ body: t("dashboard.organize.review.resolvedToast", { count: result.filed }) });
        } finally {
          setIsBulkBusy(false);
        }
      },
    );

  return (
    <VStack gap={3} width="100%">
      <HStack justify="between" align="center" wrap="wrap" gap={2}>
        <VStack gap={0.5}>
          <Text weight="semibold">{t("dashboard.organize.review.heading")}</Text>
          <Text type="supporting" color="secondary">
            {t("dashboard.organize.review.description")}
          </Text>
        </VStack>
        {likelyCount > 0 ? (
          <Button
            label={t("dashboard.organize.review.acceptAllLikely")}
            variant="secondary"
            size="sm"
            isLoading={isBulkBusy}
            isDisabled={isBulkBusy}
            onClick={acceptAllLikely}
          />
        ) : null}
      </HStack>

      <VStack as="ul" role="list" gap={0} width="100%">
        {rows.map((row) => (
          <ReviewRowItem
            key={row.bookmarkId}
            row={row}
            lists={lists}
            isBusy={busyIds.has(row.bookmarkId)}
            onAccept={(listId) => resolveOne(row.bookmarkId, "accept", listId === row.listId ? undefined : listId)}
            onReject={() => resolveOne(row.bookmarkId, "reject")}
          />
        ))}
      </VStack>
    </VStack>
  );
}

function ReviewRowItem({
  row,
  lists,
  isBusy,
  onAccept,
  onReject,
}: {
  row: ReviewRow;
  lists: BookmarkList[];
  isBusy: boolean;
  onAccept(listId: string): void;
  onReject(): void;
}) {
  const { t } = useI18n();
  const [targetListId, setTargetListId] = useState(row.listId);
  const options = useMemo(
    () => (lists.some((list) => list.id === row.listId) ? lists : [...lists, { id: row.listId, name: row.listName } as BookmarkList]).map((list) => ({
      value: list.id,
      label: list.name,
    })),
    [lists, row.listId, row.listName],
  );

  // Two tiers rather than an Item with endContent: four controls in the end
  // slot left the post itself a few pixels wide on a phone ("V.."). The text
  // gets the full row, the controls wrap underneath it.
  return (
    <VStack as="li" gap={1} paddingBlock={2}>
      <Text>{row.title}</Text>
      {row.author ? (
        <Text type="supporting" color="secondary">
          {row.author}
        </Text>
      ) : null}
      <HStack gap={2} align="center" wrap="wrap">
        <Token label={reviewConfidenceLabel(t, row.confidence)} size="sm" />
        <Selector
          label={t("dashboard.organize.review.moveTo")}
          isLabelHidden
          size="sm"
          variant="ghost"
          options={options}
          value={targetListId}
          onChange={(value) => setTargetListId(value as string)}
          isDisabled={isBusy}
        />
        <IconButton
          label={t("dashboard.organize.review.accept")}
          icon={<Icon icon="check" />}
          variant="ghost"
          size="sm"
          isDisabled={isBusy}
          onClick={() => onAccept(targetListId)}
        />
        <IconButton
          label={t("dashboard.organize.review.reject")}
          icon={<Icon icon="close" />}
          variant="ghost"
          size="sm"
          isDisabled={isBusy}
          onClick={onReject}
        />
      </HStack>
    </VStack>
  );
}
