"use client";

import { TrashIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LocalDateTime } from "@/components/common/local-datetime";
import {
  McpRevokeDialog,
  McpScopeBadges,
} from "@/components/common/mcp-token-parts";
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

interface ConnectedApp {
  clientId: string;
  clientName: string;
  clientUri: string | null;
  grantedAt: string;
  id: string;
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

/** The assistants this person connected over OAuth (claude.ai, Claude Desktop,
 * Claude Code's login, ...). Revoking one stops its access on its next call. */
export function McpConnectedAppsCard() {
  const [apps, setApps] = useState<ConnectedApp[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [target, setTarget] = useState<ConnectedApp | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/account/mcp/oauth-grants", {
        cache: "no-store",
      });
      if (!res.ok) {
        setLoadError(await readError(res, "Failed to load connected apps."));
        return;
      }
      const data = (await res.json()) as { grants: ConnectedApp[] };
      setApps(data.grants);
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
      const res = await fetch(`/api/account/mcp/oauth-grants/${target.id}`, {
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
          <CardTitle>Connected apps</CardTitle>
          <CardDescription>
            Assistants you signed into Docket with, such as claude.ai or Claude
            Desktop. Revoking one cuts its access right away.
          </CardDescription>
        </CardHeader>
        {loadError && (
          <CardContent>
            <p className="text-xs text-error" role="alert">
              {loadError}
            </p>
          </CardContent>
        )}
        {!(apps || loadError) && (
          <CardContent className="space-y-3">
            {["a", "b"].map((key) => (
              <Skeleton className="h-10 w-full" key={key} />
            ))}
          </CardContent>
        )}
        {apps && apps.length === 0 && (
          <CardContent>
            <p className="text-sm text-base-content-muted">
              No assistant is connected.
            </p>
          </CardContent>
        )}
        {apps && apps.length > 0 && (
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Application</TableHead>
                  <TableHead>Connected</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {apps.map((app) => (
                  <TableRow key={app.id}>
                    <TableCell>
                      <p className="font-medium text-base-content">
                        {app.clientName}
                      </p>
                      <p className="break-all font-mono text-xs text-base-content-muted">
                        {safeHost(app.clientId)}
                      </p>
                      <div className="mt-1.5 whitespace-normal">
                        <McpScopeBadges
                          scopes={app.scopes.filter(
                            (s) => s !== OAUTH_OFFLINE_SCOPE
                          )}
                        />
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-base-content-muted">
                      <LocalDateTime date={app.grantedAt} mode="date" />
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        onClick={() => {
                          setRevokeError(null);
                          setTarget(app);
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
        description="This app loses access to Docket right away and will have to ask you again. Any approval requests it made that are still waiting are cancelled."
        error={revokeError}
        onCancel={() => !revoking && setTarget(null)}
        onConfirm={handleRevoke}
        token={target ? { name: target.clientName } : null}
      />
    </>
  );
}

function safeHost(clientId: string): string {
  try {
    return new URL(clientId).host;
  } catch {
    return clientId;
  }
}
