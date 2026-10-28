"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";

interface Props {
  enabled: boolean;
  onChange: (enabled: boolean) => void;
}

export function EmailSendingSettingsForm({ enabled, onChange }: Props) {
  const [saving, setSaving] = useState(false);

  async function toggle() {
    const next = !enabled;
    onChange(next);
    setSaving(true);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ticketEmailNotificationsEnabled: next }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        onChange(!next);
        toast.error(data.error ?? "Failed to save.");
        return;
      }
      toast.success("Email sending settings saved.");
    } catch {
      onChange(!next);
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-base-content">Sending</h3>
        <p className="text-xs text-base-content-muted mt-0.5">
          Control whether Docket emails customers directly, or whether your own
          backend handles it via outbound webhooks.
        </p>
      </div>
      <div className="rounded-lg border border-base-300">
        <div className="flex items-center justify-between gap-4 p-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-base-content">
              Docket sends email
            </p>
            <p className="text-xs text-base-content-muted mt-0.5">
              Send ticket notification emails (created, replied, closed, status
              changed) to customers using the templates below. Turn this off if
              you'd rather send these yourself from your backend using the
              matching outbound webhook events — agent/admin sign-in and invite
              emails are unaffected either way. Their templates lock for editing
              while this is off, since they won't be sent.
            </p>
          </div>
          <Switch
            checked={enabled}
            disabled={saving}
            onCheckedChange={toggle}
          />
        </div>
      </div>
    </div>
  );
}
