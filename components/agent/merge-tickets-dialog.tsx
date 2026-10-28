"use client";

import { GitMergeIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { CustomerTicketSummary } from "@/lib/customers";
import type { TicketStatus } from "@/lib/ticket-config";
import { COLOR_BADGE } from "@/lib/tickets";
import { cn } from "@/lib/utils";

export interface MergeCandidate {
  customerId: string;
  id: string;
  status: string;
  subject: string;
  ticketNumber: number;
}

interface Props {
  /** Tickets always in the merge — the list's selection, or the ticket being
   * viewed. Shown ticked and locked. */
  baseTickets: MergeCandidate[];
  /** When set, the customer's other tickets are loaded as optional extras
   * (unticked) — how the ticket page merges 3–4 duplicates in one go. */
  customerId?: string;
  /** Whether the merge emails the customer (admin settings) — only changes
   * what the dialog promises; the server decides what's actually sent. */
  emailsCustomer: boolean;
  /** After a successful merge: the surviving ticket and the ids merged into it. */
  onMerged: (result: {
    mergedIds: string[];
    targetTicketNumber: number;
  }) => void;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  statuses: TicketStatus[];
}

type Extras =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; tickets: MergeCandidate[] };

/** Merges several tickets into one primary ticket, picked here (Freshdesk /
 * Zendesk style). One request to POST /api/tickets/merge — all or nothing, one
 * customer email. The same-customer and open-primary checks below only fail
 * fast; the server enforces every rule (lib/tickets/merge.ts). */
export function MergeTicketsDialog({
  baseTickets,
  customerId,
  emailsCustomer,
  onMerged,
  onOpenChange,
  open,
  statuses,
}: Props) {
  const statusMap = Object.fromEntries(statuses.map((s) => [s.slug, s]));
  const isClosed = (slug: string) => statusMap[slug]?.isClosedState ?? false;

  const [extras, setExtras] = useState<Extras>({ state: "idle" });
  const [checkedExtraIds, setCheckedExtraIds] = useState<Set<string>>(
    new Set()
  );
  const [primaryId, setPrimaryId] = useState<string | null>(null);
  const [merging, setMerging] = useState(false);

  const baseKey = baseTickets.map((t) => t.id).join(",");

  // Reset on every open, and load the customer's other tickets if asked.
  useEffect(() => {
    if (!open) {
      return;
    }
    setCheckedExtraIds(new Set());
    setPrimaryId(null);
    if (!customerId) {
      setExtras({ state: "idle" });
      return;
    }
    setExtras({ state: "loading" });
    const baseIds = new Set(baseKey.split(","));
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/customers/${customerId}`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as {
          openTickets: CustomerTicketSummary[];
          closedTickets: CustomerTicketSummary[];
        };
        // Open first: those are the likely duplicates and the only valid
        // primaries. Closed ones can still be folded in.
        const toCandidate = (t: CustomerTicketSummary): MergeCandidate => ({
          customerId,
          id: t.id,
          status: t.status,
          subject: t.subject,
          ticketNumber: t.ticketNumber,
        });
        if (!cancelled) {
          setExtras({
            state: "ready",
            tickets: [...data.openTickets, ...data.closedTickets]
              .filter((t) => !baseIds.has(t.id))
              .map(toCandidate),
          });
        }
      } catch {
        // Distinct from "no other tickets" — that would be misleading.
        if (!cancelled) {
          setExtras({ state: "error" });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, customerId, baseKey]);

  const extraTickets = extras.state === "ready" ? extras.tickets : [];
  const included = [
    ...baseTickets,
    ...extraTickets.filter((t) => checkedExtraIds.has(t.id)),
  ].sort((a, b) => a.ticketNumber - b.ticketNumber);
  const includedOpen = included.filter((t) => !isClosed(t.status));
  // The primary defaults to the oldest open ticket in the merge — where the
  // conversation started — and falls back to it whenever the agent's pick is
  // unticked.
  const primary =
    includedOpen.find((t) => t.id === primaryId) ?? includedOpen[0] ?? null;
  const sources = included.filter((t) => t.id !== primary?.id);

  const sameCustomer = new Set(included.map((t) => t.customerId)).size <= 1;
  let blocker: string | null = null;
  if (!sameCustomer) {
    blocker =
      "Only tickets from the same customer can be merged. Select tickets from one customer.";
  } else if (included.length >= 2 && !primary) {
    blocker =
      "All the tickets in this merge are closed. Reopen the one you want to keep, then merge.";
  }
  const canMerge = !blocker && primary !== null && sources.length > 0;

  // Ignore Esc / outside-click while merging, so the dialog can't vanish and
  // then act (navigate / refresh) under the agent a moment later.
  function handleOpenChange(next: boolean) {
    if (!merging) {
      onOpenChange(next);
    }
  }

  function toggleExtra(id: string, checked: boolean) {
    setCheckedExtraIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  }

  async function handleMerge() {
    if (!(canMerge && primary)) {
      return;
    }
    setMerging(true);
    try {
      const res = await fetch("/api/tickets/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceTicketIds: sources.map((t) => t.id),
          targetTicketNumber: primary.ticketNumber,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        targetTicketNumber?: number;
      } | null;
      if (!res.ok) {
        toast.error(data?.error ?? "Failed to merge tickets.");
        return;
      }
      const targetTicketNumber =
        data?.targetTicketNumber ?? primary.ticketNumber;
      toast.success(
        `Merged ${sources.map((t) => `#${t.ticketNumber}`).join(", ")} into #${targetTicketNumber}.`
      );
      onOpenChange(false);
      onMerged({ mergedIds: sources.map((t) => t.id), targetTicketNumber });
    } catch {
      toast.error("Network error.");
    } finally {
      setMerging(false);
    }
  }

  function renderRow(t: MergeCandidate, locked: boolean) {
    const status = statusMap[t.status];
    const closed = isClosed(t.status);
    const isIncluded = locked || checkedExtraIds.has(t.id);
    const isPrimary = primary?.id === t.id;
    const canBePrimary = isIncluded && !closed;
    return (
      <div
        className={cn(
          "flex w-full items-center gap-2 rounded-field border px-3 py-2 text-sm transition-colors",
          isPrimary
            ? "border-primary bg-base-300"
            : "border-base-300 hover:bg-base-300"
        )}
        key={t.id}
      >
        {/* A label per control, so clicking the subject toggles inclusion
            without also hijacking the primary radio. */}
        <label
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2"
          htmlFor={`merge-include-${t.id}`}
        >
          <Checkbox
            aria-label={`Include #${t.ticketNumber} in the merge`}
            checked={isIncluded}
            disabled={locked}
            id={`merge-include-${t.id}`}
            onCheckedChange={(checked) => toggleExtra(t.id, checked)}
          />
          <span className="shrink-0 font-mono text-xs text-base-content-muted">
            #{t.ticketNumber}
          </span>
          <span className="min-w-0 flex-1 truncate text-base-content">
            {t.subject}
          </span>
          <span
            className={`shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium ${COLOR_BADGE[status?.color ?? "slate"] ?? ""}`}
          >
            {status?.label ?? t.status}
          </span>
        </label>
        <label
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-[10px] font-medium uppercase tracking-wide",
            canBePrimary
              ? "cursor-pointer text-base-content"
              : "cursor-not-allowed text-base-content-muted opacity-50"
          )}
          title={
            closed
              ? "A closed ticket can't be the primary — reopen it first"
              : isIncluded
                ? undefined
                : "Tick this ticket to make it the primary"
          }
        >
          <input
            checked={isPrimary}
            className="radio radio-primary radio-xs"
            disabled={!canBePrimary}
            name="merge-primary"
            onChange={() => setPrimaryId(t.id)}
            type="radio"
            value={t.id}
          />
          Primary
        </label>
      </div>
    );
  }

  return (
    <Dialog onOpenChange={handleOpenChange} open={open}>
      <DialogContent className="rounded-xl">
        <DialogHeader>
          <div className="mx-auto mb-2 flex size-10 items-center justify-center rounded-full bg-base-300">
            <GitMergeIcon className="size-5 text-base-content" />
          </div>
          <DialogTitle className="text-base-content text-center">
            Merge tickets
          </DialogTitle>
          <DialogDescription className="text-base-content-muted text-center">
            Tick the tickets to combine and pick the <strong>primary</strong>{" "}
            one to keep. Messages and attachments from the others move into it,
            and the others are closed.{" "}
            {emailsCustomer
              ? "The customer gets one email with a link to the primary ticket"
              : "The customer isn't emailed"}{" "}
            — their old links also open it. This can't be undone.
          </DialogDescription>
        </DialogHeader>

        <fieldset className="min-w-0 space-y-1.5" disabled={merging}>
          <legend className="sr-only">Tickets to merge</legend>
          <div className="max-h-72 space-y-1.5 overflow-y-auto">
            {baseTickets.map((t) => renderRow(t, true))}
            {extras.state === "loading" && (
              <p className="py-3 text-center text-xs text-base-content-muted">
                Loading this customer's other tickets…
              </p>
            )}
            {extras.state === "error" && (
              <p className="py-3 text-center text-xs text-red-600">
                Couldn't load this customer's other tickets. Close this dialog
                and try again.
              </p>
            )}
            {extras.state === "ready" && extraTickets.length === 0 && (
              <p className="py-3 text-center text-xs text-base-content-muted">
                This customer has no other tickets to merge.
              </p>
            )}
            {extraTickets.map((t) => renderRow(t, false))}
          </div>
        </fieldset>

        {blocker ? (
          <p className="text-center text-xs text-red-600">{blocker}</p>
        ) : (
          <p className="text-center text-xs text-base-content-muted">
            {sources.length === 0
              ? "Tick at least one more ticket to merge."
              : `${sources.map((t) => `#${t.ticketNumber}`).join(", ")} will be merged into #${primary?.ticketNumber}.`}
          </p>
        )}

        <DialogFooter className="gap-2">
          <Button
            className="flex-1 border-base-300 text-base-content"
            disabled={merging}
            onClick={() => onOpenChange(false)}
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            className="flex-1"
            disabled={merging || !canMerge}
            onClick={handleMerge}
          >
            {merging
              ? "Merging…"
              : canMerge && primary
                ? `Merge into #${primary.ticketNumber}`
                : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
