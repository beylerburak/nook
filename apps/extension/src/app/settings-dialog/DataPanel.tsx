import { useState } from "react";
import { useImperativeAlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { FileInput } from "@astryxdesign/core/FileInput";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { useToast } from "@astryxdesign/core/Toast";
import { useI18n } from "../../i18n";
import { SettingsCard, type SettingsLibrary } from "./settings-shared";

export function DataPanel({ library }: { library: SettingsLibrary }) {
  const toast = useToast();
  const { t } = useI18n();
  const [file, setFile] = useState<File | null>(null);
  const clearAlert = useImperativeAlertDialog();

  const runImport = async (nextFile: File | null) => {
    setFile(nextFile);
    if (!nextFile) return;
    const success = await library.importBookmarks(nextFile);
    if (success) {
      toast({ body: t("settings.data.importedToast") });
      setFile(null);
    } else {
      toast({ body: t("settings.data.importError"), type: "error" });
    }
  };

  const runExport = () => {
    library.exportBookmarks();
    toast({ body: t("settings.data.exportedToast") });
  };

  const runClear = async () => {
    const success = await library.clearAllBookmarks();
    if (success) toast({ body: t("settings.data.clearedToast") });
    else toast({ body: t("settings.data.clearError"), type: "error" });
  };

  return (
    <VStack gap={4}>
      <MetadataList title={t("settings.data.libraryTitle")}>
        <MetadataListItem label={t("settings.data.bookmarksLabel")}>{library.bookmarkCount}</MetadataListItem>
        <MetadataListItem label={t("settings.data.collectionsLabel")}>{library.collectionCount}</MetadataListItem>
      </MetadataList>

      <SettingsCard title={t("settings.data.importExportTitle")}>
        <VStack padding={4} gap={3}>
          <FileInput
            label={t("settings.data.importLabel")}
            accept=".json,application/json"
            value={file}
            onChange={(value) => void runImport(Array.isArray(value) ? value[0] || null : value)}
            description={t("settings.data.importDescription")}
            isLoading={library.isImporting}
          />
          <HStack justify="end">
            <Button label={t("settings.data.exportButton")} variant="secondary" onClick={runExport} />
          </HStack>
        </VStack>
      </SettingsCard>

      <SettingsCard title={t("settings.data.dangerZoneTitle")}>
        <HStack padding={4} justify="between" align="center">
          <VStack gap={0.5}>
            <Text type="label">{t("settings.data.clearAllTitle")}</Text>
            <Text type="supporting" color="secondary">
              {t("settings.data.clearAllDescription")}
            </Text>
          </VStack>
          <Button
            label={t("settings.data.clearAllButton")}
            variant="destructive"
            onClick={() =>
              clearAlert.show({
                title: t("settings.data.clearAllConfirmTitle"),
                description: t("settings.data.clearAllConfirmDescription"),
                actionLabel: t("settings.data.clearAllButton"),
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
