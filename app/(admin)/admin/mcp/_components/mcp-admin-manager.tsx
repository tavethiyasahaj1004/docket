"use client";

import {
  InfoIcon,
  RobotIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LocalDateTime } from "@/components/common/local-datetime";
import {
  McpCopyButton,
  McpRevokeDialog,
  McpScopeBadges,
  type McpTokenItem,
  McpTokenStatusBadge,
} from "@/components/common/mcp-token-parts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface McpSettings {
  enabled: boolean;
  httpsRequirementMet: boolean;
  mcpUrl: string;
}

interface AdminMcpToken extends McpTokenItem {
  owner: { email: string; id: string; name: string; role: string };
}

// Wording pending approval; deliberately the whole body of the notice.
const DATA_SHARING_NOTICE =
  "[PLACEHOLDER — data-sharing notice wording pending approval (G3)]";

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}

export function McpAdminManager() {
  const [settings, setSettings] = useState<McpSettings | null>(null);
  const [tokens, setTokens] = useState<AdminMcpToken[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<AdminMcpToken | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const loadTokens = useCallback(async () => {
    const res = await fetch("/api/admin/mcp/tokens", { cache: "no-store" });
    if (!res.ok) {
      throw new Error(await readError(res, "Failed to load tokens."));
    }
    const data = (await res.json()) as { tokens: AdminMcpToken[] };
    setTokens(data.tokens);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/admin/mcp/settings", {
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(await readError(res, "Failed to load settings."));
        }
        const data = (await res.json()) as McpSettings;
        if (!cancelled) {
          setSettings(data);
        }
        await loadTokens();
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : "Failed to load.");
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [loadTokens]);

  async function handleToggle(next: boolean) {
    if (!settings) {
      return;
    }
    const previous = settings.enabled;
    setSettings({ ...settings, enabled: next });
    setToggleError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/admin/mcp/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      if (!res.ok) {
        const message = await readError(res, "Failed to save.");
        setSettings((s) => (s ? { ...s, enabled: previous } : s));
        setToggleError(message);
        toast.error(message);
        return;
      }
      toast.success(next ? "MCP access enabled." : "MCP access disabled.");
    } catch {
      setSettings((s) => (s ? { ...s, enabled: previous } : s));
      setToggleError("Network error. Please try again.");
      toast.error("Network error. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) {
      return;
    }
    setRevoking(true);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/admin/mcp/tokens/${revokeTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setRevokeError(await readError(res, "Failed to revoke token."));
        return;
      }
      setRevokeTarget(null);
      toast.success("Token revoked.");
      await loadTokens();
    } catch {
      setRevokeError("Network error. Please try again.");
    } finally {
      setRevoking(false);
    }
  }

  if (loadError) {
    return (
      <Card>
        <CardContent>
          <p className="text-sm text-error" role="alert">
            {loadError}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (!settings) {
    return (
      <Card>
        <CardContent className="space-y-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-12 w-full" />
        </CardContent>
      </Card>
    );
  }

  const cannotEnable = !(settings.httpsRequirementMet || settings.enabled);

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>MCP access</CardTitle>
          <CardDescription>
            Lets agents and admins connect an AI assistant, such as Claude Code,
            to read Docket data with a personal access token. Off by default.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div
            className="rounded-box border border-info/30 bg-info/10 p-4 text-sm text-base-content"
            role="note"
          >
            <p className="flex items-center gap-2 font-semibold">
              <InfoIcon className="size-4 text-info" weight="fill" />
              Data-sharing notice
            </p>
            <p className="mt-2">{DATA_SHARING_NOTICE}</p>
          </div>

          {!settings.httpsRequirementMet && (
            <div
              className="rounded-box border border-warning/30 bg-warning/10 p-4 text-sm text-base-content"
              role="alert"
            >
              <p className="flex items-center gap-2 font-semibold">
                <WarningIcon className="size-4 text-warning" weight="fill" />
                HTTPS required
              </p>
              <p className="mt-2">
                MCP can only be enabled when the app URL uses https:// in
                production. Update NEXT_PUBLIC_APP_URL to an https:// address
                and redeploy first.
              </p>
            </div>
          )}

          <div className="flex items-center justify-between gap-4 rounded-box border border-base-300 p-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-base-content">
                Enable MCP access
              </p>
              <p className="text-xs text-base-content-muted mt-0.5">
                When off, the MCP endpoint refuses every request and no new
                tokens can be created.
              </p>
            </div>
            <Switch
              aria-label="Enable MCP access"
              checked={settings.enabled}
              disabled={saving || cannotEnable}
              onCheckedChange={handleToggle}
            />
          </div>

          {toggleError && (
            <p className="text-xs text-error" role="alert">
              {toggleError}
            </p>
          )}

          {settings.enabled && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold tracking-wide uppercase text-base-content-muted">
                Endpoint URL
              </p>
              <div className="flex items-center gap-2">
                <Input
                  aria-label="MCP endpoint URL"
                  className="font-mono text-xs"
                  readOnly
                  value={settings.mcpUrl}
                />
                <McpCopyButton
                  label="Copy endpoint URL"
                  text={settings.mcpUrl}
                />
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Tokens</CardTitle>
          <CardDescription>
            Every personal access token issued to agents and admins. Revoke a
            token to cut off that connection immediately.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {tokens === null ? (
            <div className="space-y-3 px-(--card-spacing)">
              {["a", "b", "c"].map((key) => (
                <Skeleton className="h-10 w-full" key={key} />
              ))}
            </div>
          ) : tokens.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <RobotIcon className="size-8 text-base-content-muted mb-3" />
              <p className="text-sm font-medium text-base-content">
                No tokens yet
              </p>
              <p className="text-xs text-base-content-muted mt-1">
                Agents and admins create tokens from their own settings page.
              </p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Owner</TableHead>
                  <TableHead>Token</TableHead>
                  <TableHead className="hidden 2xl:table-cell">
                    Created
                  </TableHead>
                  <TableHead>Last used</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tokens.map((token) => (
                  <TableRow key={token.id}>
                    <TableCell>
                      <p className="font-medium text-base-content">
                        {token.owner.name}
                      </p>
                      <p className="text-xs text-base-content-muted">
                        {token.owner.email}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="font-medium text-base-content">
                        {token.name}
                      </p>
                      <p className="font-mono text-xs text-base-content-muted">
                        {token.keyPrefix}…
                      </p>
                      {/* Scopes sit under the token, not in their own column,
                          so Status and Revoke fit without sideways scrolling. */}
                      <div className="mt-1.5 whitespace-normal">
                        <McpScopeBadges scopes={token.scopes} />
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-xs text-base-content-muted 2xl:table-cell">
                      <LocalDateTime date={token.createdAt} mode="date" />
                    </TableCell>
                    <TableCell className="text-xs text-base-content-muted">
                      <LocalDateTime date={token.lastUsedAt} fallback="Never" />
                    </TableCell>
                    <TableCell className="text-xs text-base-content-muted">
                      <LocalDateTime date={token.expiresAt} mode="date" />
                    </TableCell>
                    <TableCell>
                      <McpTokenStatusBadge status={token.status} />
                    </TableCell>
                    <TableCell className="text-right">
                      {token.status === "active" && (
                        <Button
                          onClick={() => {
                            setRevokeError(null);
                            setRevokeTarget(token);
                          }}
                          size="sm"
                          variant="outline"
                        >
                          <TrashIcon className="size-3.5" />
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <McpRevokeDialog
        busy={revoking}
        description={
          revokeTarget
            ? `${revokeTarget.owner.name} will immediately lose access through this token. This cannot be undone.`
            : ""
        }
        error={revokeError}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        token={revokeTarget}
      />
    </>
  );
}
