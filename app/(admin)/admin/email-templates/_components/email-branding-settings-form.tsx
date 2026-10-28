"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const DEFAULT_ACCENT = "#384959";
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

interface Props {
  initialAccentColor: string | null;
}

export function EmailBrandingSettingsForm({ initialAccentColor }: Props) {
  const [accentColor, setAccentColor] = useState(
    initialAccentColor ?? DEFAULT_ACCENT
  );
  const [saved, setSaved] = useState(initialAccentColor ?? DEFAULT_ACCENT);
  const [saving, setSaving] = useState(false);

  const isValid = HEX_COLOR_RE.test(accentColor);
  const isDirty = accentColor !== saved;

  async function save(next: string | null) {
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emailAccentColor: next }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        emailAccentColor?: string | null;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error ?? "Failed to save.");
        return;
      }
      const resolved = data.emailAccentColor ?? DEFAULT_ACCENT;
      setAccentColor(resolved);
      setSaved(resolved);
      toast.success("Email accent color saved.");
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-5 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-base-content">
          Email accent color
        </h3>
        <p className="text-xs text-base-content-muted mt-0.5">
          Used for buttons and links in every outgoing email — set it to match
          your brand website. Body text stays a fixed dark neutral for
          readability.
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-base-content-muted">
            Color
          </Label>
          <div className="flex items-center gap-2">
            <input
              aria-label="Email accent color"
              className="size-11 shrink-0 cursor-pointer rounded-md border border-base-300 bg-transparent p-1"
              disabled={saving}
              onChange={(e) => setAccentColor(e.target.value)}
              type="color"
              value={isValid ? accentColor : DEFAULT_ACCENT}
            />
            <Input
              className="w-32 rounded-md font-mono text-xs uppercase"
              disabled={saving}
              maxLength={7}
              onChange={(e) => setAccentColor(e.target.value)}
              placeholder={DEFAULT_ACCENT}
              value={accentColor}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs font-medium text-base-content-muted">
            Preview
          </Label>
          <div
            className="rounded-md px-4 py-2.5 text-sm font-bold text-white"
            style={{ backgroundColor: isValid ? accentColor : DEFAULT_ACCENT }}
          >
            View Ticket &amp; Reply
          </div>
        </div>

        <div className="flex gap-2">
          <Button
            className="bg-primary hover:bg-primary/90 text-primary-content rounded-md"
            disabled={saving || !isValid || !isDirty}
            onClick={() => save(accentColor)}
            size="sm"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
          {saved !== DEFAULT_ACCENT && (
            <Button
              className="border-base-300 text-base-content hover:bg-base-300 rounded-md"
              disabled={saving}
              onClick={() => save(null)}
              size="sm"
              variant="outline"
            >
              Reset to Default
            </Button>
          )}
        </div>
      </div>

      {!isValid && (
        <p className="text-xs text-error">
          Enter a 6-digit hex color, e.g. #384959.
        </p>
      )}
    </div>
  );
}
