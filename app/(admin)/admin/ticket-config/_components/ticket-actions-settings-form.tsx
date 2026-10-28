"use client";

import {
  ArrowsSplitIcon,
  GitMergeIcon,
  LinkSimpleIcon,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import type {
  TicketActionSettingKey,
  TicketActionSettings,
} from "@/lib/ticket-actions";

interface Props {
  initialSettings: TicketActionSettings;
}

interface SubSetting {
  description: string;
  key: TicketActionSettingKey;
  label: string;
}

const NOTIFY_LABEL = "Notify ticket owners";

const ACTIONS: Array<{
  description: string;
  enabledKey: TicketActionSettingKey;
  icon: ReactNode;
  label: string;
  subSettings: SubSetting[];
}> = [
  {
    enabledKey: "ticketMergeEnabled",
    icon: <GitMergeIcon className="size-4" />,
    label: "Merge tickets",
    description:
      "Agents can fold a duplicate ticket into another ticket from the same customer.",
    subSettings: [
      {
        key: "ticketMergeNotificationsEnabled",
        label: NOTIFY_LABEL,
        description:
          "Tell the owners of both tickets when one is merged into the other.",
      },
      {
        key: "ticketMergeCustomerEmailEnabled",
        label: "Email the customer",
        description:
          'Send the "Ticket Merged" email (editable under Email Templates) with a link to the ticket the conversation continues in.',
      },
    ],
  },
  {
    enabledKey: "ticketSplitEnabled",
    icon: <ArrowsSplitIcon className="size-4" />,
    label: "Split replies",
    description:
      'Agents can move a customer reply out into a new ticket. The customer always gets the "Ticket Created" email for it.',
    subSettings: [
      {
        key: "ticketSplitNotificationsEnabled",
        label: NOTIFY_LABEL,
        description:
          "Tell the original ticket's owner that a reply was split out. Agents are always notified about the new ticket, like any other new ticket.",
      },
    ],
  },
  {
    enabledKey: "ticketLinkEnabled",
    icon: <LinkSimpleIcon className="size-4" />,
    label: "Link tickets",
    description:
      "Agents can mark tickets as related, duplicate or blocking. When off, existing links stay visible but can't be added or removed.",
    subSettings: [
      {
        key: "ticketLinkNotificationsEnabled",
        label: NOTIFY_LABEL,
        description: "Tell the owners of both tickets when they're linked.",
      },
    ],
  },
];

export function TicketActionsSettingsForm({ initialSettings }: Props) {
  const [settings, setSettings] = useState(initialSettings);
  const [savingKey, setSavingKey] = useState<TicketActionSettingKey | null>(
    null
  );

  async function toggle(key: TicketActionSettingKey) {
    const previous = settings;
    const value = !settings[key];
    setSettings({ ...settings, [key]: value });
    setSavingKey(key);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setSettings(previous);
        toast.error(data.error ?? "Failed to save.");
        return;
      }
      toast.success("Ticket actions saved.");
    } catch {
      setSettings(previous);
      toast.error("Network error. Please try again.");
    } finally {
      setSavingKey(null);
    }
  }

  return (
    <section className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6 space-y-5">
      <div>
        <h2 className="text-base font-semibold text-base-content">
          Ticket Actions
        </h2>
        <p className="text-xs text-base-content-muted mt-0.5">
          Choose which actions agents can use on a ticket, and who hears about
          each one. The agent who does the action is never notified.
        </p>
      </div>

      <div className="divide-y divide-base-300 rounded-lg border border-base-300">
        {ACTIONS.map((action) => {
          const enabled = settings[action.enabledKey];
          return (
            <div className="space-y-3 p-4" key={action.enabledKey}>
              <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 gap-3">
                  <span className="mt-0.5 text-base-content-muted">
                    {action.icon}
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-base-content">
                      {action.label}
                    </p>
                    <p className="text-xs text-base-content-muted mt-0.5">
                      {action.description}
                    </p>
                  </div>
                </div>
                <Switch
                  aria-label={action.label}
                  checked={enabled}
                  disabled={savingKey === action.enabledKey}
                  onCheckedChange={() => toggle(action.enabledKey)}
                />
              </div>

              {/* Indented under their feature; greyed out while the feature
                  is off, since a disabled action sends nothing anyway. */}
              {action.subSettings.map((sub) => (
                <div
                  className={`ml-7 flex items-center justify-between gap-4 rounded-field bg-base-300/40 px-3 py-2.5 ${enabled ? "" : "opacity-50"}`}
                  key={sub.key}
                >
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-base-content">
                      {sub.label}
                    </p>
                    <p className="text-xs text-base-content-muted mt-0.5">
                      {sub.description}
                    </p>
                  </div>
                  <Switch
                    aria-label={`${action.label}: ${sub.label.toLowerCase()}`}
                    checked={settings[sub.key]}
                    disabled={!enabled || savingKey === sub.key}
                    onCheckedChange={() => toggle(sub.key)}
                  />
                </div>
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}
