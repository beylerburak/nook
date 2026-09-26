import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/Layout";
import { StatusDot, type StatusDotVariant } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useI18n, type I18nContextValue } from "../../i18n";
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
function describeCloudStatus(t: I18nContextValue["t"], status: CloudStatus | null): StatusDescription {
  if (!status || !status.signedIn) return { label: t("popup.sync.notSignedIn"), variant: "neutral" };
  if (status.syncing) return { label: t("popup.sync.syncing"), variant: "accent" };
  if (status.offline) {
    return { label: t("popup.sync.offlineWaiting", { count: status.pendingCount }), variant: "warning" };
  }
  if (status.lastError) return { label: t("popup.sync.error"), variant: "error" };
  return { label: t("popup.sync.synced"), variant: "success" };
}

/** Compact sync status row for the popup — a StatusDot + label, plus "Sign in to sync" when signed out. */
export function SyncStatusLine({ status, onConnect }: SyncStatusLineProps) {
  const { t } = useI18n();
  const { label, variant } = describeCloudStatus(t, status);
  const signedIn = Boolean(status?.signedIn);

  return (
    <HStack justify="between" align="center" gap={2}>
      <HStack align="center" gap={2}>
        <StatusDot variant={variant} label={label} isPulsing={status?.syncing ?? false} />
        <Text type="supporting" color="secondary">{label}</Text>
      </HStack>
      {!signedIn && <Button label={t("popup.sync.signInButton")} size="sm" variant="ghost" onClick={onConnect} />}
    </HStack>
  );
}
