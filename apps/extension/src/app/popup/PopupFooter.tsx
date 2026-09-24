import { useState } from "react";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";

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
  const [query, setQuery] = useState("");

  const submitSearch = () => {
    if (!query.trim()) return;
    onSearch(query);
  };

  return (
    <VStack gap={2}>
      <TextInput
        label="Search your Nook"
        isLabelHidden
        size="sm"
        startIcon="search"
        placeholder="Search your Nook…"
        value={query}
        onChange={setQuery}
        onEnter={submitSearch}
        hasClear
      />
      <HStack justify="between" align="center" gap={2} wrap="wrap">
        <HStack gap={2}>
          <Button label="Sync X bookmarks" size="sm" variant="secondary" isLoading={isSyncing} onClick={onSync} />
          <Button label="Open dashboard" size="sm" variant="ghost" onClick={onOpenDashboard} />
        </HStack>
        {saveShortcut ? (
          <Text type="supporting" color="secondary">Save: {saveShortcut}</Text>
        ) : null}
      </HStack>
    </VStack>
  );
}
