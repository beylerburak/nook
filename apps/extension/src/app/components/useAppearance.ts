import { useCallback, useEffect, useState } from "react";
import type { ThemeMode } from "@astryxdesign/core/theme";
import { loadAppearance, readCachedAppearance, saveAppearance, subscribeToAppearance } from "../../../lib/appearance";

/** The shared Nook appearance preference, kept in sync across dashboard, popup and in-page toast. */
export function useAppearance(initialMode: ThemeMode = readCachedAppearance()) {
  const [mode, setMode] = useState<ThemeMode>(initialMode);

  useEffect(() => {
    let isActive = true;
    loadAppearance()
      .then((storedMode) => {
        if (isActive) setMode(storedMode);
      })
      .catch((error) => console.warn("[Nook] Could not load appearance:", error));
    const unsubscribe = subscribeToAppearance(setMode);
    return () => {
      isActive = false;
      unsubscribe();
    };
  }, []);

  const updateMode = useCallback((nextMode: ThemeMode) => {
    setMode(nextMode);
    saveAppearance(nextMode).catch((error) => console.warn("[Nook] Could not save appearance:", error));
  }, []);

  return { mode, setMode: updateMode };
}
