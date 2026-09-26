import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useI18n } from "../../i18n";
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
  const { t } = useI18n();
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width="min(30rem, 100vw)">
      <VStack gap={4} padding={5}>
        <DialogHeader
          title={t("dashboard.dialogs.createCollectionTitle")}
          subtitle={t("dashboard.dialogs.createCollectionSubtitle")}
          onOpenChange={onOpenChange}
        />
        <TextInput
          label={t("dashboard.dialogs.collectionNameLabel")}
          value={nameDraft}
          onChange={onNameDraftChange}
          placeholder={t("dashboard.dialogs.collectionNamePlaceholder")}
          onEnter={onCreate}
        />
        <Selector
          label={t("dashboard.dialogs.collectionIconLabel")}
          options={emojiOptions.map((option) => ({ value: option, label: option }))}
          value={emoji}
          onChange={onEmojiChange}
        />
        <HStack justify="end" gap={2}>
          <Button label={t("common.cancel")} variant="ghost" onClick={() => onOpenChange(false)} />
          <Button label={t("dashboard.dialogs.createCollection")} variant="primary" onClick={onCreate} />
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
  const { t } = useI18n();
  return (
    <Dialog isOpen={Boolean(list)} onOpenChange={onOpenChange} purpose="form" width="min(30rem, 100vw)">
      <VStack gap={4} padding={5}>
        <DialogHeader
          title={t("dashboard.dialogs.deleteCollectionTitle", {
            name: list?.name || t("dashboard.dialogs.deleteCollectionFallbackName"),
          })}
          subtitle={t("dashboard.dialogs.deleteCollectionSubtitle")}
          onOpenChange={onOpenChange}
        />
        <HStack justify="end" gap={2}>
          <Button label={t("common.cancel")} variant="ghost" onClick={() => onOpenChange(false)} />
          <Button label={t("dashboard.dialogs.deleteCollection")} variant="primary" onClick={onConfirm} />
        </HStack>
      </VStack>
    </Dialog>
  );
}
