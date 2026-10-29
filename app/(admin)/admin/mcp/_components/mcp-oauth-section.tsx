"use client";

import { TrashIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LocalDateTime } from "@/components/common/local-datetime";
import {
  McpRevokeDialog,
  McpScopeBadges,
} from "@/components/common/mcp-token-parts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OAUTH_OFFLINE_SCOPE } from "@/lib/oauth-scopes";

interface OAuthClientItem {
  clientId: string;
  createdAt: string | null;
  disabled: boolean;
  grantCount: number;
  name: string;
  uri: string | null;
}

interface OAuthGrantItem {
  clientId: string;
  clientName: string;
  grantedAt: string;
  id: string;
  owner: { email: string; id: string; name: string };
  scopes: string[];
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}

/** Read-only view of the OAuth clients Docket has met and every user's grants.
 * An admin can revoke a grant, never create one. */
export function McpOAuthSection() {
  const [clients, setClients] = useState<OAuthClientItem[] | null>(null);
  const [grants, setGrants] = useState<OAuthGrantItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<OAuthGrantItem | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/mcp/oauth", { cache: "no-store" });
      if (!res.ok) {
        setLoadError(await readError(res, "Failed to load OAuth grants."));
        return;
      }
      const data = (await res.json()) as {
        clients: OAuthClientItem[];
        grants: OAuthGrantItem[];
      };
      setClients(data.clients);
      setGrants(data.grants);
      setLoadError(null);
    } catch {
      setLoadError("Network error. Please try again.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function handleRevoke() {
    if (!target) {
      return;
    }
    setRevoking(true);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/admin/mcp/oauth/grants/${target.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setRevokeError(await readError(res, "Failed to revoke access."));
        return;
      }
      setTarget(null);
      toast.success("Access revoked.");
      await load();
    } catch {
      setRevokeError("Network error. Please try again.");
    } finally {
      setRevoking(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Connected apps (OAuth)</CardTitle>
          <CardDescription>
            Assistants people signed in with instead of a token. Apps appear
            here the first time someone connects them, and each grant ends when
            its owner or an admin revokes it, or the owner is banned or leaves
            the agent and admin roles.
          </CardDescription>
        </CardHeader>
        {loadError && (
          <CardContent>
            <p className="text-xs text-error" role="alert">
              {loadError}
            </p>
          </CardContent>
        )}
        {!(grants || loadError) && (
          <CardContent className="space-y-3">
            {["a", "b"].map((key) => (
              <Skeleton className="h-10 w-full" key={key} />
            ))}
          </CardContent>
        )}
        {clients && clients.length > 0 && (
          <CardContent className="space-y-1.5">
            <p className="text-xs font-semibold tracking-wide uppercase">
              Known apps
            </p>
            <ul className="space-y-1">
              {clients.map((client) => (
                <li
                  className="flex flex-wrap items-center gap-2 text-sm"
                  key={client.clientId}
                >
                  <span className="font-medium text-base-content">
                    {client.name}
                  </span>
                  <span className="break-all font-mono text-xs text-base-content-muted">
                    {client.clientId}
                  </span>
                  <Badge variant="outline">
                    {client.grantCount}{" "}
                    {client.grantCount === 1 ? "grant" : "grants"}
                  </Badge>
                  {client.disabled && (
                    <Badge className="badge-error">Disabled</Badge>
                  )}
                </li>
              ))}
            </ul>
          </CardContent>
        )}
        {grants && grants.length === 0 && (
          <CardContent>
            <p className="text-sm text-base-content-muted">
              Nobody has connected an app with OAuth.
            </p>
          </CardContent>
        )}
        {grants && grants.length > 0 && (
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>User</TableHead>
                  <TableHead>Application</TableHead>
                  <TableHead>Connected</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {grants.map((grant) => (
                  <TableRow key={grant.id}>
                    <TableCell>
                      <p className="font-medium text-base-content">
                        {grant.owner.name}
                      </p>
                      <p className="text-xs text-base-content-muted">
                        {grant.owner.email}
                      </p>
                    </TableCell>
                    <TableCell>
                      <p className="font-medium text-base-content">
                        {grant.clientName}
                      </p>
                      <div className="mt-1.5 whitespace-normal">
                        <McpScopeBadges
                          scopes={grant.scopes.filter(
                            (s) => s !== OAUTH_OFFLINE_SCOPE
                          )}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-base-content-muted">
                      <LocalDateTime date={grant.grantedAt} mode="date" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        onClick={() => {
                          setRevokeError(null);
                          setTarget(grant);
                        }}
                        size="sm"
                        variant="outline"
                      >
                        <TrashIcon className="size-3.5" />
                        Revoke
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        )}
      </Card>

      <McpRevokeDialog
        busy={revoking}
        description={`This ends ${target?.owner.email ?? "the user"}'s connection right away. Any approval requests it made that are still waiting are cancelled.`}
        error={revokeError}
        onCancel={() => !revoking && setTarget(null)}
        onConfirm={handleRevoke}
        token={target ? { name: target.clientName } : null}
      />
    </>
  );
}
