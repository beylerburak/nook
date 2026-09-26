import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useI18n } from "../../i18n";

export interface PopupFooterProps {
  onSearch: (query: string) => void;
  onSync: () => void;
  isSyncing: boolean;
  onOpenDashboard: () => void;
  /** The registered shortcut for the "save-page" command, shown only when set. */
  saveShortcut: string | null;
}

/** Search-your-Nook box plus the secondary actions (sync, open dashboard). */
export function PopupFooter({ onSearch, onSync, isSyncing, onOpenDashboard, saveShortcut }: PopupFooterProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");

  const submitSearch = () => {
    if (!query.trim()) return;
    onSearch(query);
  };

  return (
    <VStack gap={2}>
      <TextInput
        label={t("popup.footer.searchLabel")}
        isLabelHidden
        size="sm"
        startIcon="search"
        placeholder={t("popup.footer.searchPlaceholder")}
        value={query}
        onChange={setQuery}
        onEnter={submitSearch}
        hasClear
      />
      <HStack justify="between" align="center" gap={2} wrap="wrap">
        <HStack gap={2}>
          <Button label={t("popup.footer.syncButton")} size="sm" variant="secondary" isLoading={isSyncing} onClick={onSync} />
          <Button label={t("popup.footer.openDashboard")} size="sm" variant="ghost" onClick={onOpenDashboard} />
        </HStack>
        {saveShortcut ? (
          <Text type="supporting" color="secondary">{t("popup.footer.saveShortcutHint", { shortcut: saveShortcut })}</Text>
        ) : null}
      </HStack>
    </VStack>
  );
}
