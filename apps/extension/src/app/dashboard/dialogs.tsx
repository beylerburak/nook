import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import type { BookmarkList } from "../../../lib/types";

export interface CreateListDialogProps {
  isOpen: boolean;
  onOpenChange: (isOpen: boolean) => void;
  nameDraft: string;
  onNameDraftChange: (value: string) => void;
  emoji: string;
  onEmojiChange: (value: string) => void;
  emojiOptions: string[];
  onCreate: () => void;
}

export function CreateListDialog({
  isOpen,
  onOpenChange,
  nameDraft,
  onNameDraftChange,
  emoji,
  onEmojiChange,
  emojiOptions,
  onCreate,
}: CreateListDialogProps) {
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width="min(30rem, 100vw)">
      <VStack gap={4} padding={5}>
        <DialogHeader title="Create a collection" subtitle="Keep related bookmarks together." onOpenChange={onOpenChange} />
        <TextInput
          label="Collection name"
          value={nameDraft}
          onChange={onNameDraftChange}
          placeholder="e.g. Design references"
          onEnter={onCreate}
        />
        <Selector
          label="Collection icon"
          options={emojiOptions.map((option) => ({ value: option, label: option }))}
          value={emoji}
          onChange={onEmojiChange}
        />
        <HStack justify="end" gap={2}>
          <Button label="Cancel" variant="ghost" onClick={() => onOpenChange(false)} />
          <Button label="Create collection" variant="primary" onClick={onCreate} />
        </HStack>
      </VStack>
    </Dialog>
  );
}

export interface DeleteListDialogProps {
  list: BookmarkList | null;
  onOpenChange: (isOpen: boolean) => void;
  onConfirm: () => void;
}

export function DeleteListDialog({ list, onOpenChange, onConfirm }: DeleteListDialogProps) {
  return (
    <Dialog isOpen={Boolean(list)} onOpenChange={onOpenChange} purpose="form" width="min(30rem, 100vw)">
      <VStack gap={4} padding={5}>
        <DialogHeader
          title={"Delete " + (list?.name || "collection") + "?"}
          subtitle="Bookmarks in this collection will become unorganized."
          onOpenChange={onOpenChange}
        />
        <HStack justify="end" gap={2}>
          <Button label="Cancel" variant="ghost" onClick={() => onOpenChange(false)} />
          <Button label="Delete collection" variant="primary" onClick={onConfirm} />
        </HStack>
      </VStack>
    </Dialog>
  );
}
