import { useState } from "react";
import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { MetadataList, MetadataListItem } from "@astryxdesign/core/MetadataList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import { useI18n } from "../../i18n";
import { useNookHost } from "../host/NookHost";
import { SettingsCard, SettingsRow } from "./settings-shared";

/**
 * Only rendered when `host.user` is set — the dialog hides this section in
 * local-only mode (extension, signed out). Web always gets the editable
 * form; a signed-in extension shows the cached profile read-only, since
 * `host.account` only exists on the web host.
 */
export function ProfilePanel() {
  const host = useNookHost();
  const toast = useToast();
  const { t } = useI18n();
  const user = host.user;
  const [name, setName] = useState(user?.name ?? "");
  const [isSaving, setIsSaving] = useState(false);

  if (!user) return null;

  const isEditable = Boolean(host.account);
  const trimmedName = name.trim();
  const isDirty = isEditable && trimmedName.length > 0 && trimmedName !== user.name;

  const saveName = async () => {
    if (!host.account || !isDirty) return;
    setIsSaving(true);
    try {
      await host.account.updateProfile({ name: trimmedName });
      toast({ body: t("settings.profile.updatedToast") });
    } catch (error) {
      console.error("[Nook] Failed to update profile:", error);
      toast({ body: t("settings.profile.updateError"), type: "error" });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <VStack gap={4}>
      <SettingsCard>
        <HStack padding={4} gap={3} align="center">
          <Avatar name={user.name} src={user.image ?? undefined} size="lg" />
          <VStack gap={0.5}>
            <Text type="label">{user.name}</Text>
            <Text type="supporting" color="secondary">
              {user.email}
            </Text>
          </VStack>
        </HStack>
      </SettingsCard>

      <SettingsCard title={t("settings.profile.basicsTitle")}>
        <SettingsRow
          title={t("settings.profile.nameLabel")}
          description={isEditable ? t("settings.profile.nameShownDescription") : undefined}
          control={
            isEditable ? (
              <HStack gap={2}>
                <TextInput
                  label={t("settings.profile.nameLabel")}
                  isLabelHidden
                  value={name}
                  onChange={setName}
                  onEnter={() => void saveName()}
                  width={200}
                />
                <Button
                  label={t("common.save")}
                  variant="secondary"
                  size="sm"
                  isLoading={isSaving}
                  isDisabled={!isDirty}
                  onClick={() => void saveName()}
                />
              </HStack>
            ) : (
              <Text color="secondary">{user.name}</Text>
            )
          }
        />
        <SettingsRow
          title={t("settings.profile.emailLabel")}
          description={t("settings.profile.emailReadOnlyDescription")}
          control={<Text color="secondary">{user.email}</Text>}
        />
      </SettingsCard>

      {user.createdAt ? (
        <MetadataList title={t("settings.profile.detailsTitle")}>
          <MetadataListItem label={t("settings.profile.memberSinceLabel")}>
            <Timestamp value={user.createdAt} format="date" />
          </MetadataListItem>
        </MetadataList>
      ) : null}

      {!isEditable && host.openWebApp ? (
        <HStack justify="end">
          <Button label={t("settings.profile.manageOnWeb")} variant="secondary" onClick={() => host.openWebApp?.("/")} />
        </HStack>
      ) : null}
    </VStack>
  );
}
