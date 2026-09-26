import { Avatar } from "@astryxdesign/core/Avatar";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Skeleton } from "@astryxdesign/core/Skeleton";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../i18n";
import type { ActivePageState, PageUnsavableReason } from "../../../lib/types";
import type { ActivePagePhase } from "./useActivePage";

export interface PageCardProps {
  state: ActivePageState | null;
  phase: ActivePagePhase;
  errorMessage: string | null;
  isSaving: boolean;
  isRemoving: boolean;
  /** The registered shortcut for the "save-page" command, e.g. "Ctrl+Shift+S", or null when unset. */
  saveShortcut: string | null;
  onSave: () => void;
  onRemove: () => void;
  onRetry: () => void;
  onOpenInDashboard: (bookmarkId: string) => void;
}

function unsavableMessage(t: ReturnType<typeof useI18n>["t"], reason: PageUnsavableReason): string {
  if (reason === "restricted") return t("popup.page.restrictedMessage");
  return t("popup.page.noPageMessage");
}

/** The compact loading placeholder, matching the shape of the loaded card. */
function PageCardSkeleton() {
  return (
    <Card padding={3}>
      <HStack gap={3} align="center">
        <Skeleton width={36} height={36} radius="rounded" />
        <VStack gap={2} width="100%">
          <Skeleton width="70%" height={14} />
          <Skeleton width="40%" height={12} />
        </VStack>
      </HStack>
    </Card>
  );
}

/**
 * The current-page control at the top of the popup: what's open in this
 * tab, whether it's already in Nook, and the primary save/remove action.
 * One component owns every state from the spec (loading, error, unsavable,
 * not-saved, saved) so the card's shape stays stable instead of the popup
 * assembling different layouts per state.
 */
export function PageCard({
  state,
  phase,
  errorMessage,
  isSaving,
  isRemoving,
  saveShortcut,
  onSave,
  onRemove,
  onRetry,
  onOpenInDashboard,
}: PageCardProps) {
  const { t } = useI18n();

  if (phase === "loading" || !state) {
    return <PageCardSkeleton />;
  }

  if (phase === "error") {
    return (
      <Card padding={3} variant="muted">
        <VStack gap={3}>
          <Text color="secondary">{errorMessage || t("popup.page.loadError")}</Text>
          <Button label={t("popup.page.retry")} size="sm" variant="secondary" onClick={onRetry} />
        </VStack>
      </Card>
    );
  }

  if (state.kind === "unsavable") {
    const message = unsavableMessage(t, state.reason);
    return (
      <Card padding={3}>
        <VStack gap={3}>
          <HStack gap={3} align="center">
            <Avatar name="Nook" size="sm" shape="rounded" tooltip={false} />
            <VStack gap={0}>
              <Text weight="semibold">{t("popup.page.unsavableTitle")}</Text>
              <Text type="supporting" color="secondary">{message}</Text>
            </VStack>
          </HStack>
          <Button label={t("popup.page.saveButton")} variant="primary" width="100%" isDisabled tooltip={message} />
        </VStack>
      </Card>
    );
  }

  const { title, hostname, favIconUrl, isXPost, bookmark } = state;
  const isSaved = Boolean(bookmark);
  const saveTooltip = saveShortcut ? t("popup.page.saveWithShortcut", { shortcut: saveShortcut }) : undefined;

  return (
    <Card padding={3}>
      <VStack gap={3}>
        <HStack gap={3} align="start">
          <Avatar src={favIconUrl} name={hostname} size="sm" shape="rounded" tooltip={false} />
          <VStack gap={0} width="100%">
            <Text weight="semibold" maxLines={2}>{title}</Text>
            <Text type="supporting" color="secondary" maxLines={1}>{hostname}</Text>
          </VStack>
        </HStack>

        {isSaved ? (
          <HStack justify="between" align="center" gap={2}>
            <HStack gap={2} align="center">
              <StatusDot variant="success" label={t("popup.page.savedBadge")} />
              <Text type="supporting" weight="semibold">{t("popup.page.savedToNook")}</Text>
            </HStack>
            <HStack gap={1} align="center">
              <IconButton
                label={t("popup.page.openInNook")}
                variant="ghost"
                size="sm"
                icon={<Icon icon="externalLink" size="sm" />}
                tooltip={t("popup.page.openInNook")}
                onClick={() => onOpenInDashboard(bookmark!.id)}
              />
              <Button label={t("popup.page.remove")} size="sm" variant="ghost" isLoading={isRemoving} onClick={onRemove} />
            </HStack>
          </HStack>
        ) : (
          <VStack gap={1}>
            <Button
              label={t("popup.page.saveButton")}
              variant="primary"
              width="100%"
              isLoading={isSaving}
              onClick={onSave}
              tooltip={saveTooltip}
            />
            {isXPost ? (
              <Text type="supporting" color="secondary">{t("popup.page.savedAsPostHint")}</Text>
            ) : null}
          </VStack>
        )}
      </VStack>
    </Card>
  );
}
