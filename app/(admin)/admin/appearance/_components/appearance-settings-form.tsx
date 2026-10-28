"use client";

import {
  CheckIcon,
  MonitorIcon,
  MoonIcon,
  SunIcon,
} from "@phosphor-icons/react";
import * as React from "react";
import { toast } from "sonner";
import { useTheme } from "@/components/theme/theme-provider";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface ThemeOption {
  color: string;
  id: string;
  name: string;
}

const THEME_OPTIONS: ThemeOption[] = [
  { id: "default", name: "Default", color: "#384959" },
  { id: "ocean", name: "Ocean", color: "#1A4A5E" },
  { id: "forest", name: "Forest", color: "#1E4D35" },
  { id: "sunset", name: "Sunset", color: "#5E2D1A" },
  { id: "indigo", name: "Indigo", color: "#2D1E5E" },
  { id: "slate", name: "Slate", color: "#263040" },
];

const APPEARANCE_OPTIONS = [
  {
    id: "light" as const,
    label: "Light",
    description: "Clean light interface",
    icon: SunIcon,
    iconClass: "text-amber-500 bg-amber-500/10",
  },
  {
    id: "dark" as const,
    label: "Dark",
    description: "Sleek dark interface",
    icon: MoonIcon,
    iconClass: "text-indigo-400 bg-indigo-500/10",
  },
  {
    id: "auto" as const,
    label: "System",
    description: "Sync with OS preference",
    icon: MonitorIcon,
    iconClass: "text-base-content-muted bg-base-300",
  },
];

export function AppearanceSettingsForm() {
  const {
    currentTheme,
    appearanceMode,
    setTheme,
    setAppearance,
    saveThemeSettings,
    cancelThemeSettings,
    savedTheme,
    savedAppearance,
  } = useTheme();

  const [saving, setSaving] = React.useState(false);
  const hasChanges =
    currentTheme !== savedTheme || appearanceMode !== savedAppearance;

  async function handleSave() {
    setSaving(true);
    try {
      await saveThemeSettings();
      toast.success("Appearance settings saved.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save.";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    cancelThemeSettings();
    toast.info("Changes discarded.");
  }

  return (
    <div className="space-y-8 max-w-2xl">
      {/* Appearance mode */}
      <div>
        <h3 className="text-sm font-medium text-base-content mb-3">
          Appearance
        </h3>
        <div className="grid grid-cols-3 gap-3">
          {APPEARANCE_OPTIONS.map((opt) => {
            const Icon = opt.icon;
            const selected = appearanceMode === opt.id;
            return (
              <button
                className={cn(
                  "flex items-center gap-3 rounded-xl border p-4 text-left transition-all focus:outline-none cursor-pointer",
                  selected
                    ? "border-primary ring-2 ring-primary/20 bg-primary/5"
                    : "border-base-300 bg-base-100 hover:bg-base-300/60"
                )}
                key={opt.id}
                onClick={() => setAppearance(opt.id)}
                type="button"
              >
                <div className={cn("p-2 rounded-lg", opt.iconClass)}>
                  <Icon className="size-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-base-content">
                    {opt.label}
                  </p>
                  <p className="text-xs text-base-content-muted truncate">
                    {opt.description}
                  </p>
                </div>
                {selected && (
                  <CheckIcon className="size-4 text-base-content shrink-0" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Color theme */}
      <div>
        <h3 className="text-sm font-medium text-base-content mb-3">
          Color Theme
        </h3>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
          {THEME_OPTIONS.map((theme) => {
            const selected = currentTheme === theme.id;
            return (
              <button
                className={cn(
                  "flex flex-col items-center gap-2 p-4 rounded-xl border text-center transition-all focus:outline-none cursor-pointer",
                  selected
                    ? "border-primary ring-2 ring-primary/20 bg-primary/5"
                    : "border-base-300 bg-base-100 hover:bg-base-300/60"
                )}
                key={theme.id}
                onClick={() => setTheme(theme.id)}
                type="button"
              >
                <div
                  className="size-8 rounded-full flex items-center justify-center border border-black/5 shadow-sm"
                  style={{ backgroundColor: theme.color }}
                >
                  {selected && (
                    <CheckIcon className="size-4 text-white drop-shadow" />
                  )}
                </div>
                <span className="text-xs font-semibold text-base-content">
                  {theme.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Action bar */}
      <div
        className={cn(
          "flex items-center justify-end gap-3 border-t border-base-300 pt-4 transition-all duration-200",
          hasChanges ? "opacity-100" : "opacity-50 pointer-events-none"
        )}
      >
        <span className="text-xs text-base-content-muted mr-auto">
          {hasChanges ? "You have unsaved changes" : "All changes saved"}
        </span>
        <Button
          className="border-base-300 text-base-content hover:bg-base-300"
          disabled={!hasChanges || saving}
          onClick={handleCancel}
          size="sm"
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
        <Button
          className="bg-primary text-primary-content hover:bg-primary/90"
          disabled={!hasChanges || saving}
          onClick={handleSave}
          size="sm"
          type="button"
        >
          {saving ? "Saving…" : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
