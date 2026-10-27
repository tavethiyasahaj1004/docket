import { createId } from "@paralleldrive/cuid2";
import { and, eq, isNull } from "drizzle-orm";
import { customers, ticketActivity, tickets } from "@/db/schema";
import { db } from "@/lib/db";
import { computeSlaTransition } from "@/lib/sla";
import { getDefaultStatus, isClosedStatusSlug } from "@/lib/ticket-config";
import { notifyTicketStatusChange } from "@/lib/tickets/notify-status-change";
import { awaitWebhook } from "./outcomes";
import type {
  ActivityMetadataExtra,
  EmailHandle,
  ServiceActor,
  WebhookOutcome,
} from "./types";

export interface ReopenTicketInput {
  activityId?: string;
  activityMetadata?: ActivityMetadataExtra;
  actor: ServiceActor;
  now?: Date;
  ticketId: string;
}

export type ReopenTicketResult =
  | { status: "not_found" }
  | { status: "merged" }
  | { status: "not_closed" }
  | { status: "no_default_status" }
  | {
      status: "reopened";
      slug: string;
      previousStatus: string;
      activityId: string;
      webhook: WebhookOutcome;
      email: EmailHandle;
    };

/** Reopens a closed ticket on behalf of an agent/admin (an agent reopening is
 * already handling it, so the ticket is not flagged as awaiting a reply). No
 * email is sent. */
export async function reopenTicket(
  input: ReopenTicketInput
): Promise<ReopenTicketResult> {
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

  if (!(await isClosedStatusSlug(ticket.status))) {
    return { status: "not_closed" };
  }

  const defaultStatus = await getDefaultStatus();
  if (!defaultStatus) {
    return { status: "no_default_status" };
  }

  const previousStatus = ticket.status;

  // Agent semantics: an agent reopening is already handling the ticket.
  const reopenedByCustomer = false;

  // Resuming from "resolved" always restarts the SLA clock at `now` — there's
  // no in-progress span to flush since it was already stopped at close (see
  // lib/sla.ts's "reopening" mode).
  const slaUpdate = computeSlaTransition(
    { awaitingReply: ticket.awaitingReply, waitingSince: ticket.waitingSince },
    reopenedByCustomer,
    now,
    "reopening"
  );

  await db
    .update(tickets)
    .set({
      status: defaultStatus.slug,
      closedAt: null,
      updatedAt: now,
      awaitingReply: reopenedByCustomer,
      pendingReplies: reopenedByCustomer ? 1 : 0,
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
    action: "ticket_reopened",
    metadata: {
      ...input.activityMetadata,
      from: previousStatus,
      to: defaultStatus.slug,
    },
    createdAt: now,
  });

  // Notify any configured outbound webhooks.
  const webhook = await awaitWebhook(
    "[webhook.ticket_reopened]",
    notifyTicketStatusChange(
      {
        id: ticketId,
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        status: defaultStatus.slug,
        priority: ticket.priority,
        category: ticket.category,
        customerName: customer.name,
        customerEmail: customer.email,
        createdAt: ticket.createdAt,
        updatedAt: now,
      },
      true,
      false
    )
  );

  return {
    status: "reopened",
    slug: defaultStatus.slug,
    previousStatus,
    activityId,
    webhook,
    email: null,
  };
}
