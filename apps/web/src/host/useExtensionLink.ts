import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExtensionLinkStatus } from "../../../extension/src/app/host/NookHost";
import { authClient } from "../auth/authClient";
import { connectExtension, probeExtensionLink } from "./extensionBridge";

/**
 * Tracks whether the Nook extension is installed and which account it's
 * bound to (contract section 2/3). Re-probes on mount and whenever the tab
 * becomes visible again — the extension may have been installed, signed out
 * or reconnected to another account while this tab was in the background.
 */
export function useExtensionLink(userId: string | undefined): {
  status: ExtensionLinkStatus;
  connect: (options?: { replaceExisting?: boolean }) => Promise<void>;
} {
  const [status, setStatus] = useState<ExtensionLinkStatus>("checking");
  const userIdRef = useRef(userId);
  userIdRef.current = userId;

  const probe = useCallback(async () => {
    const result = await probeExtensionLink(userIdRef.current);
    if (result.status !== "signed-out") {
      setStatus(result.status);
      return;
    }
    // The extension is installed but has no session — hand it this tab's
    // session automatically instead of leaving the user to dig through
    // Settings for a connect button.
    try {
      await connectExtension(authClient);
      setStatus("connected");
    } catch {
      setStatus("signed-out");
    }
  }, []);

  useEffect(() => {
    void probe();
    const handleVisibility = () => {
      if (document.visibilityState === "visible") void probe();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, [probe]);

  const connect = useCallback(async (options?: { replaceExisting?: boolean }) => {
    await connectExtension(authClient, options);
    setStatus("connected");
  }, []);

  // Stable identity across renders — useWebHost memoizes the NookHost it
  // builds off this return value, and a fresh object here every render would
  // defeat that memo and rebuild the host (and everything under
  // NookHostProvider) on every render.
  return useMemo(() => ({ status, connect }), [status, connect]);
}
