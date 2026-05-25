import { useLayoutEffect, useRef } from "react";
import { createStorageSlot, useColorMode } from "@docusaurus/theme-common";

const themeStorage = createStorageSlot("theme");

type ColorMode = "light" | "dark";
type SavedTheme = ColorMode | null;

function readSavedTheme(): SavedTheme {
  const stored = themeStorage.get();
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return null;
}

function readActiveTheme(): ColorMode {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

/** Force dark mode on the landing page without overwriting the user's saved theme. */
export function useHomeDarkMode(): void {
  const { setColorMode } = useColorMode();
  const savedThemeRef = useRef<SavedTheme>(null);
  const activeThemeRef = useRef<ColorMode>("light");

  useLayoutEffect(() => {
    savedThemeRef.current = readSavedTheme();
    activeThemeRef.current = readActiveTheme();

    document.documentElement.classList.add("home-force-dark");
    setColorMode("dark", { persist: false });

    return () => {
      document.documentElement.classList.remove("home-force-dark");

      const saved = savedThemeRef.current;
      const restoreMode = saved ?? activeThemeRef.current;

      if (saved !== null && themeStorage.get() !== saved) {
        themeStorage.set(saved);
      }

      setColorMode(restoreMode, { persist: false });
    };
  }, [setColorMode]);
}
