import { useState } from "react";
import { useImperativeAlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { FileInput } from "@astryxdesign/core/FileInput";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { SettingsCard, type SettingsLibrary } from "./settings-shared";

export function DataPanel({ library }: { library: SettingsLibrary }) {
  const toast = useToast();
  const [file, setFile] = useState<File | null>(null);
  const clearAlert = useImperativeAlertDialog();

  const runImport = async (nextFile: File | null) => {
    setFile(nextFile);
    if (!nextFile) return;
    const success = await library.importBookmarks(nextFile);
    if (success) {
      toast({ body: "Bookmarks imported." });
      setFile(null);
    } else {
      toast({ body: "Could not import that file.", type: "error" });
    }
  };

  const runExport = () => {
    library.exportBookmarks();
    toast({ body: "Bookmarks exported." });
  };

  const runClear = async () => {
    const success = await library.clearAllBookmarks();
    if (success) toast({ body: "Bookmarks cleared." });
    else toast({ body: "Could not clear your library.", type: "error" });
  };

  return (
    <VStack gap={4}>
      <MetadataList title="Library">
        <MetadataListItem label="Bookmarks">{library.bookmarkCount}</MetadataListItem>
        <MetadataListItem label="Collections">{library.collectionCount}</MetadataListItem>
      </MetadataList>

      <SettingsCard title="Import & export">
        <VStack padding={4} gap={3}>
          <FileInput
            label="Import bookmarks"
            accept=".json,application/json"
            value={file}
            onChange={(value) => void runImport(Array.isArray(value) ? value[0] || null : value)}
            description="A Nook JSON export."
            isLoading={library.isImporting}
          />
          <HStack justify="end">
            <Button label="Export as JSON" variant="secondary" onClick={runExport} />
          </HStack>
        </VStack>
      </SettingsCard>

      <SettingsCard title="Danger zone">
        <HStack padding={4} justify="between" align="center">
          <VStack gap={0.5}>
            <Text type="label">Clear all bookmarks</Text>
            <Text type="supporting" color="secondary">
              Moves every saved item to the deleted state. Collections stay.
            </Text>
          </VStack>
          <Button
            label="Clear all"
            variant="destructive"
            onClick={() =>
              clearAlert.show({
                title: "Clear all bookmarks?",
                description: "Saved items will be moved to the deleted state. Collections will remain.",
                actionLabel: "Clear all",
                onAction: () => void runClear(),
              })
            }
          />
        </HStack>
      </SettingsCard>

      {clearAlert.element}
    </VStack>
  );
}
