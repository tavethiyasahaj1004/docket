"use client";

import { PlusIcon, TrashIcon, WarningIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { LocalDateTime } from "@/components/common/local-datetime";
import {
  MCP_SCOPE_DESCRIPTIONS,
  McpCopyButton,
  McpRevokeDialog,
  McpScopeBadges,
  type McpTokenItem,
  McpTokenStatusBadge,
} from "@/components/common/mcp-token-parts";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { buildClaudeCodeSetupSnippet } from "@/lib/mcp/client-setup";

interface TokenList {
  defaultScopes: string[];
  defaultTtlDays: number;
  issuableScopes: string[];
  maxTtlDays: number;
  mcpEnabled: boolean;
  mcpUrl: string;
  tokens: McpTokenItem[];
}

/** The one-time secret. Lives only in this component's state while the reveal
 * dialog is open — never in a cache or storage. */
interface CreatedToken {
  mcpUrl: string;
  rawToken: string;
}

const EXPIRY_CHOICES = [7, 30, 60, 90];

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: string };
    return data.error ?? fallback;
  } catch {
    return fallback;
  }
}

function expiryOptions(data: TokenList): number[] {
  const options = EXPIRY_CHOICES.filter((d) => d <= data.maxTtlDays);
  if (!options.includes(data.defaultTtlDays)) {
    options.push(data.defaultTtlDays);
    options.sort((a, b) => a - b);
  }
  return options;
}

export function McpTokensCard() {
  const [data, setData] = useState<TokenList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [days, setDays] = useState("30");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedToken | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<McpTokenItem | null>(null);
  const [revoking, setRevoking] = useState(false);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/account/mcp-tokens", {
        cache: "no-store",
      });
      if (!res.ok) {
        setLoadError(await readError(res, "Failed to load tokens."));
        return;
      }
      setData((await res.json()) as TokenList);
      setLoadError(null);
    } catch {
      setLoadError("Network error. Please try again.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function openCreate() {
    if (!data) {
      return;
    }
    setName("");
    setScopes(
      data.defaultScopes.filter((scope) => data.issuableScopes.includes(scope))
    );
    setDays(String(data.defaultTtlDays));
    setCreateError(null);
    setCreateOpen(true);
  }

  function toggleScope(scope: string, checked: boolean) {
    setScopes((current) =>
      checked
        ? [...current, scope]
        : current.filter((existing) => existing !== scope)
    );
  }

  async function handleCreate() {
    if (!data) {
      return;
    }
    setCreating(true);
    setCreateError(null);
    try {
      const res = await fetch("/api/account/mcp-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          scopes: data.issuableScopes.filter((scope) => scopes.includes(scope)),
          expiresInDays: Number(days),
        }),
      });
      if (!res.ok) {
        setCreateError(await readError(res, "Failed to create token."));
        return;
      }
      const body = (await res.json()) as {
        mcpUrl: string;
        rawToken: string;
      };
      setCreated({ rawToken: body.rawToken, mcpUrl: body.mcpUrl });
      setCreateOpen(false);
      setName("");
      await load();
    } catch {
      setCreateError("Network error. Please try again.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke() {
    if (!revokeTarget) {
      return;
    }
    setRevoking(true);
    setRevokeError(null);
    try {
      const res = await fetch(`/api/account/mcp-tokens/${revokeTarget.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setRevokeError(await readError(res, "Failed to revoke token."));
        return;
      }
      setRevokeTarget(null);
      toast.success("Token revoked.");
      await load();
    } catch {
      setRevokeError("Network error. Please try again.");
    } finally {
      setRevoking(false);
    }
  }

  const snippet = created
    ? buildClaudeCodeSetupSnippet(created.rawToken, created.mcpUrl)
    : "";

  return (
    <>
      <Card>
        {/* On phones: one column, so the button can drop below the text. */}
        <CardHeader className="max-sm:has-data-[slot=card-action]:grid-cols-1">
          <CardTitle>AI assistant access (MCP)</CardTitle>
          <CardDescription>
            Tokens let an AI assistant such as Claude Code read Docket data as
            you, limited to the scopes you pick. Tokens expire, and you can
            revoke them at any time.
          </CardDescription>
          {data?.mcpEnabled && data.issuableScopes.length > 0 && (
            <CardAction className="max-sm:col-start-1 max-sm:row-span-1 max-sm:row-start-3 max-sm:justify-self-start">
              <Button onClick={openCreate} size="sm">
                <PlusIcon className="size-4" />
                Create token
              </Button>
            </CardAction>
          )}
        </CardHeader>
        <CardContent className="space-y-6">
          <ul className="list-disc space-y-1 pl-5 text-xs text-base-content-muted">
            <li>
              Resetting your password does not revoke these tokens — review them
              after a password reset.
            </li>
            <li>Signing out of other sessions revokes all of these tokens.</li>
          </ul>

          {loadError && (
            <p className="text-xs text-error" role="alert">
              {loadError}
            </p>
          )}

          {!(data || loadError) && (
            <div className="space-y-3">
              {["a", "b"].map((key) => (
                <Skeleton className="h-10 w-full" key={key} />
              ))}
            </div>
          )}

          {data && !data.mcpEnabled && (
            <p className="text-sm text-base-content-muted">
              AI assistant access is currently turned off by an administrator.
            </p>
          )}
        </CardContent>
        {data && data.tokens.length > 0 && (
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
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
                {data.tokens.map((token) => (
                  <TableRow key={token.id}>
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
          </CardContent>
        )}
        {data?.mcpEnabled && data.tokens.length === 0 && (
          <CardContent>
            <p className="text-sm text-base-content-muted">
              You haven&apos;t created any tokens yet.
            </p>
          </CardContent>
        )}
      </Card>

      {/* Create dialog */}
      <Dialog
        onOpenChange={(open) => !(open || creating) && setCreateOpen(false)}
        open={createOpen}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Create token</DialogTitle>
            <DialogDescription>
              Name it after where it will be used, e.g. &ldquo;Claude Code on my
              laptop&rdquo;.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-token-name">Name</Label>
            <Input
              id="mcp-token-name"
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Claude Code on my laptop"
              value={name}
            />
          </div>

          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-xs font-semibold tracking-wide uppercase">
              Access
            </legend>
            {data?.issuableScopes.map((scope) => (
              <div className="flex items-start gap-2" key={scope}>
                <Checkbox
                  checked={scopes.includes(scope)}
                  className="mt-0.5"
                  id={`mcp-scope-${scope}`}
                  onCheckedChange={(checked) => toggleScope(scope, checked)}
                />
                <Label
                  className="flex-col items-start gap-0 text-sm font-normal tracking-normal normal-case cursor-pointer"
                  htmlFor={`mcp-scope-${scope}`}
                >
                  <span className="font-mono text-xs">{scope}</span>
                  <span className="text-xs text-base-content-muted">
                    {MCP_SCOPE_DESCRIPTIONS[scope] ?? ""}
                  </span>
                </Label>
              </div>
            ))}
          </fieldset>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-token-expiry">Expires after</Label>
            <Select onValueChange={setDays} value={days}>
              <SelectTrigger className="w-full" id="mcp-token-expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {data &&
                  expiryOptions(data).map((option) => (
                    <SelectItem key={option} value={String(option)}>
                      {option} days
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {createError && (
            <p className="text-xs text-error" role="alert">
              {createError}
            </p>
          )}

          <DialogFooter className="flex-row gap-2">
            <Button
              className="flex-1"
              disabled={creating}
              onClick={() => setCreateOpen(false)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={creating || !name.trim() || scopes.length === 0}
              onClick={handleCreate}
            >
              {creating ? "Creating…" : "Create token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* One-time reveal. Only the Done button closes it, so a stray click
          outside can't lose a token that can never be shown again. */}
      <Dialog onOpenChange={() => undefined} open={created !== null}>
        <DialogContent className="max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Token created</DialogTitle>
            <DialogDescription>
              Copy your token and keep it somewhere safe.
            </DialogDescription>
          </DialogHeader>

          <div
            className="flex items-start gap-3 rounded-box border border-warning/30 bg-warning/10 p-4 text-sm text-base-content"
            role="alert"
          >
            <WarningIcon
              className="mt-0.5 size-5 shrink-0 text-warning"
              weight="fill"
            />
            <p>
              <span className="font-semibold">
                This token will not be shown again.
              </span>{" "}
              If you lose it, revoke it and create a new one.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="mcp-raw-token">Your token</Label>
            <div className="flex items-center gap-2">
              <Input
                className="font-mono text-xs"
                id="mcp-raw-token"
                onFocus={(e) => e.currentTarget.select()}
                readOnly
                value={created?.rawToken ?? ""}
              />
              <McpCopyButton
                label="Copy token"
                text={created?.rawToken ?? ""}
              />
            </div>
          </div>

          {/* min-w-0: the dialog is a grid, and without it the snippet's long
              line widens this cell and the whole dialog scrolls sideways. */}
          <div className="min-w-0 space-y-1.5">
            <p className="text-xs font-semibold tracking-wide uppercase">
              Set up Claude Code
            </p>
            <div className="flex items-start gap-2 rounded-box border border-base-300 bg-base-300/40 p-3">
              <pre className="min-w-0 flex-1 overflow-x-auto font-mono text-xs text-base-content">
                {snippet}
              </pre>
              <McpCopyButton label="Copy setup commands" text={snippet} />
            </div>
          </div>

          <DialogFooter>
            <Button className="w-full" onClick={() => setCreated(null)}>
              Done
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <McpRevokeDialog
        busy={revoking}
        description="Any AI assistant using this token will immediately lose access. This cannot be undone."
        error={revokeError}
        onCancel={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        token={revokeTarget}
      />
    </>
  );
}
