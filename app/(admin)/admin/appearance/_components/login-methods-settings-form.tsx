"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";

interface Settings {
  googleLoginEnabled: boolean;
  magicLinkEnabled: boolean;
  passwordLoginEnabled: boolean;
}

interface Props {
  googleConfigured: boolean;
  initialSettings: Settings;
}

type SettingKey = keyof Settings;

export function LoginMethodsSettingsForm({
  initialSettings,
  googleConfigured,
}: Props) {
  const [settings, setSettings] = useState(initialSettings);
  const [savingKey, setSavingKey] = useState<SettingKey | null>(null);

  async function toggle(key: SettingKey) {
    const next = { ...settings, [key]: !settings[key] };
    if (
      !(
        next.passwordLoginEnabled ||
        next.magicLinkEnabled ||
        next.googleLoginEnabled
      )
    ) {
      toast.error("At least one sign-in method must stay enabled.");
      return;
    }

    const previous = settings;
    setSettings(next);
    setSavingKey(key);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: next[key] }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) {
        setSettings(previous);
        toast.error(data.error ?? "Failed to save.");
        return;
      }
      toast.success("Sign-in settings saved.");
    } catch {
      setSettings(previous);
      toast.error("Network error. Please try again.");
    } finally {
      setSavingKey(null);
    }
  }

  const rows: Array<{
    description: string;
    disabled?: boolean;
    key: SettingKey;
    label: string;
  }> = [
    {
      key: "passwordLoginEnabled",
      label: "Email & Password",
      description:
        "Sign in with an email and password — works even with no email provider configured.",
    },
    {
      key: "magicLinkEnabled",
      label: "Magic Link",
      description:
        "Sign in with a one-time link emailed to the agent. Requires SMTP to be configured.",
    },
    {
      key: "googleLoginEnabled",
      label: "Google",
      description: googleConfigured
        ? "Sign in with a Google account."
        : "Not available — add a Client ID and Secret under Integrations first.",
      disabled: !googleConfigured,
    },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-base-content">
          Sign-in Methods
        </h3>
        <p className="text-xs text-base-content-muted mt-0.5">
          Choose which methods agents and admins can use to sign in. At least
          one must stay enabled.
        </p>
      </div>
      <div className="divide-y divide-base-300 rounded-lg border border-base-300">
        {rows.map((row) => (
          <div
            className="flex items-center justify-between gap-4 p-4"
            key={row.key}
          >
            <div className="min-w-0">
              <p className="text-sm font-medium text-base-content">
                {row.label}
              </p>
              <p className="text-xs text-base-content-muted mt-0.5">
                {row.description}
              </p>
            </div>
            <Switch
              checked={settings[row.key]}
              disabled={row.disabled || savingKey === row.key}
              onCheckedChange={() => toggle(row.key)}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
