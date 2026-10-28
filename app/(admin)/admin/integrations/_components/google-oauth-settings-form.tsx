"use client";

import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { IntegrationSettingsSummary } from "@/lib/integration-settings";
import { IntegrationCard } from "./integration-card";
import { SecretInput } from "./secret-input";

type Google = IntegrationSettingsSummary["google"];

const REDIRECT_URI_TEMPLATE = "{your_domain}/api/auth/callback/google";

interface Props {
  collapsible?: boolean;
  defaultOpen?: boolean;
  initial: Google;
}

export function GoogleOAuthSettingsForm({
  initial,
  collapsible,
  defaultOpen,
}: Props) {
  const [clientId, setClientId] = useState(initial.clientId);
  const [clientSecret, setClientSecret] = useState("");
  const [hasClientSecret, setHasClientSecret] = useState(
    initial.hasClientSecret
  );
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [testing, setTesting] = useState(false);
  const [lastTestedAt, setLastTestedAt] = useState(initial.lastTestedAt);
  const [lastTestOk, setLastTestOk] = useState(initial.lastTestOk);
  const [lastTestError, setLastTestError] = useState(initial.lastTestError);

  const configured = !!(clientId && hasClientSecret);

  async function copyRedirectUri() {
    await navigator.clipboard.writeText(REDIRECT_URI_TEMPLATE);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function patch(body: Record<string, unknown>, message: string) {
    const res = await fetch("/api/admin/integration-settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ google: body }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      error?: string;
      tested?: { google?: { message: string; ok: boolean } };
    };
    if (!res.ok) {
      toast.error(data.error ?? "Failed to save.");
      return null;
    }
    toast.success(message);
    return data;
  }

  async function save() {
    setSaving(true);
    try {
      const data = await patch(
        { clientId, clientSecret: clientSecret || undefined },
        "Google sign-in settings saved."
      );
      if (data) {
        if (clientSecret) {
          setHasClientSecret(true);
        }
        setClientSecret("");
        const tested = data.tested?.google;
        setLastTestedAt(tested ? new Date().toISOString() : null);
        setLastTestOk(tested ? tested.ok : null);
        setLastTestError(tested && !tested.ok ? tested.message : null);
        if (tested && !tested.ok) {
          toast.error(`Saved, but credential check failed: ${tested.message}`);
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
        { clientId: "", clientSecret: "" },
        "Google sign-in settings removed."
      );
      if (data) {
        setClientId("");
        setClientSecret("");
        setHasClientSecret(false);
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
      const res = await fetch("/api/admin/integration-settings/google/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId,
          clientSecret: clientSecret || undefined,
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
        toast.success(result.message ?? "Credentials are valid.");
      } else {
        toast.error(result.message ?? "Credential check failed.");
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
      description='Enables the "Continue with Google" button on agent/admin sign-in.'
      note="Changes here take effect after the app restarts — this login page reads Google credentials once at server startup, not per request. In Docker: docker compose restart app."
      onRemove={remove}
      onSave={save}
      onTest={testConnection}
      removing={removing}
      saving={saving}
      testing={testing}
      title="Google Sign-in"
      verification={{ lastTestedAt, lastTestOk, lastTestError }}
    >
      <div className="space-y-1.5 mb-4">
        <Label>Authorized redirect URI</Label>
        <p className="text-xs text-base-content-muted">
          Add this URL to your Google Cloud OAuth client's "Authorized redirect
          URIs", with {"{your_domain}"} replaced by this app's URL — Google
          sign-in fails with a redirect_uri_mismatch error otherwise.
        </p>
        <div className="flex items-center gap-2 rounded-md border border-base-300 bg-base-300 px-3 py-2">
          <code className="text-xs text-base-content break-all flex-1">
            {REDIRECT_URI_TEMPLATE}
          </code>
          <button
            className="shrink-0 text-base-content-muted hover:text-base-content"
            onClick={copyRedirectUri}
            type="button"
          >
            {copied ? (
              <CheckIcon className="size-4 text-green-600" />
            ) : (
              <CopyIcon className="size-4" />
            )}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="google-client-id">Client ID</Label>
          <Input
            disabled={saving}
            id="google-client-id"
            onChange={(e) => setClientId(e.target.value)}
            value={clientId}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="google-client-secret">Client Secret</Label>
          <SecretInput
            disabled={saving}
            hasSavedValue={hasClientSecret}
            id="google-client-secret"
            onChange={setClientSecret}
            value={clientSecret}
          />
        </div>
      </div>
    </IntegrationCard>
  );
}
