"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";

export function ReplyComposerPreferencesCard({
  initialSendReplyOnEnter,
}: {
  initialSendReplyOnEnter: boolean;
}) {
  const [sendReplyOnEnter, setSendReplyOnEnter] = useState(
    initialSendReplyOnEnter
  );
  const [saving, setSaving] = useState(false);

  async function toggle() {
    const next = !sendReplyOnEnter;
    const previous = sendReplyOnEnter;
    setSendReplyOnEnter(next);
    setSaving(true);
    try {
      const res = await fetch("/api/account/reply-preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sendReplyOnEnter: next }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setSendReplyOnEnter(previous);
        toast.error(data.error ?? "Failed to save.");
        return;
      }
      toast.success("Reply composer settings saved.");
    } catch {
      setSendReplyOnEnter(previous);
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-base-content">
          Reply Composer
        </h2>
        <p className="text-xs text-base-content-muted mt-0.5">
          Personal preferences for how you write ticket replies.
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-base-300 p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-base-content">
            Send reply on Enter
          </p>
          <p className="text-xs text-base-content-muted mt-0.5">
            Press Enter to send replies instead of creating a new line.
          </p>
        </div>
        <Switch
          checked={sendReplyOnEnter}
          disabled={saving}
          onCheckedChange={toggle}
        />
      </div>
    </div>
  );
}
