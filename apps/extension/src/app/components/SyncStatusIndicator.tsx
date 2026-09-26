import { Button } from "@astryxdesign/core/Button";
import { HoverCard } from "@astryxdesign/core/HoverCard";
import { VStack } from "@astryxdesign/core/Layout";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../i18n";
import { translate } from "../../i18n/core";
import type { MessageKey, ParamsFor } from "../../i18n/types";
import { useCloudStatus } from "../host/useCloudStatus";
import type { CloudStatus } from "../../../lib/cloud-sync";

/**
 * Accepted as a parameter by `describeSyncStatus` (a plain, non-React helper
 * kept pure and unit-testable), rather than reading `useI18n()` itself. Every
 * call defaults to English (see `defaultT`) so existing callers that don't
 * pass one keep returning the same English copy they always have.
 */
type TranslateFn = <K extends MessageKey>(key: K, params?: ParamsFor<K>) => string;
const defaultT: TranslateFn = (key, params) => translate("en", key, params);
type FormatDateFn = (date: Date | number, options?: Intl.DateTimeFormatOptions) => string;
const defaultFormatDate: FormatDateFn = (date, options) => new Intl.DateTimeFormat(undefined, options).format(date);

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
export function describeSyncStatus(
  status: CloudStatus | null,
  t: TranslateFn = defaultT,
  formatDate: FormatDateFn = defaultFormatDate,
): SyncIndicatorInfo {
  if (!status || !status.signedIn) {
    return {
      label: t("dashboard.syncStatus.localOnly"),
      variant: "neutral",
      isPulsing: false,
      detail: t("dashboard.syncStatus.localOnlyDetail"),
    };
  }
  if (status.offline) {
    return {
      label: t("dashboard.syncStatus.offline", { count: status.pendingCount }),
      variant: "warning",
      isPulsing: false,
      detail: status.pendingCount
        ? t("dashboard.syncStatus.offlineDetailPending", { count: status.pendingCount })
        : t("dashboard.syncStatus.offlineDetailNone"),
    };
  }
  if (status.syncing) {
    return {
      label: t("dashboard.syncStatus.syncing"),
      variant: "accent",
      isPulsing: true,
      detail: t("dashboard.syncStatus.syncingDetail"),
    };
  }
  if (status.lastError || status.rejected.length > 0) {
    return {
      label: t("dashboard.syncStatus.syncError"),
      variant: "error",
      isPulsing: false,
      detail: status.lastError
        || t("dashboard.syncStatus.syncErrorDetail", { count: status.rejected.length }),
    };
  }
  return {
    label: t("dashboard.syncStatus.synced"),
    variant: "success",
    isPulsing: false,
    detail: status.lastSyncedAt
      ? t("dashboard.syncStatus.syncedDetailWithDate", {
          date: formatDate(new Date(status.lastSyncedAt), { dateStyle: "medium", timeStyle: "short" }),
        })
      : t("dashboard.syncStatus.syncedDetailDefault"),
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
  const { t, formatDate } = useI18n();
  const info = describeSyncStatus(status, t, formatDate);

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
