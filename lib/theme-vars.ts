// Plain (non-"use client") module so both theme-provider.tsx (client) and
// theme-reset-script.tsx (server) can import this list — a server component
// importing a data export from a "use client" module gets an opaque client
// reference instead of the real array.
export const ALL_THEME_VARS = [
  "--brand-bark",
  "--brand-sand",
  "--brand-stone",
  "--brand-cream",
  "--primary",
  "--primary-content",
  "--sidebar",
  "--sidebar-content",
  "--sidebar-primary",
  "--sidebar-primary-content",
  "--sidebar-accent",
  "--sidebar-accent-content",
  "--sidebar-border",
  "--sidebar-ring",
  "--secondary",
  "--secondary-content",
];
