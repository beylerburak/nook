import { useEffect, useState } from "react";
import { subscribeCloudStatus, type CloudStatus } from "../../../lib/cloud-sync";

/**
 * The live sync status, shared by the Settings → Sync panel and anywhere
 * else that shows a sync indicator. `subscribeCloudStatus` calls its
 * listener immediately with the current status and again whenever it may
 * have changed, so no separate initial fetch is needed — `null` is only the
 * instant before that first call lands.
 */
export function useCloudStatus(): CloudStatus | null {
  const [status, setStatus] = useState<CloudStatus | null>(null);

  useEffect(() => subscribeCloudStatus(setStatus), []);

  return status;
}
