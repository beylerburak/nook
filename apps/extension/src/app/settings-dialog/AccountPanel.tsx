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
          setSessionsError("Could not load active sessions.");
          toast({ body: "Could not load active sessions.", type: "error" });
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
      toast({ body: "Password updated." });
      if (revokeOtherSessions) {
        setRevokeOtherSessions(false);
        setSessions(await account.listSessions());
      }
    } catch (error) {
      console.error("[Nook] Failed to change password:", error);
      toast({ body: "Could not update your password. Check your current password.", type: "error" });
    } finally {
      setIsChangingPassword(false);
    }
  };

  const revokeSession = async (token: string) => {
    setRevokingToken(token);
    try {
      await account.revokeSession(token);
      setSessions((current) => current?.filter((session) => session.token !== token) ?? current);
      toast({ body: "Session signed out." });
    } catch (error) {
      console.error("[Nook] Failed to revoke session:", error);
      toast({ body: "Could not sign out that session.", type: "error" });
    } finally {
      setRevokingToken(null);
    }
  };

  const confirmRevokeSession = (session: NookSessionInfo, title: string) => {
    revokeSessionAlert.show({
      title: "Sign out this session?",
      description: `This will sign "${title}" out of your account.`,
      actionLabel: "Sign out",
      onAction: () => void revokeSession(session.token),
    });
  };

  const revokeOtherSessionsNow = async () => {
    setIsRevokingOthers(true);
    try {
      await account.revokeOtherSessions();
      setSessions(await account.listSessions());
      toast({ body: "Other sessions signed out." });
    } catch (error) {
      console.error("[Nook] Failed to sign out other sessions:", error);
      toast({ body: "Could not sign out other sessions.", type: "error" });
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
      toast({ body: "Could not sign out.", type: "error" });
      setIsSigningOut(false);
    }
  };

  const handleSignOut = () => {
    const pending = cloudStatus?.pendingCount ?? 0;
    if (pending > 0) {
      signOutAlert.show({
        title: "Sign out?",
        description:
          pending === 1
            ? "You have 1 change that hasn't synced yet. Signing out now may lose it on this device."
            : `You have ${pending} changes that haven't synced yet. Signing out now may lose them on this device.`,
        actionLabel: "Sign out anyway",
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
      toast({ body: "Could not delete your account. Check your password.", type: "error" });
      setIsDeleting(false);
    }
  };

  const otherSessionCount = (sessions ?? []).filter((session) => !session.current).length;

  return (
    <VStack gap={4}>
      <SettingsCard title="Password">
        <VStack padding={4} gap={3}>
          <TextInput label="Current password" type="password" value={currentPassword} onChange={setCurrentPassword} />
          <TextInput
            label="New password"
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            description="At least 8 characters."
          />
          <TextInput
            label="Confirm new password"
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            status={
              confirmPassword.length > 0 && confirmPassword !== newPassword
                ? { type: "error", message: "Passwords don't match." }
                : undefined
            }
          />
          <Switch
            label="Sign out other sessions"
            description="Everywhere else you're signed in."
            value={revokeOtherSessions}
            onChange={setRevokeOtherSessions}
          />
          <HStack justify="end">
            <Button
              label="Update password"
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
            Active sessions
          </Text>
          {otherSessionCount > 0 ? (
            <Button
              label="Sign out other sessions"
              variant="ghost"
              size="sm"
              isLoading={isRevokingOthers}
              onClick={() =>
                revokeOthersAlert.show({
                  title: "Sign out other sessions?",
                  description: "Every other device signed in to your account will be signed out.",
                  actionLabel: "Sign out other sessions",
                  onAction: () => void revokeOtherSessionsNow(),
                })
              }
            />
          ) : null}
        </HStack>
        <SettingsCard>
          {isLoadingSessions && !sessions ? (
            <VStack padding={4}>
              <Text color="secondary">Loading sessions…</Text>
            </VStack>
          ) : sessionsError ? (
            <VStack padding={4}>
              <Text color="secondary">{sessionsError}</Text>
            </VStack>
          ) : (sessions ?? []).length === 0 ? (
            <VStack padding={4}>
              <Text color="secondary">No sessions found.</Text>
            </VStack>
          ) : (
            <List hasDividers density="compact">
              {sortSessions(sessions ?? []).map((session) => {
                const info = describeSession(session.userAgent);
                const title = sessionTitle(info);
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
                          Active <Timestamp value={lastActive} format="relative" type="inherit" color="inherit" />
                          {publicIp ? ` · ${publicIp}` : ""}
                        </Text>
                        <Text type="supporting" color="disabled">
                          Signed in <Timestamp value={session.createdAt} format="date" type="inherit" color="inherit" />
                        </Text>
                      </VStack>
                    }
                    endContent={
                      session.current ? (
                        <Token label="This device" size="sm" />
                      ) : (
                        <IconButton
                          label={`Sign out "${title}"`}
                          icon={<Icon icon="close" size="sm" />}
                          variant="ghost"
                          size="sm"
                          tooltip="Sign out"
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
            <Text type="label">Sign out</Text>
            <Text type="supporting" color="secondary">
              Sign out of Nook on this device.
            </Text>
          </VStack>
          <Button label="Sign out" variant="secondary" isLoading={isSigningOut} onClick={handleSignOut} />
        </HStack>
      </SettingsCard>

      <SettingsCard title="Danger zone">
        <HStack padding={4} justify="between" align="center">
          <VStack gap={0.5}>
            <Text type="label">Delete account</Text>
            <Text type="supporting" color="secondary">
              Permanently deletes your account and everything synced to it.
            </Text>
          </VStack>
          <Button label="Delete account" variant="destructive" onClick={() => setIsDeleteOpen(true)} />
        </HStack>
      </SettingsCard>

      <Dialog isOpen={isDeleteOpen} onOpenChange={setIsDeleteOpen} purpose="form" width="min(28rem, 100vw)">
        <VStack gap={4} padding={5}>
          <DialogHeader
            title="Delete your account?"
            subtitle="This can't be undone. Enter your password to confirm."
            onOpenChange={setIsDeleteOpen}
          />
          <TextInput
            label="Password"
            type="password"
            value={deletePassword}
            onChange={setDeletePassword}
            onEnter={() => void deleteAccount()}
          />
          <HStack justify="end" gap={2}>
            <Button label="Cancel" variant="ghost" onClick={() => setIsDeleteOpen(false)} />
            <Button
              label="Delete account"
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
