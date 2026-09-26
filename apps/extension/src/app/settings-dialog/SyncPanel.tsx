import { useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import type { CloudStatus } from "../../../lib/cloud-sync";
import { useI18n, type MessageKey } from "../../i18n";
import { useNookHost, type ExtensionLinkStatus, type NookHost } from "../host/NookHost";
import { useCloudStatus } from "../host/useCloudStatus";
import { SettingsCard, SettingsRow } from "./settings-shared";

type SyncStateId = "synced" | "syncing" | "offline" | "error" | "local";

const SYNC_META: Record<SyncStateId, { labelKey: MessageKey; variant: StatusDotVariant }> = {
  synced: { labelKey: "settings.sync.stateSynced", variant: "success" },
  syncing: { labelKey: "settings.sync.stateSyncing", variant: "accent" },
  offline: { labelKey: "settings.sync.stateOffline", variant: "warning" },
  error: { labelKey: "settings.sync.stateError", variant: "error" },
  local: { labelKey: "settings.sync.stateLocal", variant: "neutral" },
};

function syncStateOf(status: CloudStatus): SyncStateId {
  if (!status.signedIn) return "local";
  if (status.syncing) return "syncing";
  if (status.offline) return "offline";
  if (status.lastError) return "error";
  return "synced";
}

export function SyncPanel() {
  const host = useNookHost();
  const toast = useToast();
  const status = useCloudStatus();
  const { t } = useI18n();
  const [isSyncing, setIsSyncing] = useState(false);

  const requestSync = async () => {
    setIsSyncing(true);
    try {
      await host.sync.requestSync();
      toast({ body: t("settings.sync.syncRequestedToast") });
    } catch (error) {
      console.error("[Nook] Failed to request sync:", error);
      toast({ body: t("settings.sync.syncRequestError"), type: "error" });
    } finally {
      setIsSyncing(false);
    }
  };

  // Extension, local-only mode: there's no cloud status to show yet — offer
  // the one thing that would change that.
  if (host.kind === "extension" && host.user === null) {
    return (
      <VStack gap={4}>
        <Banner
          status="info"
          title={t("settings.sync.signInBannerTitle")}
          description={t("settings.sync.signInBannerDescription")}
          endContent={
            <Button
              label={t("settings.sync.signIn")}
              variant="primary"
              size="sm"
              onClick={() => host.openWebApp?.("/?connect=extension")}
            />
          }
        />
      </VStack>
    );
  }

  if (!status) {
    return (
      <VStack padding={4}>
        <Text color="secondary">{t("settings.sync.checkingStatus")}</Text>
      </VStack>
    );
  }

  const state = syncStateOf(status);
  const meta = SYNC_META[state];
  const label = t(meta.labelKey);
  const description =
    state === "offline" && status.pendingCount > 0
      ? t("settings.sync.pendingChangesDescription", { count: status.pendingCount })
      : state === "error"
        ? status.lastError
        : undefined;

  return (
    <VStack gap={4}>
      <SettingsCard title={t("settings.sync.statusSectionTitle")}>
        <SettingsRow
          title={label}
          description={description}
          control={
            <HStack gap={2} align="center">
              <StatusDot variant={meta.variant} label={label} isPulsing={state === "syncing"} />
              <Button
                label={t("settings.sync.syncNow")}
                variant="secondary"
                size="sm"
                isLoading={isSyncing || state === "syncing"}
                onClick={() => void requestSync()}
              />
            </HStack>
          }
        />
        <SettingsRow
          title={t("settings.sync.lastSyncedLabel")}
          control={
            <Text color="secondary">
              {status.lastSyncedAt ? (
                <Timestamp value={status.lastSyncedAt} format="relative" isLive />
              ) : (
                t("settings.sync.never")
              )}
            </Text>
          }
        />
        <SettingsRow title={t("settings.sync.pendingChangesLabel")} control={<Badge label={status.pendingCount} />} />
      </SettingsCard>

      {status.rejected.length > 0 ? (
        <SettingsCard title={t("settings.sync.rejectedSectionTitle")}>
          <List hasDividers density="compact">
            {status.rejected.map((item) => (
              <ListItem
                key={item.kind + ":" + item.id}
                label={item.title || t("settings.sync.untitledItem")}
                description={item.error}
              />
            ))}
          </List>
        </SettingsCard>
      ) : null}

      {host.kind === "web" && host.extensionLink ? <ExtensionLinkCard link={host.extensionLink} /> : null}
    </VStack>
  );
}

const EXTENSION_LINK_META: Record<
  ExtensionLinkStatus,
  { variant: StatusDotVariant; labelKey: MessageKey; descriptionKey?: MessageKey; showConnect?: boolean }
> = {
  checking: { variant: "neutral", labelKey: "settings.sync.extensionChecking" },
  "not-installed": {
    variant: "neutral",
    labelKey: "settings.sync.extensionNotInstalled",
    descriptionKey: "settings.sync.extensionNotInstalledDescription",
  },
  connected: { variant: "success", labelKey: "settings.sync.extensionConnected" },
  "signed-out": {
    variant: "warning",
    labelKey: "settings.sync.extensionSignedOut",
    descriptionKey: "settings.sync.extensionSignedOutDescription",
    showConnect: true,
  },
  "other-account": {
    variant: "warning",
    labelKey: "settings.sync.extensionOtherAccount",
    descriptionKey: "settings.sync.extensionOtherAccountDescription",
    showConnect: true,
  },
  unavailable: {
    variant: "neutral",
    labelKey: "settings.sync.extensionUnavailable",
    descriptionKey: "settings.sync.extensionUnavailableDescription",
  },
};

function ExtensionLinkCard({ link }: { link: NonNullable<NookHost["extensionLink"]> }) {
  const toast = useToast();
  const { t } = useI18n();
  const [isConnecting, setIsConnecting] = useState(false);
  const info = EXTENSION_LINK_META[link.status];
  const label = t(info.labelKey);

  const connect = async () => {
    setIsConnecting(true);
    try {
      await link.connect({ replaceExisting: link.status === "other-account" });
      toast({ body: t("settings.sync.extensionConnectedToast") });
    } catch (error) {
      console.error("[Nook] Failed to connect the browser extension:", error);
      toast({ body: t("settings.sync.extensionConnectError"), type: "error" });
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <SettingsCard title={t("settings.sync.extensionSectionTitle")}>
      <SettingsRow
        title={label}
        description={info.descriptionKey ? t(info.descriptionKey) : undefined}
        control={
          <HStack gap={2} align="center">
            <StatusDot variant={info.variant} label={label} />
            {info.showConnect ? (
              <Button
                label={t("settings.sync.connect")}
                variant="secondary"
                size="sm"
                isLoading={isConnecting}
                onClick={() => void connect()}
              />
            ) : null}
          </HStack>
        }
      />
    </SettingsCard>
  );
}
