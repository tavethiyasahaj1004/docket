"use client";

import { CaretDownIcon } from "@phosphor-icons/react";
import { formatDistanceToNow } from "date-fns";
import type { ReactNode } from "react";
import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";

/** Last credential-check outcome for sections that support one (SMTP, Google,
 * Pusher Channels, Pusher Beams). Omit entirely for sections that can't be
 * tested (storage), which keep the plain configured/not-configured pill. */
interface Verification {
  lastTestError: string | null;
  lastTestedAt: string | null;
  lastTestOk: boolean | null;
}

interface Props {
  children: ReactNode;
  /** Setup wizard usage: header becomes a toggle for the fields below, so 5
   * sections don't all show at once. Omit on /admin/integrations, where the
   * page itself is already scoped to just these settings. */
  collapsible?: boolean;
  configured: boolean;
  defaultOpen?: boolean;
  description: string;
  note?: ReactNode;
  /** Omit for sections with no "unconfigured" state to return to (e.g. storage,
   * whose default is the equally-valid "local" driver, not "unset"). */
  onRemove?: () => void;
  onSave: () => void;
  onTest?: () => void;
  removing?: boolean;
  saving: boolean;
  testing?: boolean;
  title: string;
  verification?: Verification;
}

/** Shared layout for the 5 integration sections on this page and in the setup
 * wizard's Integrations step — matches the bg-base-100/rounded-xl card pattern
 * used across /admin/appearance. */
export function IntegrationCard({
  title,
  description,
  configured,
  verification,
  note,
  saving,
  removing,
  testing,
  onSave,
  onRemove,
  onTest,
  collapsible = false,
  defaultOpen = false,
  children,
}: Props) {
  const [open, setOpen] = React.useState(defaultOpen);

  const badge = (() => {
    if (!configured) {
      return {
        label: "Not configured",
        className: "bg-base-300 text-base-content-muted",
      };
    }
    if (!verification || verification.lastTestOk === null) {
      return { label: "Configured", className: "bg-primary/10 text-primary" };
    }
    if (verification.lastTestOk) {
      const checkedAt = verification.lastTestedAt
        ? formatDistanceToNow(new Date(verification.lastTestedAt), {
            addSuffix: true,
          })
        : null;
      return {
        label: checkedAt ? `Verified ${checkedAt}` : "Verified",
        className: "bg-success/10 text-success",
      };
    }
    return {
      label: "Needs attention",
      className: "bg-warning/10 text-warning",
    };
  })();

  const header = (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h3 className="text-sm font-medium text-base-content flex items-center gap-2">
          {title}
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-2xs font-medium",
              badge.className
            )}
          >
            {badge.label}
          </span>
        </h3>
        <p className="text-xs text-base-content-muted mt-0.5">{description}</p>
        {verification?.lastTestOk === false && verification.lastTestError && (
          <p className="text-xs text-warning mt-1">
            {verification.lastTestError}
          </p>
        )}
      </div>
      {collapsible && (
        <CaretDownIcon
          className={cn(
            "size-4 shrink-0 text-base-content-muted transition-transform mt-0.5",
            open && "rotate-180"
          )}
        />
      )}
    </div>
  );

  const body = (
    <div className="space-y-4 pt-4">
      <div className="space-y-4">{children}</div>

      {note && (
        <p className="text-xs text-base-content-muted bg-base-300/40 rounded-md px-3 py-2">
          {note}
        </p>
      )}

      <div className="flex items-center justify-between gap-3 pt-1">
        {configured && onRemove ? (
          <Button
            className="text-error hover:text-error"
            disabled={saving || removing}
            onClick={onRemove}
            size="sm"
            type="button"
            variant="ghost"
          >
            {removing ? "Removing…" : "Remove"}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          {onTest && (
            <Button
              disabled={saving || removing || testing}
              onClick={onTest}
              size="sm"
              type="button"
              variant="outline"
            >
              {testing ? "Testing…" : "Test connection"}
            </Button>
          )}
          <Button
            disabled={saving || removing}
            onClick={onSave}
            size="sm"
            type="button"
          >
            {saving ? "Saving…" : "Save"}
          </Button>
        </div>
      </div>
    </div>
  );

  if (!collapsible) {
    return (
      <div className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6">
        {header}
        {body}
      </div>
    );
  }

  return (
    <Collapsible
      className="bg-base-100 rounded-xl border border-base-300 shadow-soft p-6"
      onOpenChange={setOpen}
      open={open}
    >
      <CollapsibleTrigger className="w-full text-left cursor-pointer">
        {header}
      </CollapsibleTrigger>
      <CollapsibleContent>{body}</CollapsibleContent>
    </Collapsible>
  );
}
