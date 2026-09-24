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
import { useNookHost, type ExtensionLinkStatus, type NookHost } from "../host/NookHost";
import { useCloudStatus } from "../host/useCloudStatus";
import { SettingsCard, SettingsRow } from "./settings-shared";

type SyncStateId = "synced" | "syncing" | "offline" | "error" | "local";

const SYNC_META: Record<SyncStateId, { label: string; variant: StatusDotVariant }> = {
  synced: { label: "Synced", variant: "success" },
  syncing: { label: "Syncing…", variant: "accent" },
  offline: { label: "Offline", variant: "warning" },
  error: { label: "Sync error", variant: "error" },
  local: { label: "Local only", variant: "neutral" },
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
  const [isSyncing, setIsSyncing] = useState(false);

  const requestSync = async () => {
    setIsSyncing(true);
    try {
      await host.sync.requestSync();
      toast({ body: "Sync requested." });
    } catch (error) {
      console.error("[Nook] Failed to request sync:", error);
      toast({ body: "Could not start a sync.", type: "error" });
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
          title="Sign in to sync across devices"
          description="Connect Nook to your account from the web app to sync your library everywhere."
          endContent={
            <Button label="Sign in" variant="primary" size="sm" onClick={() => host.openWebApp?.("/?connect=extension")} />
          }
        />
      </VStack>
    );
  }

  if (!status) {
    return (
      <VStack padding={4}>
        <Text color="secondary">Checking sync status…</Text>
      </VStack>
    );
  }

  const state = syncStateOf(status);
  const meta = SYNC_META[state];
  const description =
    state === "offline" && status.pendingCount > 0
      ? status.pendingCount === 1
        ? "1 change waiting to sync."
        : `${status.pendingCount} changes waiting to sync.`
      : state === "error"
        ? status.lastError
        : undefined;

  return (
    <VStack gap={4}>
      <SettingsCard title="Status">
        <SettingsRow
          title={meta.label}
          description={description}
          control={
            <HStack gap={2} align="center">
              <StatusDot variant={meta.variant} label={meta.label} isPulsing={state === "syncing"} />
              <Button
                label="Sync now"
                variant="secondary"
                size="sm"
                isLoading={isSyncing || state === "syncing"}
                onClick={() => void requestSync()}
              />
            </HStack>
          }
        />
        <SettingsRow
          title="Last synced"
          control={
            <Text color="secondary">
              {status.lastSyncedAt ? <Timestamp value={status.lastSyncedAt} format="relative" isLive /> : "Never"}
            </Text>
          }
        />
        <SettingsRow title="Pending changes" control={<Badge label={status.pendingCount} />} />
      </SettingsCard>

      {status.rejected.length > 0 ? (
        <SettingsCard title="Couldn't upload">
          <List hasDividers density="compact">
            {status.rejected.map((item) => (
              <ListItem key={item.kind + ":" + item.id} label={item.title || "Untitled"} description={item.error} />
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
  { variant: StatusDotVariant; label: string; description?: string; showConnect?: boolean }
> = {
  checking: { variant: "neutral", label: "Checking…" },
  "not-installed": {
    variant: "neutral",
    label: "Not installed",
    description: "Install the Nook browser extension to save from any page.",
  },
  connected: { variant: "success", label: "Connected" },
  "signed-out": {
    variant: "warning",
    label: "Signed out",
    description: "The browser extension is installed but not connected to this account.",
    showConnect: true,
  },
  "other-account": {
    variant: "warning",
    label: "Different account",
    description: "The browser extension is connected to a different account.",
    showConnect: true,
  },
  unavailable: { variant: "neutral", label: "Unavailable", description: "Extension status isn't available right now." },
};

function ExtensionLinkCard({ link }: { link: NonNullable<NookHost["extensionLink"]> }) {
  const toast = useToast();
  const [isConnecting, setIsConnecting] = useState(false);
  const info = EXTENSION_LINK_META[link.status];

  const connect = async () => {
    setIsConnecting(true);
    try {
      await link.connect({ replaceExisting: link.status === "other-account" });
      toast({ body: "Browser extension connected." });
    } catch (error) {
      console.error("[Nook] Failed to connect the browser extension:", error);
      toast({ body: "Could not connect the browser extension.", type: "error" });
    } finally {
      setIsConnecting(false);
    }
  };

  return (
    <SettingsCard title="Browser extension">
      <SettingsRow
        title={info.label}
        description={info.description}
        control={
          <HStack gap={2} align="center">
            <StatusDot variant={info.variant} label={info.label} />
            {info.showConnect ? (
              <Button label="Connect" variant="secondary" size="sm" isLoading={isConnecting} onClick={() => void connect()} />
            ) : null}
          </HStack>
        }
      />
    </SettingsCard>
  );
}
