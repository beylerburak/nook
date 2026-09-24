import { useEffect, useState } from "react";

/**
 * The keyboard shortcut registered for the "save-page" chrome.commands entry
 * (owned by the background/manifest side, built in parallel), or null when
 * unset/not yet registered. Read at runtime rather than hard-coded so the
 * popup always reflects whatever the user configured at chrome://extensions/shortcuts.
 */
export function useSaveShortcut(): string | null {
  const [shortcut, setShortcut] = useState<string | null>(null);

  useEffect(() => {
    let isActive = true;
    try {
      chrome.commands?.getAll?.((commands) => {
        if (!isActive) return;
        const savePageShortcut = commands.find((command) => command.name === "save-page")?.shortcut;
        setShortcut(savePageShortcut || null);
      });
    } catch (error) {
      console.warn("[Nook] Could not read registered shortcuts:", error);
    }
    return () => {
      isActive = false;
    };
  }, []);

  return shortcut;
}
