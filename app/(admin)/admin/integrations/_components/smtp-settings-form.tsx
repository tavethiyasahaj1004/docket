"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { IntegrationSettingsSummary } from "@/lib/integration-settings";
import { IntegrationCard } from "./integration-card";
import { SecretInput } from "./secret-input";

type Smtp = IntegrationSettingsSummary["smtp"];

interface Props {
  collapsible?: boolean;
  defaultOpen?: boolean;
  initial: Smtp;
}

export function SmtpSettingsForm({ initial, collapsible, defaultOpen }: Props) {
  const [host, setHost] = useState(initial.host);
  const [port, setPort] = useState(String(initial.port));
  const [user, setUser] = useState(initial.user);
  const [pass, setPass] = useState("");
  const [from, setFrom] = useState(initial.from);
  const [hasPassword, setHasPassword] = useState(initial.hasPassword);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [lastTestedAt, setLastTestedAt] = useState(initial.lastTestedAt);
  const [lastTestOk, setLastTestOk] = useState(initial.lastTestOk);
  const [lastTestError, setLastTestError] = useState(initial.lastTestError);

  const configured = !!(host && user && from && hasPassword);

  async function patch(body: Record<string, unknown>, successMessage: string) {
    const res = await fetch("/api/admin/integration-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ smtp: body }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      tested?: { smtp?: { message: string; ok: boolean } };
    };
    if (!res.ok) {
      toast.error(data.error ?? "Failed to save.");
      return null;
    }
    toast.success(successMessage);
    return data;
  }

  async function save() {
    setSaving(true);
    try {
      const portNum = Number.parseInt(port, 10);
      const data = await patch(
        {
          host,
          port: Number.isFinite(portNum) ? portNum : undefined,
          user,
          from,
          pass: pass || undefined,
        },
        "SMTP settings saved."
      );
      if (data) {
        if (pass) {
          setHasPassword(true);
        }
        setPass("");
        const tested = data.tested?.smtp;
        setLastTestedAt(tested ? new Date().toISOString() : null);
        setLastTestOk(tested ? tested.ok : null);
        setLastTestError(tested && !tested.ok ? tested.message : null);
        if (tested && !tested.ok) {
          toast.error(`Saved, but connection test failed: ${tested.message}`);
        }
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    setRemoving(true);
    try {
      const data = await patch(
        { host: "", port: 587, user: "", from: "", pass: "" },
        "SMTP settings removed."
      );
      if (data) {
        setHost("");
        setPort("587");
        setUser("");
        setFrom("");
        setPass("");
        setHasPassword(false);
        setLastTestedAt(null);
        setLastTestOk(null);
        setLastTestError(null);
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setRemoving(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    try {
      const portNum = Number.parseInt(port, 10);
      const res = await fetch("/api/admin/integration-settings/smtp/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host,
          port: Number.isFinite(portNum) ? portNum : undefined,
          user,
          pass: pass || undefined,
        }),
      });
      const result = (await res.json().catch(() => ({}))) as {
        message?: string;
        ok?: boolean;
      };
      const ok = res.ok && !!result.ok;
      setLastTestedAt(new Date().toISOString());
      setLastTestOk(ok);
      setLastTestError(ok ? null : (result.message ?? "Test failed."));
      if (ok) {
        toast.success(result.message ?? "Connection succeeded.");
      } else {
        toast.error(result.message ?? "Connection test failed.");
      }
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      setTesting(false);
    }
  }

  return (
    <IntegrationCard
      collapsible={collapsible}
      configured={configured}
      defaultOpen={defaultOpen}
      description="Send ticket notifications, magic links, and password resets. Without it, emails are logged instead of delivered."
      onRemove={remove}
      onSave={save}
      onTest={testConnection}
      removing={removing}
      saving={saving}
      testing={testing}
      title="Email (SMTP)"
      verification={{ lastTestedAt, lastTestOk, lastTestError }}
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="space-y-1.5 sm:col-span-2">
          <Label htmlFor="smtp-host">Host</Label>
          <Input
            disabled={saving}
            id="smtp-host"
            onChange={(e) => setHost(e.target.value)}
            placeholder="smtp.example.com"
            value={host}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="smtp-port">Port</Label>
          <Input
            disabled={saving}
            id="smtp-port"
            inputMode="numeric"
            onChange={(e) => setPort(e.target.value)}
            placeholder="587"
            value={port}
          />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="smtp-user">Username</Label>
          <Input
            disabled={saving}
            id="smtp-user"
            onChange={(e) => setUser(e.target.value)}
            value={user}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="smtp-pass">Password</Label>
          <SecretInput
            disabled={saving}
            hasSavedValue={hasPassword}
            id="smtp-pass"
            onChange={setPass}
            value={pass}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="smtp-from">From address</Label>
        <Input
          disabled={saving}
          id="smtp-from"
          onChange={(e) => setFrom(e.target.value)}
          placeholder="support@example.com"
          value={from}
        />
      </div>
    </IntegrationCard>
  );
}
