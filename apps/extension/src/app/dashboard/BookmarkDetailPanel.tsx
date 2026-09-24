import { Button } from "@astryxdesign/core/Button";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Heading, Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { Token } from "@astryxdesign/core/Token";
import { MediaThumbnail } from "../components/MediaThumbnail";
import { allItemMedia, itemTitle, visibleText } from "./bookmark-utils";
import type { Bookmark, BookmarkList, Media } from "../../../lib/types";

export interface BookmarkDetailPanelProps {
  item: Bookmark;
  lists: BookmarkList[];
  /** Tag frequency across the whole library, used to suggest tags not yet on this item. */
  tagCounts: [string, number][];
  noteDraft: string;
  onNoteDraftChange: (value: string) => void;
  tagDraft: string;
  onTagDraftChange: (value: string) => void;
  onClose: () => void;
  onSavePatch: (patch: Partial<Bookmark>) => Promise<boolean>;
  onUpdateTags: (nextTags: string[]) => Promise<boolean>;
  /** Saves the current note draft and reports success (e.g. via a toast). */
  onSaveNote: () => void;
  onDelete: (item: Bookmark) => void;
  onOpenUrl: (url: string) => void;
  onCopyUrl: (url: string) => void;
  onMedia: (media: Media, item: Bookmark) => void;
}

/** The end-of-page inspector for the selected bookmark: preview, note, tags and collection. */
export function BookmarkDetailPanel({
  item,
  lists,
  tagCounts,
  noteDraft,
  onNoteDraftChange,
  tagDraft,
  onTagDraftChange,
  onClose,
  onSavePatch,
  onUpdateTags,
  onSaveNote,
  onDelete,
  onOpenUrl,
  onCopyUrl,
  onMedia,
}: BookmarkDetailPanelProps) {
  const addDraftTag = () => {
    const tag = tagDraft.trim().replace(/^#/, "");
    if (!tag) return;
    void onUpdateTags([...(item.tags || []), tag]).then((success) => {
      if (success) onTagDraftChange("");
    });
  };

  return (
    <VStack gap={4}>
      <HStack justify="between" align="start" gap={2}>
        <VStack gap={1}>
          <Heading level={3}>{itemTitle(item)}</Heading>
          {item.creator?.handle ? (
            <Text type="supporting" color="secondary">@{item.creator.handle}</Text>
          ) : item.url ? (
            <Text type="supporting" color="secondary" textWrap="pretty">{item.url}</Text>
          ) : null}
        </VStack>
        <Button
          label="Close details"
          variant="ghost"
          size="sm"
          isIconOnly
          icon={<Icon icon="close" size="sm" />}
          onClick={onClose}
        />
      </HStack>

      <VStack gap={4}>
        {visibleText(item) ? <Text type="body" textWrap="pretty">{visibleText(item)}</Text> : null}
        {item.quote?.text ? (
          <Section variant="muted" padding={4}>
            <VStack gap={2}>
              <Text type="supporting" weight="semibold">
                {item.quote.creator?.name || item.quote.creator?.handle || "Quoted post"}
              </Text>
              <Text type="body">{item.quote.text}</Text>
            </VStack>
          </Section>
        ) : null}
        {allItemMedia(item).length > 0 ? (
          <Grid columns={{ minWidth: 96, repeat: "fit" }} gap={2}>
            {allItemMedia(item).map((media, index) => (
              <MediaThumbnail
                key={media.url + "-" + index}
                mediaType={media.type}
                src={media.url}
                alt={media.alt || itemTitle(item) + " media " + (index + 1)}
                label={media.alt || "Media " + (index + 1)}
                onClick={() => onMedia(media, item)}
              />
            ))}
          </Grid>
        ) : null}
        <TextArea
          label="Personal note"
          value={noteDraft}
          onChange={onNoteDraftChange}
          placeholder="Add a thought or reminder…"
          rows={3}
        />
        <HStack gap={2} align="end" wrap="wrap">
          <TextInput
            label="Add a tag"
            value={tagDraft}
            onChange={onTagDraftChange}
            placeholder="e.g. inspiration"
            onEnter={addDraftTag}
          />
          <Button label="Add tag" variant="secondary" onClick={addDraftTag} />
        </HStack>
        <HStack gap={2} wrap="wrap">
          {(item.tags || []).map((tag) => (
            <Button
              key={tag}
              label={"Remove #" + tag}
              variant="ghost"
              size="sm"
              onClick={() => void onUpdateTags((item.tags || []).filter((value) => value !== tag))}
            />
          ))}
        </HStack>
        {tagCounts.some(([tag]) => !(item.tags || []).some(
          (existing) => existing.toLowerCase().replace(/^#/, "") === tag,
        )) ? (
          <VStack gap={2}>
            <Text type="supporting" color="secondary">Suggested tags</Text>
            <HStack gap={2} wrap="wrap">
              {tagCounts
                .filter(([tag]) => !(item.tags || []).some(
                  (existing) => existing.toLowerCase().replace(/^#/, "") === tag,
                ))
                .slice(0, 8)
                .map(([tag]) => (
                  <Button
                    key={tag}
                    label={"+" + tag}
                    variant="ghost"
                    size="sm"
                    onClick={() => void onUpdateTags([...(item.tags || []), tag])}
                  />
                ))}
            </HStack>
          </VStack>
        ) : null}
        <Selector
          label="Collection"
          options={[
            { value: "", label: "Unorganized" },
            ...lists.map((list) => ({
              value: list.id,
              label: (list.icon || list.emoji || "📁") + " " + list.name,
            })),
          ]}
          value={item.listId || ""}
          onChange={(value) => {
            const target = lists.find((list) => list.id === value);
            void onSavePatch({ listId: value || null, listName: target?.name || null });
          }}
        />
        <HStack gap={2} wrap="wrap">
          {item.savedAt ? <Timestamp value={item.savedAt} format="auto" /> : null}
          {item.category ? <Token label={item.category} size="sm" /> : null}
        </HStack>
      </VStack>

      <VStack gap={2}>
        <HStack gap={2} wrap="wrap">
          {item.url ? (
            <Button
              label={item.source === "chrome" ? "Open page" : "Open on X"}
              variant="secondary"
              icon={<Icon icon="externalLink" size="sm" />}
              onClick={() => onOpenUrl(item.url!)}
            />
          ) : null}
          <Button
            label="Copy URL"
            variant="ghost"
            icon={<Icon icon="copy" size="sm" />}
            onClick={() => {
              if (item.url) onCopyUrl(item.url);
            }}
            isDisabled={!item.url}
          />
        </HStack>
        <HStack justify="between" gap={2}>
          <Button label="Delete" variant="ghost" onClick={() => onDelete(item)} />
          <Button label="Save note" variant="primary" onClick={onSaveNote} />
        </HStack>
      </VStack>
    </VStack>
  );
}
