"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";

export function SlaDisplayPreferencesCard({
  initialShowSlaAndOverdue,
}: {
  initialShowSlaAndOverdue: boolean;
}) {
  const [showSlaAndOverdue, setShowSlaAndOverdue] = useState(
    initialShowSlaAndOverdue
  );
  const [saving, setSaving] = useState(false);

  async function toggle() {
    const next = !showSlaAndOverdue;
    const previous = showSlaAndOverdue;
    setShowSlaAndOverdue(next);
    setSaving(true);
    try {
      const res = await fetch("/api/tickets/sla-display", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ showSlaAndOverdue: next }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        setShowSlaAndOverdue(previous);
        toast.error(data.error ?? "Failed to save.");
        return;
      }
      toast.success("Ticket list settings saved.");
    } catch {
      setShowSlaAndOverdue(previous);
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold text-base-content">
          Ticket List
        </h2>
        <p className="text-xs text-base-content-muted mt-0.5">
          Personal preferences for how the ticket list is displayed.
        </p>
      </div>
      <div className="flex items-center justify-between gap-4 rounded-lg border border-base-300 p-4">
        <div className="min-w-0">
          <p className="text-sm font-medium text-base-content">
            Show SLA & Overdue
          </p>
          <p className="text-xs text-base-content-muted mt-0.5">
            Display SLA and overdue information in the ticket list.
          </p>
        </div>
        <Switch
          checked={showSlaAndOverdue}
          disabled={saving}
          onCheckedChange={toggle}
        />
      </div>
    </div>
  );
}
