"use client";

import { PlugsConnectedIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { BrandMark } from "@/components/common/brand-mark";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { authClient } from "@/lib/auth-client";
import { OAUTH_OFFLINE_SCOPE } from "@/lib/oauth-scopes";
import { getInitials } from "@/lib/utils";

interface ScopeOption {
  checked: boolean;
  description: string;
  id: string;
  label: string;
}

interface ConsentFormProps {
  /** Why the user can't allow (wrong role, impersonating, ...): Deny only. */
  blocked?: string | null;
  brandName: string;
  clientHost?: string | null;
  clientName?: string;
  logoUrl: string | null;
  /** The client asked to stay connected (a refresh token). */
  offline?: boolean;
  /** The request itself is unusable: no buttons at all. */
  problem?: string;
  redirectHost?: string | null;
  scopes?: ScopeOption[];
  userEmail?: string;
  userName?: string;
}

export function ConsentForm({
  blocked = null,
  brandName,
  clientHost = null,
  clientName = "",
  logoUrl,
  offline = false,
  problem,
  redirectHost = null,
  scopes = [],
  userEmail = "",
  userName = "",
}: ConsentFormProps) {
  const [selected, setSelected] = useState<Set<string>>(
    () => new Set(scopes.filter((s) => s.checked).map((s) => s.id))
  );
  const [busy, setBusy] = useState<"allow" | "deny" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function toggle(id: string, on: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (on) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  async function decide(accept: boolean) {
    setError(null);
    setBusy(accept ? "allow" : "deny");
    // Only checked permissions are granted; the server refuses anything the
    // role can't hold, whatever this page sends. The client plugin attaches the
    // signed query of this page, so the provider knows which request this is.
    const granted = scopes.filter((s) => selected.has(s.id)).map((s) => s.id);
    if (offline) {
      granted.push(OAUTH_OFFLINE_SCOPE);
    }
    const result = await authClient.oauth2.consent(
      accept ? { accept: true, scope: granted.join(" ") } : { accept: false }
    );
    if (result.error) {
      setBusy(null);
      setError(result.error.message ?? "Something went wrong. Try again.");
      return;
    }
    // The auth client normally follows { redirect, url } itself.
    const next = result.data as { redirect?: boolean; url?: string } | null;
    if (next?.redirect && typeof next.url === "string") {
      window.location.assign(next.url);
    }
  }

  const canAllow = !(blocked || problem) && selected.size > 0;

  return (
    <main className="min-h-screen bg-public flex items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <BrandMark
            fallbackIcon={
              <div className="inline-flex items-center justify-center size-12 rounded-xl bg-bark text-cream font-bold text-lg mb-4">
                {getInitials(brandName)}
              </div>
            }
            imgClassName="h-10 w-auto max-w-56 object-contain mx-auto mb-4"
            logoUrl={logoUrl}
            name={brandName}
            textClassName="text-2xl font-semibold text-bark block"
          />
          <p className="text-sm text-stone mt-1">Agent &amp; Admin Portal</p>
        </div>

        <div className="bg-white rounded-xl border border-sand shadow-soft shadow-sm p-8">
          {problem ? (
            <div className="text-center space-y-4">
              <WarningCircleIcon className="size-10 text-bark mx-auto" />
              <h2 className="text-lg font-semibold text-bark">
                Can&apos;t continue
              </h2>
              <p className="text-sm text-stone">{problem}</p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-start gap-3">
                <div className="inline-flex items-center justify-center size-10 rounded-full bg-bark/10 shrink-0">
                  <PlugsConnectedIcon className="size-5 text-bark" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-bark break-words">
                    Connect {clientName}?
                  </h2>
                  <p className="text-sm text-stone mt-1">
                    {clientName} is asking to access {brandName} as{" "}
                    <span className="font-medium text-bark">
                      {userName || userEmail}
                    </span>
                    {userName ? (
                      <span className="text-stone"> ({userEmail})</span>
                    ) : null}
                    .
                  </p>
                </div>
              </div>

              <dl className="text-xs text-stone space-y-1 rounded-md bg-cream px-3 py-2">
                {clientHost ? (
                  <div className="flex gap-2">
                    <dt className="shrink-0">Application:</dt>
                    <dd className="font-medium text-bark break-all">
                      {clientHost}
                    </dd>
                  </div>
                ) : null}
                {redirectHost ? (
                  <div className="flex gap-2">
                    <dt className="shrink-0">Returns to:</dt>
                    <dd className="font-medium text-bark break-all">
                      {redirectHost}
                    </dd>
                  </div>
                ) : null}
              </dl>

              {blocked ? (
                <p
                  className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2"
                  role="alert"
                >
                  {blocked}
                </p>
              ) : (
                <fieldset className="space-y-3">
                  <legend className="text-sm font-medium text-bark mb-1">
                    Allow it to:
                  </legend>
                  {scopes.map((scope) => (
                    <label
                      className="flex items-start gap-3 cursor-pointer"
                      htmlFor={`scope-${scope.id}`}
                      key={scope.id}
                    >
                      <Checkbox
                        checked={selected.has(scope.id)}
                        className="mt-0.5"
                        id={`scope-${scope.id}`}
                        onCheckedChange={(on) => toggle(scope.id, on)}
                      />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-bark">
                          {scope.label}
                        </span>
                        <span className="block text-xs text-stone">
                          {scope.description}
                        </span>
                      </span>
                    </label>
                  ))}
                  {offline ? (
                    <p className="text-xs text-stone">
                      It stays connected until you revoke it from your account
                      settings.
                    </p>
                  ) : null}
                </fieldset>
              )}

              {error ? (
                <p
                  className="text-sm text-red-600 bg-red-50 rounded-md px-3 py-2"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}

              <div className="flex gap-3">
                <Button
                  className="flex-1"
                  disabled={busy !== null}
                  onClick={() => decide(false)}
                  type="button"
                  variant="outline"
                >
                  {busy === "deny" ? "Denying…" : "Deny"}
                </Button>
                {blocked ? null : (
                  <Button
                    className="flex-1"
                    disabled={busy !== null || !canAllow}
                    onClick={() => decide(true)}
                    type="button"
                  >
                    {busy === "allow" ? "Allowing…" : "Allow"}
                  </Button>
                )}
              </div>
              <p className="text-xs text-stone text-center">
                You can revoke access any time from Settings. Nothing that
                reaches a customer happens without your approval in Docket.
              </p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
