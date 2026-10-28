"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  type AttachmentItem,
  TicketAttachments,
} from "@/components/common/ticket-attachments";

/** Thin client wrapper letting agent server-component pages render deletable
 * attachments without passing a function across the server/client boundary.
 * Never used on the customer page — deletion is agent/admin only. */
export function DeletableTicketAttachments({
  ticketId,
  items,
  className,
}: {
  ticketId: string;
  items: AttachmentItem[];
  className?: string;
}) {
  const router = useRouter();

  async function handleDelete(attachmentId: string) {
    const res = await fetch(
      `/api/tickets/${ticketId}/attachments/${attachmentId}`,
      {
        method: "DELETE",
      }
    );
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      toast.error(data?.error ?? "Failed to delete attachment.");
      return;
    }
    toast.success("Attachment deleted.");
    router.refresh();
  }

  return (
    <TicketAttachments
      className={className}
      items={items}
      onDelete={handleDelete}
    />
  );
}
