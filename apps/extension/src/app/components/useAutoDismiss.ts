import { useEffect, useRef } from "react";

/**
 * Calls `onDismiss` after `delay` ms, unless paused. Pausing cancels the countdown;
 * resuming starts a fresh one, so the user always gets the full delay after they
 * stop interacting.
 */
export function useAutoDismiss({ delay, isPaused, onDismiss }: { delay: number; isPaused: boolean; onDismiss: () => void }) {
  // Kept in a ref so a new callback identity on re-render doesn't restart the countdown.
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;

  useEffect(() => {
    if (isPaused) return;
    const timeout = window.setTimeout(() => onDismissRef.current(), delay);
    return () => window.clearTimeout(timeout);
  }, [delay, isPaused]);
}
