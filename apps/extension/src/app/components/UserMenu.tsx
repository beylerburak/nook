import { useState, type SVGProps } from "react";
import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Avatar } from "@astryxdesign/core/Avatar";
import { DropdownMenu, DropdownMenuDivider, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { HStack, VStack } from "@astryxdesign/core/Layout";
import { Text } from "@astryxdesign/core/Text";
import { useI18n } from "../../i18n";
import { useNookHost } from "../host/NookHost";
import { useCloudStatus } from "../host/useCloudStatus";

// Small inline glyphs, matching the pattern in dashboard/glyphs.tsx — these
// two actions have no semantic Icon name (see `astryx docs icons`).
function ProfileGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <circle cx="12" cy="8.25" r="3.25" />
      <path d="M5 20c1.4-4.1 4.2-6.25 7-6.25s5.6 2.15 7 6.25" />
    </svg>
  );
}

function SignOutGlyph(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
      <path d="M14.5 4.75H8.75A1.75 1.75 0 0 0 7 6.5v11A1.75 1.75 0 0 0 8.75 19.25h5.75" />
      <path d="M11.5 12h9.25m0 0-3.25-3.25M20.75 12l-3.25 3.25" />
    </svg>
  );
}

export interface UserMenuProps {
  onOpenProfile: () => void;
  onOpenSettings: () => void;
}

/**
 * Top-nav account menu. Header shows name/email when known (an interactive
 * avatar link would need one; this is a static block, so no accessible-name
 * warning applies). Profile and Settings always open the Settings dialog;
 * the third action depends on the host: web signs out (confirming first if
 * changes are still pending upload), a signed-out extension offers to
 * connect to the web app, and a signed-in extension links out to it.
 */
export function UserMenu({ onOpenProfile, onOpenSettings }: UserMenuProps) {
  const host = useNookHost();
  const status = useCloudStatus();
  const { t } = useI18n();
  const [isSignOutConfirmOpen, setIsSignOutConfirmOpen] = useState(false);

  const name = host.user?.name;
  const email = host.user?.email;
  const avatarName = name || email || undefined;
  const pendingCount = status?.pendingCount ?? 0;

  const signOut = () => {
    void host.account?.signOut();
  };

  const requestSignOut = () => {
    if (pendingCount > 0) setIsSignOutConfirmOpen(true);
    else signOut();
  };

  return (
    <>
      <DropdownMenu
        button={{
          label: name || email || t("dashboard.userMenu.accountFallback"),
          variant: "ghost",
          size: "sm",
          isIconOnly: true,
          icon: <Avatar name={avatarName} size="sm" tooltip={false} />,
        }}
        hasChevron={false}
        alignment="end"
      >
        {name || email ? (
          <>
            <HStack gap={2} align="center" padding={3}>
              <Avatar name={avatarName} size="sm" tooltip={false} />
              <VStack gap={0}>
                {name ? <Text weight="bold">{name}</Text> : null}
                {email ? <Text type="supporting" color="secondary">{email}</Text> : null}
              </VStack>
            </HStack>
            <DropdownMenuDivider />
          </>
        ) : null}
        <DropdownMenuItem icon={ProfileGlyph} label={t("dashboard.userMenu.profile")} onClick={onOpenProfile} />
        <DropdownMenuItem icon="wrench" label={t("dashboard.userMenu.settings")} onClick={onOpenSettings} />
        <DropdownMenuDivider />
        {host.kind === "web" ? (
          <DropdownMenuItem
            icon={SignOutGlyph}
            label={t("dashboard.userMenu.signOut")}
            variant="destructive"
            onClick={requestSignOut}
          />
        ) : host.user ? (
          <DropdownMenuItem
            icon="externalLink"
            label={t("dashboard.userMenu.openWebApp")}
            onClick={() => host.openWebApp?.("/")}
          />
        ) : (
          <DropdownMenuItem
            icon="externalLink"
            label={t("dashboard.userMenu.signInToSync")}
            onClick={() => host.openWebApp?.("/?connect=extension")}
          />
        )}
      </DropdownMenu>

      {host.account ? (
        <AlertDialog
          isOpen={isSignOutConfirmOpen}
          onOpenChange={setIsSignOutConfirmOpen}
          title={t("dashboard.userMenu.signOutConfirmTitle")}
          description={t("dashboard.userMenu.signOutConfirmDescription", { count: pendingCount })}
          actionLabel={t("dashboard.userMenu.signOut")}
          onAction={() => {
            setIsSignOutConfirmOpen(false);
            signOut();
          }}
        />
      ) : null}
    </>
  );
}
