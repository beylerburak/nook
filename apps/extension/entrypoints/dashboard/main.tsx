import { createRoot } from "react-dom/client";
import { useEffect, useMemo, useState } from "react";
import { NookHostProvider } from "../../src/app/host/NookHost";
import { createExtensionHost } from "../../src/app/popup/extension-host";
import { buildWebDashboardRedirectUrl } from "../../src/app/popup/dashboardLinks";
import { DashboardApp } from "../../src/app/dashboard/DashboardApp";
import { cloudApiUrl, cloudSession, subscribeCloudStatus, type CloudUserProfile } from "../../lib/cloud-sync";
import "../../src/app/styles.css";

/**
 * The web app is the product once signed in (product contract §2): when
 * this device is linked to a cloud account and the browser is online, the
 * extension's own dashboard page hands off to the web app instead of
 * rendering its local copy, preserving whichever of ?q=/?id= it was opened
 * with. `?local=1` forces the local dashboard (e.g. for troubleshooting
 * sync) even while signed in and online.
 */
async function shouldRedirectToWebApp(): Promise<boolean> {
  const params = new URLSearchParams(location.search);
  if (params.get("local") === "1") return false;
  if (!navigator.onLine) return false;
  const session = await cloudSession().catch(() => null);
  return Boolean(session);
}

function ExtensionDashboardRoot() {
  const [user, setUser] = useState<CloudUserProfile | null>(null);

  // `cloudStatus().user` is the cached profile and stays populated after
  // sign-out (only the token is cleared) — gate on `signedIn` too, or the
  // local dashboard would show a signed-out user as still signed in.
  useEffect(
    () => subscribeCloudStatus((status) => setUser(status.signedIn ? status.user ?? null : null)),
    [],
  );

  const host = useMemo(() => createExtensionHost(user), [user]);

  return (
    <NookHostProvider host={host}>
      <DashboardApp />
    </NookHostProvider>
  );
}

async function boot() {
  if (await shouldRedirectToWebApp()) {
    location.replace(buildWebDashboardRedirectUrl(cloudApiUrl(), location.search));
    return;
  }

  const root = document.getElementById("app-root");
  if (!root) throw new Error("Nook dashboard root is missing");
  createRoot(root).render(<ExtensionDashboardRoot />);
}

void boot();
