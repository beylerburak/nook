import { useEffect, useRef, useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { useI18n } from "../../i18n";
import { useAutoDismiss } from "./useAutoDismiss";

const AUTO_DISMISS_MS = 5000;
const AFTER_NOTE_SAVED_MS = 2000;

type Phase = "idle" | "editing" | "saved";

interface BookmarkSavedToastProps {
  message: string;
  onSaveNote: (note: string) => Promise<void>;
  onDismiss: () => void;
}

/**
 * Compact "saved" pill: message, "Add a note" and close. Closes itself unless the
 * user is hovering, focused inside it, or writing a note.
 */
export function BookmarkSavedToast({ message, onSaveNote, onDismiss }: BookmarkSavedToastProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>("idle");
  const [note, setNote] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState("");
  const [isHovered, setIsHovered] = useState(false);
  const [hasFocus, setHasFocus] = useState(false);
  const rootRef = useRef<HTMLElement>(null);

  // Read focus from the DOM rather than trusting blur events: when the focused
  // textarea unmounts (Cancel / Save), the browser moves focus away without a blur.
  const syncFocus = () => setHasFocus(rootRef.current?.matches(":focus-within") ?? false);
  useEffect(syncFocus, [phase]);

  useAutoDismiss({
    delay: phase === "saved" ? AFTER_NOTE_SAVED_MS : AUTO_DISMISS_MS,
    isPaused: phase === "editing" || isSaving || isHovered || hasFocus,
    onDismiss,
  });

  const saveNote = async () => {
    const trimmedNote = note.trim();
    if (!trimmedNote) return;
    setIsSaving(true);
    setError("");
    try {
      await onSaveNote(trimmedNote);
      setPhase("saved");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("dashboard.savedToast.couldNotSaveNote"));
    } finally {
      setIsSaving(false);
    }
  };

  const text = phase === "saved" ? t("dashboard.savedToast.noteSaved") : message.replace(/^Nook:\s*/, "");

  return (
    <VStack
      gap={2}
      width="100%"
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      ref={rootRef}
      onFocus={syncFocus}
      onBlur={() => queueMicrotask(syncFocus)}
    >
      <HStack gap={2} align="center">
        <StackItem size="fill">
          <Text type="body" maxLines={1}>{text}</Text>
        </StackItem>
        {phase === "idle" ? (
          <Button label={t("dashboard.savedToast.addANote")} variant="ghost" size="sm" onClick={() => setPhase("editing")} />
        ) : null}
        <IconButton
          label={t("common.close")}
          variant="ghost"
          size="sm"
          icon={<Icon icon="close" size="sm" color="inherit" />}
          onClick={onDismiss}
        />
      </HStack>

      {phase === "editing" ? (
        <VStack gap={2}>
          <TextArea
            label={t("dashboard.savedToast.noteLabel")}
            isLabelHidden
            hasAutoFocus
            rows={2}
            width="100%"
            placeholder={t("dashboard.savedToast.notePlaceholder")}
            value={note}
            onChange={(value) => {
              setNote(value);
              setError("");
            }}
            isDisabled={isSaving}
            status={error ? { type: "error", message: error } : undefined}
          />
          <HStack gap={2} justify="end">
            <Button
              label={t("common.cancel")}
              variant="ghost"
              size="sm"
              isDisabled={isSaving}
              onClick={() => {
                setPhase("idle");
                setError("");
              }}
            />
            <Button
              label={t("dashboard.shared.saveNote")}
              variant="primary"
              size="sm"
              isLoading={isSaving}
              isDisabled={!note.trim()}
              onClick={() => void saveNote()}
            />
          </HStack>
        </VStack>
      ) : null}
    </VStack>
  );
}
