"use client";

import { useRouter } from "next/navigation";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTheme } from "./theme-provider";

// Appearance changes preview live (theme-provider writes them to the DOM
// immediately) but only persist on explicit Save. Without this guard,
// clicking any other nav link silently discards an unsaved preview.
export function UnsavedThemeChangesGuard() {
  const router = useRouter();
  const {
    currentTheme,
    savedTheme,
    appearanceMode,
    savedAppearance,
    saveThemeSettings,
    cancelThemeSettings,
  } = useTheme();

  const hasUnsavedChanges =
    currentTheme !== savedTheme || appearanceMode !== savedAppearance;
  const hasUnsavedChangesRef = React.useRef(hasUnsavedChanges);
  hasUnsavedChangesRef.current = hasUnsavedChanges;

  const [pendingHref, setPendingHref] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    function onClick(e: MouseEvent) {
      if (
        !hasUnsavedChangesRef.current ||
        e.defaultPrevented ||
        e.button !== 0 ||
        e.metaKey ||
        e.ctrlKey ||
        e.shiftKey ||
        e.altKey
      ) {
        return;
      }
      const target = e.target as HTMLElement | null;
      const anchor = target?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.hasAttribute("download")) {
        return;
      }
      const anchorTarget = anchor.getAttribute("target");
      if (anchorTarget && anchorTarget !== "_self") {
        return;
      }
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#")) {
        return;
      }

      let url: URL;
      try {
        url = new URL(href, window.location.href);
      } catch {
        return;
      }
      if (
        url.origin !== window.location.origin ||
        (url.pathname === window.location.pathname &&
          url.search === window.location.search)
      ) {
        return;
      }

      e.preventDefault();
      e.stopImmediatePropagation();
      setPendingHref(`${url.pathname}${url.search}${url.hash}`);
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  React.useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (!hasUnsavedChangesRef.current) {
        return;
      }
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  function handleKeepEditing() {
    setPendingHref(null);
  }

  function handleDiscard() {
    cancelThemeSettings();
    const href = pendingHref;
    setPendingHref(null);
    if (href) {
      router.push(href);
    }
  }

  async function handleSaveAndLeave() {
    setSaving(true);
    try {
      await saveThemeSettings();
      const href = pendingHref;
      setPendingHref(null);
      if (href) {
        router.push(href);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to save.";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          setPendingHref(null);
        }
      }}
      open={pendingHref !== null}
    >
      <DialogContent className="rounded-xl max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base-content">
            Unsaved Appearance Changes
          </DialogTitle>
          <DialogDescription className="text-base-content-muted">
            You changed the color theme or appearance mode but haven&apos;t
            saved. Leaving now discards the change.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex-wrap gap-2">
          <Button
            className="border-base-300 text-base-content"
            disabled={saving}
            onClick={handleKeepEditing}
            variant="outline"
          >
            Keep Editing
          </Button>
          <Button
            className="border-base-300 text-base-content"
            disabled={saving}
            onClick={handleDiscard}
            variant="outline"
          >
            Discard
          </Button>
          <Button
            className="bg-primary hover:bg-primary/90 text-primary-content"
            disabled={saving}
            onClick={handleSaveAndLeave}
          >
            {saving ? "Saving…" : "Save & Leave"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
