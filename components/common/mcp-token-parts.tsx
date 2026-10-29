"use client";

import { CheckIcon, CopyIcon, WarningCircleIcon } from "@phosphor-icons/react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export type McpTokenStatus = "active" | "expired" | "revoked";

/** A token as the MCP token APIs return it (dates arrive as ISO strings). The
 * hash and the raw token are never part of it. */
export interface McpTokenItem {
  createdAt: string;
  expiresAt: string;
  id: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  name: string;
  revokedAt: string | null;
  scopes: string[];
  status: McpTokenStatus;
}

export const MCP_SCOPE_DESCRIPTIONS: Record<string, string> = {
  "tickets:read": "Tickets, statuses, tags and stats",
  "customers:read": "Customer profiles",
  "tickets:write":
    "Drafts, internal notes, tags, priority and category (nothing customers see)",
  "tickets:manage":
    "Assign, change status, reopen; request closes (a close needs your approval in Docket)",
  "tickets:reply":
    "Request customer replies (needs your approval in Docket and the admin setting)",
  "reports:read": "Admin reports",
};

const STATUS_LABEL: Record<McpTokenStatus, string> = {
  active: "Active",
  expired: "Expired",
  revoked: "Revoked",
};

const STATUS_CLASS: Record<McpTokenStatus, string> = {
  active: "badge-success",
  expired: "badge-warning",
  revoked: "badge-error",
};

export function McpTokenStatusBadge({ status }: { status: McpTokenStatus }) {
  return <Badge className={STATUS_CLASS[status]}>{STATUS_LABEL[status]}</Badge>;
}

export function McpScopeBadges({ scopes }: { scopes: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {scopes.map((scope) => (
        <Badge
          // Small chips: at the default size, monospace scope names are wide
          // enough to push the token tables off-screen.
          className="badge-sm font-mono normal-case"
          key={scope}
          variant="outline"
        >
          {scope}
        </Badge>
      ))}
    </div>
  );
}

export function McpCopyButton({
  className,
  label,
  text,
}: {
  className?: string;
  label: string;
  text: string;
}) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn't copy to the clipboard.");
    }
  }

  return (
    <Button
      aria-label={copied ? "Copied" : label}
      className={cn("shrink-0", className)}
      onClick={copy}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      {copied ? (
        <CheckIcon className="size-4 text-success" />
      ) : (
        <CopyIcon className="size-4" />
      )}
    </Button>
  );
}

export function McpRevokeDialog({
  busy,
  description,
  error,
  onCancel,
  onConfirm,
  token,
}: {
  busy: boolean;
  description: string;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
  token: McpTokenItem | null;
}) {
  return (
    <Dialog onOpenChange={(open) => !open && onCancel()} open={token !== null}>
      <DialogContent>
        <DialogHeader>
          <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-error/10">
            <WarningCircleIcon className="size-6 text-error" weight="fill" />
          </div>
          <DialogTitle className="text-center">
            Revoke &ldquo;{token?.name}&rdquo;?
          </DialogTitle>
          <DialogDescription className="text-center">
            {description}
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p className="text-center text-xs text-error" role="alert">
            {error}
          </p>
        )}
        <DialogFooter className="flex-row gap-2">
          <Button
            className="flex-1"
            disabled={busy}
            onClick={onCancel}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            className="flex-1"
            disabled={busy}
            onClick={onConfirm}
            variant="destructive"
          >
            {busy ? "Revoking…" : "Revoke"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
