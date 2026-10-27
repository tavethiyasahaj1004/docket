import { asc, count, eq, inArray } from "drizzle-orm";
import { user } from "@/db/schema/auth";
import {
  ticketAttachments,
  ticketComments,
  tickets,
} from "@/db/schema/tickets";
import { db } from "@/lib/db";

// Read-only queries the MCP tools need beyond the shared ticket queries. They
// select named columns only: no storage keys, no customer token.

/** The fields get_ticket needs that getTicketDetail does not return. */
export async function getTicketExtras(ticketId: string) {
  const [row] = await db
    .select({
      awaitingReply: tickets.awaitingReply,
      pendingReplies: tickets.pendingReplies,
      source: tickets.source,
      waitingSince: tickets.waitingSince,
      firstRespondedAt: tickets.firstRespondedAt,
      assigneeName: user.name,
    })
    .from(tickets)
    .leftJoin(user, eq(tickets.assignedAgentId, user.id))
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return row ?? null;
}

/** `pendingReplies` for a page of tickets, keyed by ticket id. */
export async function getPendingRepliesByTicket(
  ticketIds: string[]
): Promise<Map<string, number>> {
  if (ticketIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: tickets.id, pendingReplies: tickets.pendingReplies })
    .from(tickets)
    .where(inArray(tickets.id, ticketIds));
  return new Map(rows.map((r) => [r.id, r.pendingReplies]));
}

/** Public and internal comment counts for one ticket. */
export async function getCommentCounts(ticketId: string) {
  const rows = await db
    .select({ isInternal: ticketComments.isInternal, c: count() })
    .from(ticketComments)
    .where(eq(ticketComments.ticketId, ticketId))
    .groupBy(ticketComments.isInternal);
  let publicCount = 0;
  let internalCount = 0;
  for (const row of rows) {
    if (row.isInternal) {
      internalCount = Number(row.c);
    } else {
      publicCount = Number(row.c);
    }
  }
  return { public: publicCount, internal: internalCount };
}

/** Attachment metadata for a ticket, oldest first. `onInternalNote` marks files
 * hanging off an internal note; description attachments have no comment. */
export async function getAttachmentMetadata(ticketId: string) {
  return await db
    .select({
      id: ticketAttachments.id,
      filename: ticketAttachments.filename,
      mimeType: ticketAttachments.mimeType,
      fileSize: ticketAttachments.fileSize,
      createdAt: ticketAttachments.createdAt,
      onInternalNote: ticketComments.isInternal,
    })
    .from(ticketAttachments)
    .leftJoin(
      ticketComments,
      eq(ticketAttachments.commentId, ticketComments.id)
    )
    .where(eq(ticketAttachments.ticketId, ticketId))
    .orderBy(asc(ticketAttachments.createdAt), asc(ticketAttachments.id));
}

/** Whether a user with this id exists, in any role: an assignee filter may name
 * a former agent who still has tickets assigned. */
export async function userExists(userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row !== undefined;
}

/** The customer behind a ticket, by ticket id. */
export async function getTicketCustomerId(
  ticketId: string
): Promise<string | null> {
  const [row] = await db
    .select({ customerId: tickets.customerId })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  return row?.customerId ?? null;
}
