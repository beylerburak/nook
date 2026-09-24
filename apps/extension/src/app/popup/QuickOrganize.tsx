import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Collapsible } from "@astryxdesign/core/Collapsible";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Token } from "@astryxdesign/core/Token";
import type { Bookmark, BookmarkList, BookmarkPatch } from "../../../lib/types";

export interface QuickOrganizeProps {
  bookmark: Bookmark;
  lists: BookmarkList[];
  /** Tag names already used elsewhere in the library, most-used first, for one-click suggestions. */
  suggestedTags: string[];
  /** Opens the disclosure by default right after a fresh save, collapsed otherwise. */
  defaultIsOpen: boolean;
  onPatch: (patch: BookmarkPatch) => Promise<boolean>;
}

/**
 * Quick-organize controls for an already-saved bookmark: note, tags and
 * collection. Collapsed behind a disclosure so the popup stays compact when
 * the user just wants to glance at save state; UPDATE_BOOKMARK is the only
 * write path, matching the popup contract in lib/types.ts.
 */
export function QuickOrganize({ bookmark, lists, suggestedTags, defaultIsOpen, onPatch }: QuickOrganizeProps) {
  const [noteDraft, setNoteDraft] = useState(bookmark.note || "");
  const [tagDraft, setTagDraft] = useState("");
  const tags = bookmark.tags || [];

  const saveNoteIfChanged = () => {
    if (noteDraft.trim() === (bookmark.note || "").trim()) return;
    void onPatch({ note: noteDraft });
  };

  const addTag = (rawTag: string) => {
    const tag = rawTag.trim().replace(/^#/, "").toLowerCase();
    if (!tag || tags.includes(tag)) {
      setTagDraft("");
      return;
    }
    void onPatch({ tags: [...tags, tag] });
    setTagDraft("");
  };

  const removeTag = (tag: string) => {
    void onPatch({ tags: tags.filter((existing) => existing !== tag) });
  };

  const unusedSuggestions = suggestedTags.filter((tag) => !tags.includes(tag)).slice(0, 6);

  return (
    <Collapsible trigger={<Text weight="semibold">Organize</Text>} defaultIsOpen={defaultIsOpen}>
      <VStack gap={3} paddingBlockStart={2}>
        <TextArea
          label="Personal note"
          isLabelHidden
          value={noteDraft}
          onChange={setNoteDraft}
          onBlur={saveNoteIfChanged}
          placeholder="Add a note…"
          rows={2}
          size="sm"
        />

        <VStack gap={2}>
          <HStack gap={2} align="end">
            <TextInput
              label="Add a tag"
              isLabelHidden
              size="sm"
              value={tagDraft}
              onChange={setTagDraft}
              placeholder="Add a tag…"
              onEnter={() => addTag(tagDraft)}
            />
            <Button
              label="Add tag"
              size="sm"
              variant="secondary"
              isDisabled={!tagDraft.trim()}
              onClick={() => addTag(tagDraft)}
            />
          </HStack>
          {tags.length > 0 || unusedSuggestions.length > 0 ? (
            <HStack gap={1} wrap="wrap">
              {tags.map((tag) => (
                <Token key={tag} label={"#" + tag} size="sm" onRemove={() => removeTag(tag)} />
              ))}
              {unusedSuggestions.map((tag) => (
                <Token key={tag} label={"+" + tag} size="sm" color="gray" onClick={() => addTag(tag)} />
              ))}
            </HStack>
          ) : null}
        </VStack>

        <Selector
          label="Collection"
          isLabelHidden
          size="sm"
          options={[
            { value: "", label: "Unorganized" },
            ...lists.map((list) => ({
              value: list.id,
              label: (list.icon || list.emoji || "📁") + " " + list.name,
            })),
          ]}
          value={bookmark.listId || ""}
          onChange={(value) => {
            const target = lists.find((list) => list.id === value);
            void onPatch({ listId: value || null, listName: target?.name || null });
          }}
        />
      </VStack>
    </Collapsible>
  );
}
