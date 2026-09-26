import { useEffect, useState } from "react";
import { useImperativeAlertDialog } from "@astryxdesign/core/AlertDialog";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Icon } from "@astryxdesign/core/Icon";
import { IconButton } from "@astryxdesign/core/IconButton";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Switch } from "@astryxdesign/core/Switch";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { Timestamp } from "@astryxdesign/core/Timestamp";
import { useToast } from "@astryxdesign/core/Toast";
import { Token } from "@astryxdesign/core/Token";
import { useI18n } from "../../i18n";
import {
  describeSession,
  isPublicIpAddress,
  sessionTitle,
  type SessionDeviceType,
} from "./describe-session";
import { useNookHost, type NookSessionInfo } from "../host/NookHost";
import { useCloudStatus } from "../host/useCloudStatus";
import { DesktopGlyph, MobileGlyph, TabletGlyph } from "./glyphs";
import { SettingsCard } from "./settings-shared";

function deviceGlyph(device: SessionDeviceType) {
  switch (device) {
    case "mobile":
      return MobileGlyph;
    case "tablet":
      return TabletGlyph;
    default:
      return DesktopGlyph;
  }
}

/** Current device first, then most recently active. */
function sortSessions(sessions: NookSessionInfo[]): NookSessionInfo[] {
  return [...sessions].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    const aTime = new Date(a.updatedAt ?? a.createdAt).getTime();
    const bTime = new Date(b.updatedAt ?? b.createdAt).getTime();
    return bTime - aTime;
  });
}

/** Only rendered when `host.account` is set (web, signed in). */
export function AccountPanel() {
  const host = useNookHost();
  const toast = useToast();
  const cloudStatus = useCloudStatus();
  const { t, locale } = useI18n();
  const account = host.account;

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [revokeOtherSessions, setRevokeOtherSessions] = useState(false);
  const [isChangingPassword, setIsChangingPassword] = useState(false);

  const [sessions, setSessions] = useState<NookSessionInfo[] | null>(null);
  const [isLoadingSessions, setIsLoadingSessions] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
  const [isRevokingOthers, setIsRevokingOthers] = useState(false);
  const [isSigningOut, setIsSigningOut] = useState(false);

  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [isDeleting, setIsDeleting] = useState(false);

  const signOutAlert = useImperativeAlertDialog();
  const revokeOthersAlert = useImperativeAlertDialog();
  const revokeSessionAlert = useImperativeAlertDialog();

  useEffect(() => {
    if (!account) return;
    let isActive = true;
    setIsLoadingSessions(true);
    setSessionsError(null);
    account
      .listSessions()
      .then((list) => {
        if (isActive) setSessions(list);
      })
      .catch((error) => {
        console.error("[Nook] Failed to load sessions:", error);
        if (isActive) {
          setSessionsError(t("settings.account.loadSessionsError"));
          toast({ body: t("settings.account.loadSessionsError"), type: "error" });
        }
      })
      .finally(() => {
        if (isActive) setIsLoadingSessions(false);
      });
    return () => {
      isActive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  if (!account) return null;

  const canChangePassword =
    currentPassword.length > 0 && newPassword.length >= 8 && newPassword === confirmPassword;

  const changePassword = async () => {
    if (!canChangePassword) return;
    setIsChangingPassword(true);
    try {
      await account.changePassword({ currentPassword, newPassword, revokeOtherSessions });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      toast({ body: t("settings.account.passwordUpdatedToast") });
      if (revokeOtherSessions) {
        setRevokeOtherSessions(false);
        setSessions(await account.listSessions());
      }
    } catch (error) {
      console.error("[Nook] Failed to change password:", error);
      toast({ body: t("settings.account.passwordUpdateError"), type: "error" });
    } finally {
      setIsChangingPassword(false);
    }
  };

  const revokeSession = async (token: string) => {
    setRevokingToken(token);
    try {
      await account.revokeSession(token);
      setSessions((current) => current?.filter((session) => session.token !== token) ?? current);
      toast({ body: t("settings.account.sessionSignedOutToast") });
    } catch (error) {
      console.error("[Nook] Failed to revoke session:", error);
      toast({ body: t("settings.account.sessionSignOutError"), type: "error" });
    } finally {
      setRevokingToken(null);
    }
  };

  const confirmRevokeSession = (session: NookSessionInfo, title: string) => {
    revokeSessionAlert.show({
      title: t("settings.account.signOutSessionConfirmTitle"),
      description: t("settings.account.signOutSessionConfirmDescription", { title }),
      actionLabel: t("settings.account.signOut"),
      onAction: () => void revokeSession(session.token),
    });
  };

  const revokeOtherSessionsNow = async () => {
    setIsRevokingOthers(true);
    try {
      await account.revokeOtherSessions();
      setSessions(await account.listSessions());
      toast({ body: t("settings.account.otherSessionsSignedOutToast") });
    } catch (error) {
      console.error("[Nook] Failed to sign out other sessions:", error);
      toast({ body: t("settings.account.otherSessionsSignOutError"), type: "error" });
    } finally {
      setIsRevokingOthers(false);
    }
  };

  const signOutNow = async () => {
    setIsSigningOut(true);
    try {
      await account.signOut();
    } catch (error) {
      console.error("[Nook] Failed to sign out:", error);
      toast({ body: t("settings.account.signOutError"), type: "error" });
      setIsSigningOut(false);
    }
  };

  const handleSignOut = () => {
    const pending = cloudStatus?.pendingCount ?? 0;
    if (pending > 0) {
      signOutAlert.show({
        title: t("settings.account.signOutConfirmTitle"),
        description: t("settings.account.unsyncedChangesWarning", { count: pending }),
        actionLabel: t("settings.account.signOutAnyway"),
        onAction: () => void signOutNow(),
      });
      return;
    }
    void signOutNow();
  };

  const deleteAccount = async () => {
    if (!deletePassword) return;
    setIsDeleting(true);
    try {
      await account.deleteAccount({ password: deletePassword });
    } catch (error) {
      console.error("[Nook] Failed to delete account:", error);
      toast({ body: t("settings.account.deleteAccountError"), type: "error" });
      setIsDeleting(false);
    }
  };

  const otherSessionCount = (sessions ?? []).filter((session) => !session.current).length;

  return (
    <VStack gap={4}>
      <SettingsCard title={t("settings.account.passwordSectionTitle")}>
        <VStack padding={4} gap={3}>
          <TextInput
            label={t("settings.account.currentPasswordLabel")}
            type="password"
            value={currentPassword}
            onChange={setCurrentPassword}
          />
          <TextInput
            label={t("settings.account.newPasswordLabel")}
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            description={t("settings.account.newPasswordHint")}
          />
          <TextInput
            label={t("settings.account.confirmPasswordLabel")}
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            status={
              confirmPassword.length > 0 && confirmPassword !== newPassword
                ? { type: "error", message: t("settings.account.passwordMismatch") }
                : undefined
            }
          />
          <Switch
            label={t("settings.account.signOutOtherSessions")}
            description={t("settings.account.signOutOtherSessionsHint")}
            value={revokeOtherSessions}
            onChange={setRevokeOtherSessions}
          />
          <HStack justify="end">
            <Button
              label={t("settings.account.updatePasswordButton")}
              variant="primary"
              isLoading={isChangingPassword}
              isDisabled={!canChangePassword}
              onClick={() => void changePassword()}
            />
          </HStack>
        </VStack>
      </SettingsCard>

      <VStack gap={1.5}>
        <HStack justify="between" align="center">
          <Text type="supporting" weight="semibold" color="secondary">
            {t("settings.account.activeSessionsTitle")}
          </Text>
          {otherSessionCount > 0 ? (
            <Button
              label={t("settings.account.signOutOtherSessions")}
              variant="ghost"
              size="sm"
              isLoading={isRevokingOthers}
              onClick={() =>
                revokeOthersAlert.show({
                  title: t("settings.account.signOutOtherSessionsConfirmTitle"),
                  description: t("settings.account.signOutOtherSessionsConfirmDescription"),
                  actionLabel: t("settings.account.signOutOtherSessions"),
                  onAction: () => void revokeOtherSessionsNow(),
                })
              }
            />
          ) : null}
        </HStack>
        <SettingsCard>
          {isLoadingSessions && !sessions ? (
            <VStack padding={4}>
              <Text color="secondary">{t("settings.account.loadingSessions")}</Text>
            </VStack>
          ) : sessionsError ? (
            <VStack padding={4}>
              <Text color="secondary">{sessionsError}</Text>
            </VStack>
          ) : (sessions ?? []).length === 0 ? (
            <VStack padding={4}>
              <Text color="secondary">{t("settings.account.noSessionsFound")}</Text>
            </VStack>
          ) : (
            <List hasDividers density="compact">
              {sortSessions(sessions ?? []).map((session) => {
                const info = describeSession(session.userAgent);
                const title = sessionTitle(info, locale);
                const publicIp = isPublicIpAddress(session.ipAddress) ? session.ipAddress : null;
                const lastActive = session.updatedAt ?? session.createdAt;
                return (
                  <ListItem
                    key={session.token}
                    label={title}
                    startContent={<Icon icon={deviceGlyph(info.device)} size="sm" color="secondary" />}
                    description={
                      <VStack gap={0.5}>
                        <Text type="supporting" color="secondary">
                          {t("settings.account.activeLabel")}{" "}
                          <Timestamp value={lastActive} format="relative" type="inherit" color="inherit" />
                          {publicIp ? ` · ${publicIp}` : ""}
                        </Text>
                        <Text type="supporting" color="disabled">
                          {t("settings.account.signedInLabel")}{" "}
                          <Timestamp value={session.createdAt} format="date" type="inherit" color="inherit" />
                        </Text>
                      </VStack>
                    }
                    endContent={
                      session.current ? (
                        <Token label={t("settings.account.thisDeviceLabel")} size="sm" />
                      ) : (
                        <IconButton
                          label={t("settings.account.signOutSessionAria", { title })}
                          icon={<Icon icon="close" size="sm" />}
                          variant="ghost"
                          size="sm"
                          tooltip={t("settings.account.signOut")}
                          isLoading={revokingToken === session.token}
                          onClick={() => confirmRevokeSession(session, title)}
                        />
                      )
                    }
                  />
                );
              })}
            </List>
          )}
        </SettingsCard>
      </VStack>

      <SettingsCard>
        <HStack padding={4} justify="between" align="center">
          <VStack gap={0.5}>
            <Text type="label">{t("settings.account.signOut")}</Text>
            <Text type="supporting" color="secondary">
              {t("settings.account.signOutOfNookDescription")}
            </Text>
          </VStack>
          <Button label={t("settings.account.signOut")} variant="secondary" isLoading={isSigningOut} onClick={handleSignOut} />
        </HStack>
      </SettingsCard>

      <SettingsCard title={t("settings.account.dangerZoneTitle")}>
        <HStack padding={4} justify="between" align="center">
          <VStack gap={0.5}>
            <Text type="label">{t("settings.account.deleteAccount")}</Text>
            <Text type="supporting" color="secondary">
              {t("settings.account.deleteAccountDescription")}
            </Text>
          </VStack>
          <Button label={t("settings.account.deleteAccount")} variant="destructive" onClick={() => setIsDeleteOpen(true)} />
        </HStack>
      </SettingsCard>

      <Dialog isOpen={isDeleteOpen} onOpenChange={setIsDeleteOpen} purpose="form" width="min(28rem, 100vw)">
        <VStack gap={4} padding={5}>
          <DialogHeader
            title={t("settings.account.deleteAccountConfirmTitle")}
            subtitle={t("settings.account.deleteAccountConfirmSubtitle")}
            onOpenChange={setIsDeleteOpen}
          />
          <TextInput
            label={t("settings.account.passwordLabel")}
            type="password"
            value={deletePassword}
            onChange={setDeletePassword}
            onEnter={() => void deleteAccount()}
          />
          <HStack justify="end" gap={2}>
            <Button label={t("common.cancel")} variant="ghost" onClick={() => setIsDeleteOpen(false)} />
            <Button
              label={t("settings.account.deleteAccount")}
              variant="destructive"
              isLoading={isDeleting}
              isDisabled={!deletePassword}
              onClick={() => void deleteAccount()}
            />
          </HStack>
        </VStack>
      </Dialog>

      {signOutAlert.element}
      {revokeOthersAlert.element}
      {revokeSessionAlert.element}
    </VStack>
  );
}
