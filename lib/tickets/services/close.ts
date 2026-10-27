import { createId } from "@paralleldrive/cuid2";
import { and, eq, isNull } from "drizzle-orm";
import { customers, ticketActivity, tickets } from "@/db/schema";
import { db } from "@/lib/db";
import { ticketClosedTemplate } from "@/lib/email/templates/ticket-closed";
import { computeSlaTransition } from "@/lib/sla";
import { getClosedStatus, isClosedStatusSlug } from "@/lib/ticket-config";
import { notifyTicketStatusChange } from "@/lib/tickets/notify-status-change";
import { resolveTicketPortalUrl } from "@/lib/tickets/portal-url";
import { awaitWebhook, queueTicketEmail } from "./outcomes";
import type {
  ActivityMetadataExtra,
  EmailHandle,
  ServiceActor,
  WebhookOutcome,
} from "./types";

export interface CloseTicketInput {
  activityId?: string;
  activityMetadata?: ActivityMetadataExtra;
  actor: ServiceActor;
  now?: Date;
  ticketId: string;
}

export type CloseTicketResult =
  | { status: "not_found" }
  | { status: "merged" }
  | { status: "already_closed" }
  | { status: "no_closed_status" }
  | {
      status: "closed";
      slug: string;
      previousStatus: string;
      activityId: string;
      webhook: WebhookOutcome;
      email: EmailHandle;
    };

/** Closes a ticket on behalf of an agent/admin (the dedicated /close path:
 * resets awaiting-reply, stops the SLA clock, emails the customer). */
export async function closeTicket(
  input: CloseTicketInput
): Promise<CloseTicketResult> {
  const { ticketId, actor } = input;
  const now = input.now ?? new Date();

  const [ticket] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!ticket) {
    return { status: "not_found" };
  }
  if (ticket.mergedIntoTicketId) {
    return { status: "merged" };
  }

  const [customer] = await db
    .select({ name: customers.name, email: customers.email })
    .from(customers)
    .where(eq(customers.id, ticket.customerId))
    .limit(1);
  if (!customer) {
    return { status: "not_found" };
  }

  if (await isClosedStatusSlug(ticket.status)) {
    return { status: "already_closed" };
  }

  const closedStatus = await getClosedStatus();
  if (!closedStatus) {
    return { status: "no_closed_status" };
  }

  const previousStatus = ticket.status;

  // Closing resolves the ticket — it's no longer awaiting a reply, and the
  // SLA resolution clock stops (flushing any in-progress active span first).
  const slaUpdate = computeSlaTransition(
    { awaitingReply: ticket.awaitingReply, waitingSince: ticket.waitingSince },
    false,
    now,
    "closing"
  );

  await db
    .update(tickets)
    .set({
      status: closedStatus.slug,
      closedAt: now,
      updatedAt: now,
      awaitingReply: false,
      pendingReplies: 0,
      ...slaUpdate,
    })
    .where(and(eq(tickets.id, ticketId), isNull(tickets.mergedIntoTicketId)));

  const activityId = input.activityId ?? createId();
  await db.insert(ticketActivity).values({
    id: activityId,
    ticketId,
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action: "ticket_closed",
    metadata: {
      ...input.activityMetadata,
      from: previousStatus,
      to: closedStatus.slug,
    },
    createdAt: now,
  });

  // Notify any configured outbound webhooks.
  const webhook = await awaitWebhook(
    "[webhook.ticket_closed]",
    notifyTicketStatusChange(
      {
        id: ticketId,
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        status: closedStatus.slug,
        priority: ticket.priority,
        category: ticket.category,
        customerName: customer.name,
        customerEmail: customer.email,
        createdAt: ticket.createdAt,
        updatedAt: now,
      },
      false,
      true
    )
  );

  // Notify the customer on close (fire-and-forget).
  const ticketUrl = await resolveTicketPortalUrl(
    ticketId,
    ticket.customerToken,
    ticket.apiKeyId
  );
  const email = queueTicketEmail({
    label: "[ticket.closed email]",
    to: customer.email,
    render: () =>
      ticketClosedTemplate({
        customerName: customer.name,
        ticketNumber: ticket.ticketNumber,
        ticketSubject: ticket.subject,
        ticketUrl,
      }),
  });

  return {
    status: "closed",
    slug: closedStatus.slug,
    previousStatus,
    activityId,
    webhook,
    email,
  };
}
