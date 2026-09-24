import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Layout";
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import type { CloudStatus } from "../../../lib/cloud-sync";

export interface SyncStatusLineProps {
  /** null while the hook hasn't reported yet, same as "not signed in" for display purposes. */
  status: CloudStatus | null;
  onConnect: () => void;
}

interface StatusDescription {
  label: string;
  variant: StatusDotVariant;
}

/** Priority: signed out, syncing, offline, last error, else synced. */
function describeCloudStatus(status: CloudStatus | null): StatusDescription {
  if (!status || !status.signedIn) return { label: "Not signed in", variant: "neutral" };
  if (status.syncing) return { label: "Syncing…", variant: "accent" };
  if (status.offline) return { label: `Offline · ${status.pendingCount} waiting`, variant: "warning" };
  if (status.lastError) return { label: "Sync error", variant: "error" };
  return { label: "Synced", variant: "success" };
}

/** Compact sync status row for the popup — a StatusDot + label, plus "Sign in to sync" when signed out. */
export function SyncStatusLine({ status, onConnect }: SyncStatusLineProps) {
  const { label, variant } = describeCloudStatus(status);
  const signedIn = Boolean(status?.signedIn);

  return (
    <HStack justify="between" align="center" gap={2}>
      <HStack align="center" gap={2}>
        <StatusDot variant={variant} label={label} isPulsing={status?.syncing ?? false} />
        <Text type="supporting" color="secondary">{label}</Text>
      </HStack>
      {!signedIn && <Button label="Sign in to sync" size="sm" variant="ghost" onClick={onConnect} />}
    </HStack>
  );
}
