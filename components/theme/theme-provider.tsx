"use client";

import * as React from "react";
import { ALL_THEME_VARS } from "@/lib/theme-vars";

export interface ThemeContextType {
  appearanceMode: "light" | "dark" | "auto";
  cancelThemeSettings: () => void;
  currentTheme: string;
  savedAppearance: "light" | "dark" | "auto";
  savedTheme: string;
  saveThemeSettings: () => Promise<void>;
  setAppearance: (mode: "light" | "dark" | "auto") => void;
  setTheme: (theme: string) => void;
}

const ThemeContext = React.createContext<ThemeContextType | undefined>(
  undefined
);

interface ThemeProviderProps {
  children: React.ReactNode;
  initialAppearanceMode: "light" | "dark" | "auto";
  initialTheme: string;
}

type ThemeVars = Record<string, string>;

// Each preset defines brand palette vars + aligned semantic theme tokens.
// base-100/200/300 (surface/border tiers) stay neutral across every preset —
// only primary/secondary/sidebar (and the brand-* source palette) shift.
const LIGHT_THEME_VARS: Record<string, ThemeVars> = {
  default: {
    "--brand-bark": "#384959",
    "--brand-sand": "#88BDF2",
    "--brand-stone": "#6A89A7",
    "--brand-cream": "#BDDDFC",
    "--primary": "#384959",
    "--primary-content": "#ffffff",
    "--sidebar": "#384959",
    "--sidebar-content": "#BDDDFC",
    "--sidebar-primary": "#BDDDFC",
    "--sidebar-primary-content": "#384959",
    "--sidebar-accent": "rgba(189,221,252,0.12)",
    "--sidebar-accent-content": "#BDDDFC",
    "--sidebar-border": "rgba(136,189,242,0.2)",
    "--sidebar-ring": "#88BDF2",
    "--secondary": "#BDDDFC",
    "--secondary-content": "#384959",
  },
  ocean: {
    "--brand-bark": "#1A4A5E",
    "--brand-sand": "#4AADCA",
    "--brand-stone": "#5B8EA6",
    "--brand-cream": "#C2E8F5",
    "--primary": "#1A4A5E",
    "--primary-content": "#ffffff",
    "--sidebar": "#1A4A5E",
    "--sidebar-content": "#C2E8F5",
    "--sidebar-primary": "#C2E8F5",
    "--sidebar-primary-content": "#1A4A5E",
    "--sidebar-accent": "rgba(194,232,245,0.12)",
    "--sidebar-accent-content": "#C2E8F5",
    "--sidebar-border": "rgba(74,173,202,0.2)",
    "--sidebar-ring": "#4AADCA",
    "--secondary": "#C2E8F5",
    "--secondary-content": "#1A4A5E",
  },
  forest: {
    "--brand-bark": "#1E4D35",
    "--brand-sand": "#4AAD78",
    "--brand-stone": "#5B8E70",
    "--brand-cream": "#C2F0D8",
    "--primary": "#1E4D35",
    "--primary-content": "#ffffff",
    "--sidebar": "#1E4D35",
    "--sidebar-content": "#C2F0D8",
    "--sidebar-primary": "#C2F0D8",
    "--sidebar-primary-content": "#1E4D35",
    "--sidebar-accent": "rgba(194,240,216,0.12)",
    "--sidebar-accent-content": "#C2F0D8",
    "--sidebar-border": "rgba(74,173,120,0.2)",
    "--sidebar-ring": "#4AAD78",
    "--secondary": "#C2F0D8",
    "--secondary-content": "#1E4D35",
  },
  sunset: {
    "--brand-bark": "#5E2D1A",
    "--brand-sand": "#CA6B4A",
    "--brand-stone": "#A6745B",
    "--brand-cream": "#F5D5C2",
    "--primary": "#5E2D1A",
    "--primary-content": "#ffffff",
    "--sidebar": "#5E2D1A",
    "--sidebar-content": "#F5D5C2",
    "--sidebar-primary": "#F5D5C2",
    "--sidebar-primary-content": "#5E2D1A",
    "--sidebar-accent": "rgba(245,213,194,0.12)",
    "--sidebar-accent-content": "#F5D5C2",
    "--sidebar-border": "rgba(202,107,74,0.2)",
    "--sidebar-ring": "#CA6B4A",
    "--secondary": "#F5D5C2",
    "--secondary-content": "#5E2D1A",
  },
  indigo: {
    "--brand-bark": "#2D1E5E",
    "--brand-sand": "#6B4ACA",
    "--brand-stone": "#745BB8",
    "--brand-cream": "#D8C2F5",
    "--primary": "#2D1E5E",
    "--primary-content": "#ffffff",
    "--sidebar": "#2D1E5E",
    "--sidebar-content": "#D8C2F5",
    "--sidebar-primary": "#D8C2F5",
    "--sidebar-primary-content": "#2D1E5E",
    "--sidebar-accent": "rgba(216,194,245,0.12)",
    "--sidebar-accent-content": "#D8C2F5",
    "--sidebar-border": "rgba(107,74,202,0.2)",
    "--sidebar-ring": "#6B4ACA",
    "--secondary": "#D8C2F5",
    "--secondary-content": "#2D1E5E",
  },
  slate: {
    "--brand-bark": "#263040",
    "--brand-sand": "#6B85A0",
    "--brand-stone": "#7A8FA6",
    "--brand-cream": "#C8D8E8",
    "--primary": "#263040",
    "--primary-content": "#ffffff",
    "--sidebar": "#263040",
    "--sidebar-content": "#C8D8E8",
    "--sidebar-primary": "#C8D8E8",
    "--sidebar-primary-content": "#263040",
    "--sidebar-accent": "rgba(200,216,232,0.12)",
    "--sidebar-accent-content": "#C8D8E8",
    "--sidebar-border": "rgba(107,133,160,0.2)",
    "--sidebar-ring": "#6B85A0",
    "--secondary": "#C8D8E8",
    "--secondary-content": "#263040",
  },
};

// Dark mode: neutral 3-layer surfaces come from the `.dark` block in globals.css.
// Per preset we only recolor the *primary* tokens (primary/sidebar-primary) to
// the preset's brighter brand tone, so the dark UI stays neutral but on-brand.
const DARK_THEME_VARS: Record<string, ThemeVars> = {
  default: {
    "--brand-bark": "#384959",
    "--brand-sand": "#88BDF2",
    "--brand-stone": "#6A89A7",
    "--brand-cream": "#BDDDFC",
    "--primary": "#88BDF2",
    "--primary-content": "#0D0F12",
    "--sidebar-primary": "#88BDF2",
    "--sidebar-primary-content": "#0D0F12",
  },
  ocean: {
    "--brand-bark": "#1A4A5E",
    "--brand-sand": "#4AADCA",
    "--brand-stone": "#5B8EA6",
    "--brand-cream": "#C2E8F5",
    "--primary": "#4AADCA",
    "--primary-content": "#0D0F12",
    "--sidebar-primary": "#4AADCA",
    "--sidebar-primary-content": "#0D0F12",
  },
  forest: {
    "--brand-bark": "#1E4D35",
    "--brand-sand": "#4AAD78",
    "--brand-stone": "#5B8E70",
    "--brand-cream": "#C2F0D8",
    "--primary": "#4AAD78",
    "--primary-content": "#0D0F12",
    "--sidebar-primary": "#4AAD78",
    "--sidebar-primary-content": "#0D0F12",
  },
  sunset: {
    "--brand-bark": "#5E2D1A",
    "--brand-sand": "#CA6B4A",
    "--brand-stone": "#A6745B",
    "--brand-cream": "#F5D5C2",
    "--primary": "#CA6B4A",
    "--primary-content": "#0D0F12",
    "--sidebar-primary": "#CA6B4A",
    "--sidebar-primary-content": "#0D0F12",
  },
  indigo: {
    "--brand-bark": "#2D1E5E",
    "--brand-sand": "#6B4ACA",
    "--brand-stone": "#745BB8",
    "--brand-cream": "#D8C2F5",
    "--primary": "#6B4ACA",
    "--primary-content": "#F0F2F5",
    "--sidebar-primary": "#6B4ACA",
    "--sidebar-primary-content": "#F0F2F5",
  },
  slate: {
    "--brand-bark": "#263040",
    "--brand-sand": "#6B85A0",
    "--brand-stone": "#7A8FA6",
    "--brand-cream": "#C8D8E8",
    "--primary": "#6B85A0",
    "--primary-content": "#0D0F12",
    "--sidebar-primary": "#6B85A0",
    "--sidebar-primary-content": "#0D0F12",
  },
};

const LS_THEME = "docket_theme";
const LS_APPEARANCE = "docket_appearance";

export function ThemeProvider({
  children,
  initialTheme,
  initialAppearanceMode,
}: ThemeProviderProps) {
  const [savedTheme, setSavedTheme] = React.useState(initialTheme);
  const [savedAppearance, setSavedAppearance] = React.useState<
    "light" | "dark" | "auto"
  >(initialAppearanceMode);
  const [currentTheme, setCurrentThemeState] = React.useState(initialTheme);
  const [appearanceMode, setAppearanceModeState] = React.useState<
    "light" | "dark" | "auto"
  >(initialAppearanceMode);

  React.useEffect(() => {
    const localTheme = localStorage.getItem(LS_THEME);
    const localAppearance = localStorage.getItem(LS_APPEARANCE) as
      | "light"
      | "dark"
      | "auto"
      | null;
    const resolvedTheme = localTheme ?? initialTheme;
    const resolvedAppearance = localAppearance ?? initialAppearanceMode;
    setSavedTheme(resolvedTheme);
    setSavedAppearance(resolvedAppearance);
    setCurrentThemeState(resolvedTheme);
    setAppearanceModeState(resolvedAppearance);
  }, [initialTheme, initialAppearanceMode]);

  const applyThemeToDOM = React.useCallback(
    (theme: string, appearance: "light" | "dark" | "auto") => {
      if (typeof window === "undefined") {
        return;
      }
      const root = document.documentElement;

      let isDark = false;
      if (appearance === "dark") {
        isDark = true;
      } else if (appearance === "light") {
        isDark = false;
      } else {
        isDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      }

      if (isDark) {
        root.classList.add("dark");
      } else {
        root.classList.remove("dark");
      }

      for (const key of ALL_THEME_VARS) {
        root.style.removeProperty(key);
      }

      const vars = isDark
        ? (DARK_THEME_VARS[theme] ?? DARK_THEME_VARS.default)
        : (LIGHT_THEME_VARS[theme] ?? LIGHT_THEME_VARS.default);

      for (const [key, value] of Object.entries(vars)) {
        root.style.setProperty(key, value);
      }
    },
    []
  );

  React.useEffect(() => {
    applyThemeToDOM(currentTheme, appearanceMode);
    if (appearanceMode === "auto") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const handler = () => applyThemeToDOM(currentTheme, "auto");
      mq.addEventListener("change", handler);
      return () => mq.removeEventListener("change", handler);
    }
  }, [currentTheme, appearanceMode, applyThemeToDOM]);

  const setTheme = React.useCallback(
    (theme: string) => setCurrentThemeState(theme),
    []
  );
  const setAppearance = React.useCallback(
    (mode: "light" | "dark" | "auto") => setAppearanceModeState(mode),
    []
  );

  const saveThemeSettings = React.useCallback(async () => {
    const res = await fetch("/api/admin/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ theme: currentTheme, appearanceMode }),
    });
    if (!res.ok) {
      const data = (await res.json()) as { error?: string };
      throw new Error(data.error ?? "Failed to save");
    }
    setSavedTheme(currentTheme);
    setSavedAppearance(appearanceMode);
    localStorage.setItem(LS_THEME, currentTheme);
    localStorage.setItem(LS_APPEARANCE, appearanceMode);
  }, [currentTheme, appearanceMode]);

  const cancelThemeSettings = React.useCallback(() => {
    setCurrentThemeState(savedTheme);
    setAppearanceModeState(savedAppearance);
  }, [savedTheme, savedAppearance]);

  return (
    <ThemeContext.Provider
      value={{
        currentTheme,
        appearanceMode,
        setTheme,
        setAppearance,
        saveThemeSettings,
        cancelThemeSettings,
        savedTheme,
        savedAppearance,
      }}
    >
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) {
    throw new Error("useTheme must be used within ThemeProvider");
  }
  return ctx;
}
