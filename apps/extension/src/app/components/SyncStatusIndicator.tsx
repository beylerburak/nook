import { Button } from "@astryxdesign/core/Button";
import { HoverCard } from "@astryxdesign/core/HoverCard";
import { VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useCloudStatus } from "../host/useCloudStatus";
import type { CloudStatus } from "../../../lib/cloud-sync";

export type SyncIndicatorVariant = "success" | "warning" | "error" | "accent" | "neutral";

export interface SyncIndicatorInfo {
  label: string;
  variant: SyncIndicatorVariant;
  isPulsing: boolean;
  detail: string;
}

/**
 * Maps a CloudStatus onto the indicator's label/variant/detail. Kept pure and
 * exported so the status → copy mapping is unit-testable without rendering.
 * Order matters: signed-out beats everything (nothing else applies), then
 * offline, then an in-progress sync, then a persistent error, then synced.
 */
export function describeSyncStatus(status: CloudStatus | null): SyncIndicatorInfo {
  if (!status || !status.signedIn) {
    return {
      label: "Local only",
      variant: "neutral",
      isPulsing: false,
      detail: "Sign in from the web app to sync your library across devices.",
    };
  }
  if (status.offline) {
    return {
      label: `Offline (${status.pendingCount} waiting)`,
      variant: "warning",
      isPulsing: false,
      detail: status.pendingCount
        ? `${status.pendingCount} change${status.pendingCount === 1 ? "" : "s"} will sync once you're back online.`
        : "You're offline. Changes will sync once you're back online.",
    };
  }
  if (status.syncing) {
    return { label: "Syncing…", variant: "accent", isPulsing: true, detail: "Syncing your library now." };
  }
  if (status.lastError || status.rejected.length > 0) {
    return {
      label: "Sync error",
      variant: "error",
      isPulsing: false,
      detail: status.lastError
        || `${status.rejected.length} item${status.rejected.length === 1 ? "" : "s"} could not be synced.`,
    };
  }
  return {
    label: "Synced",
    variant: "success",
    isPulsing: false,
    detail: status.lastSyncedAt
      ? `Last synced ${new Date(status.lastSyncedAt).toLocaleString()}.`
      : "Your library is up to date.",
  };
}

export interface SyncStatusIndicatorProps {
  onOpenSync: () => void;
}

/**
 * Compact top-nav sync status: a StatusDot + short label driven by
 * useCloudStatus(), with a HoverCard for the longer explanation. Clicking it
 * opens Settings at the Sync section, which owns retry/details.
 */
export function SyncStatusIndicator({ onOpenSync }: SyncStatusIndicatorProps) {
  const status = useCloudStatus();
  const info = describeSyncStatus(status);

  return (
    <HoverCard
      content={
        <VStack gap={1}>
          <Text weight="bold">{info.label}</Text>
          <Text type="supporting" color="secondary">{info.detail}</Text>
        </VStack>
      }
      placement="below"
      alignment="end"
    >
      <Button
        label={info.label}
        variant="ghost"
        size="sm"
        onClick={onOpenSync}
        icon={<StatusDot variant={info.variant} label={info.label} isPulsing={info.isPulsing} />}
      />
    </HoverCard>
  );
}
