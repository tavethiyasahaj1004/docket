"use client";

import { useLayoutEffect } from "react";
import { ALL_THEME_VARS } from "@/lib/theme-vars";

// Agent pages write theme colors inline on <html>, and those survive the soft
// navigation out of the portal, so logout would carry them onto this page, which
// must show the default palette. A beforeInteractive <Script> can't fix it —
// that only runs on a full load. useLayoutEffect runs per mount, pre-paint.
export function ThemeResetScript() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const key of ALL_THEME_VARS) {
      root.style.removeProperty(key);
    }
    root.classList.remove("dark");
  }, []);

  return null;
}
