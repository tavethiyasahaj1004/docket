"use client";

import { PaperPlaneTiltIcon, RobotIcon } from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { LocalDateTime } from "@/components/common/local-datetime";
import { RichTextContent } from "@/components/common/rich-text-content";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface McpPendingActionItem {
  /** The reply as stored (Tiptap JSON); null for a close. */
  content: string | null;
  credentialName: string | null;
  expiresAt: string;
  id: string;
  kind: "close" | "reply";
}

type Decision = "approve" | "dismiss";

/** What the viewer's own AI assistant has asked to do on this ticket, with
 * Approve and Dismiss. Only the token owner is ever given these rows; the
 * server decides again on every click. */
export function McpPendingActionsBanner({
  actions,
}: {
  actions: McpPendingActionItem[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<McpPendingActionItem | null>(
    null
  );
  // Rows the server has answered for (decided, or no longer pending), hidden
  // until the refreshed page props catch up.
  const [settled, setSettled] = useState<ReadonlySet<string>>(new Set());
  // The server compare-and-set is the real guard; this only stops a second
  // click from firing while the first request is still in flight.
  const inFlightRef = useRef(false);

  const visible = actions.filter((a) => !settled.has(a.id));

  async function decide(item: McpPendingActionItem, decision: Decision) {
    if (inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    setBusyId(item.id);
    try {
      const res = await fetch(`/api/mcp/actions/${item.id}/${decision}`, {
        method: "POST",
      });
      const data = (await res.json().catch(() => null)) as {
        error?: string;
        outcome?: string;
      } | null;
      if (res.ok) {
        if (decision === "dismiss") {
          toast.success("Request dismissed.");
        } else if (data?.outcome === "already_closed") {
          toast.success("The ticket was already closed.");
        } else {
          toast.success(
            item.kind === "reply" ? "Reply sent to customer." : "Ticket closed."
          );
        }
      } else {
        toast.error(data?.error ?? "Something went wrong.");
      }
      // 404/409 mean the request is gone or already settled; either way there
      // is nothing left to click.
      if (res.ok || res.status === 404 || res.status === 409) {
        setSettled((prev) => new Set(prev).add(item.id));
      }
      setConfirming(null);
      router.refresh();
    } catch {
      toast.error("Network error. Please try again.");
    } finally {
      inFlightRef.current = false;
      setBusyId(null);
    }
  }

  if (visible.length === 0) {
    return null;
  }

  const busy = busyId !== null;

  return (
    <>
      <section
        aria-label="Requests from your AI assistant"
        className="shrink-0 divide-y divide-base-300 border-b border-base-300 bg-base-100 text-sm text-base-content"
      >
        {visible.map((item) => (
          <div className="px-4 py-3 lg:px-8" key={item.id}>
            <div className="flex flex-wrap items-center gap-3">
              <RobotIcon
                className="size-5 shrink-0 text-primary"
                weight="fill"
              />
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {item.kind === "close"
                    ? "Your AI assistant asks to close this ticket"
                    : "Your AI assistant asks to send this reply"}
                </p>
                <p className="text-xs text-base-content-muted">
                  {item.credentialName
                    ? `Token "${item.credentialName}" · `
                    : ""}
                  Expires <LocalDateTime date={item.expiresAt} />
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button
                  disabled={busy}
                  onClick={() => decide(item, "dismiss")}
                  size="sm"
                  variant="outline"
                >
                  Dismiss
                </Button>
                <Button
                  disabled={busy}
                  onClick={() =>
                    item.kind === "reply"
                      ? setConfirming(item)
                      : decide(item, "approve")
                  }
                  size="sm"
                >
                  Approve
                </Button>
              </div>
            </div>
            {item.content && (
              <div className="mt-3 max-h-48 overflow-y-auto rounded-box border border-base-300 bg-base-300/30 p-3">
                <RichTextContent content={item.content} />
              </div>
            )}
          </div>
        ))}
      </section>

      <Dialog
        onOpenChange={(open) => {
          if (!(open || busy)) {
            setConfirming(null);
          }
        }}
        open={confirming !== null}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <div className="mx-auto flex size-12 items-center justify-center rounded-full bg-primary/10">
              <PaperPlaneTiltIcon
                className="size-6 text-primary"
                weight="fill"
              />
            </div>
            <DialogTitle className="text-center">
              Send this reply to the customer?
            </DialogTitle>
            <DialogDescription className="text-center">
              Approving emails this reply to the customer, as you. It can&apos;t
              be unsent.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-row gap-2">
            <Button
              className="flex-1"
              disabled={busy}
              onClick={() => setConfirming(null)}
              variant="outline"
            >
              Cancel
            </Button>
            <Button
              className="flex-1"
              disabled={busy}
              onClick={() => confirming && decide(confirming, "approve")}
            >
              {busy ? "Sending…" : "Send reply"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
