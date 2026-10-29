import { createId } from "@paralleldrive/cuid2";
import { and, eq, isNull, notInArray, sql } from "drizzle-orm";
import { customers, ticketActivity, tickets } from "@/db/schema";
import { db } from "@/lib/db";
import {
  getTicketCategories,
  getTicketPriorities,
  getTicketStatuses,
} from "@/lib/ticket-config";
import { notifyTicketStatusChange } from "@/lib/tickets/notify-status-change";
import {
  dispatchWebhookEvent,
  ticketPayloadData,
} from "@/lib/webhooks/dispatch";
import { awaitWebhook } from "./outcomes";
import type {
  ActivityMetadataExtra,
  ServiceActor,
  WebhookOutcome,
} from "./types";

/** The ticket + customer as loaded before ANY change in a request. Every field
 * service of one request is handed the SAME snapshot, so (as the generic PATCH
 * always did) a later webhook payload shows the pre-change values of fields
 * updated earlier in that request. */
export interface TicketSnapshot {
  customer: { name: string; email: string };
  ticket: typeof tickets.$inferSelect;
}

export type LoadTicketForChangeResult =
  | { status: "not_found" }
  | { status: "merged" }
  | ({ status: "ok" } & TicketSnapshot);

/** Loads the ticket and its customer for a field change. A missing customer
 * row counts as not found. */
export async function loadTicketForChange(
  ticketId: string
): Promise<LoadTicketForChangeResult> {
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
  return { status: "ok", ticket, customer };
}

export interface FieldChangeInput<T> {
  activityMetadata?: ActivityMetadataExtra;
  actor: ServiceActor;
  now: Date;
  snapshot: TicketSnapshot;
  value: T;
}

export type FieldChangeResult =
  | { status: "invalid" }
  | { status: "unchanged" }
  | { status: "changed"; activityId: string; webhook: WebhookOutcome };

/** Input of the field changes that can be made conditional on the ticket's
 * `updated_at` (optimistic concurrency). */
export interface ConditionalFieldChangeInput<T> extends FieldChangeInput<T> {
  /** When given, the update applies only while the ticket's `updated_at`
   * (compared at millisecond precision, the precision the API exposes) still
   * equals it; otherwise nothing is written and the result is `conflict`.
   * Omitted: the update is unconditional, exactly as before. */
  expectedUpdatedAt?: Date;
}

export type ConditionalFieldChangeResult =
  | FieldChangeResult
  | { status: "conflict" };

/** The ticket is not merged and, when a version is expected, still at it. The
 * column is timestamptz with microsecond precision while the API reports
 * milliseconds, so the stored value is truncated before comparing. */
const notMergedAndAt = (ticketId: string, expectedUpdatedAt?: Date) =>
  expectedUpdatedAt
    ? and(
        eq(tickets.id, ticketId),
        isNull(tickets.mergedIntoTicketId),
        sql`date_trunc('milliseconds', ${tickets.updatedAt}) = ${expectedUpdatedAt.toISOString()}::timestamptz`
      )
    : and(eq(tickets.id, ticketId), isNull(tickets.mergedIntoTicketId));

async function insertActivity(
  snapshot: TicketSnapshot,
  actor: ServiceActor,
  now: Date,
  action: string,
  // Written as-is, `null` included (matches the old per-field inserts).
  metadata: Record<string, unknown> | null
) {
  const activityId = createId();
  await db.insert(ticketActivity).values({
    id: activityId,
    ticketId: snapshot.ticket.id,
    actorId: actor.id,
    actorName: actor.name,
    actorRole: actor.role,
    action,
    metadata,
    createdAt: now,
  });
  return activityId;
}

/** The version check of {@link notMergedAndAt} on its own (undefined = none). */
const atVersion = (expectedUpdatedAt?: Date) =>
  expectedUpdatedAt
    ? sql`date_trunc('milliseconds', ${tickets.updatedAt}) = ${expectedUpdatedAt.toISOString()}::timestamptz`
    : undefined;

/** Generic PATCH status change. Closing through here is deliberately NOT the
 * dedicated close path: no SLA/awaiting-reply reset and no customer email.
 * `expectedUpdatedAt` (optional, as for the other conditional changes) makes it
 * conflict instead of overwriting a ticket that changed since it was read. */
export async function changeTicketStatusGeneric({
  snapshot,
  actor,
  value,
  now,
  activityMetadata,
  expectedUpdatedAt,
}: ConditionalFieldChangeInput<string>): Promise<ConditionalFieldChangeResult> {
  const { ticket, customer } = snapshot;
  if (value === ticket.status) {
    return { status: "unchanged" };
  }

  const validStatuses = await getTicketStatuses();
  const statusRow = validStatuses.find((s) => s.slug === value);
  if (!statusRow) {
    return { status: "invalid" };
  }
  const previousStatus = ticket.status;
  const newStatus = value;
  const previousStatusRow = validStatuses.find(
    (s) => s.slug === previousStatus
  );

  // A transition INTO a closed state from an open one is conditional on the
  // ticket's CURRENT status (the snapshot is an earlier read): when a
  // concurrent close already won, nothing changes here, so no activity row and
  // no webhook is written and the caller sees an unchanged status. Other
  // transitions (open->open, closed->closed, reopen) stay unconditional. The
  // list is non-empty: `statusRow` is itself a closed state.
  const closing =
    statusRow.isClosedState && !(previousStatusRow?.isClosedState ?? false);
  const closedSlugs = validStatuses
    .filter((s) => s.isClosedState)
    .map((s) => s.slug);
  const updated = await db
    .update(tickets)
    .set({
      status: newStatus,
      closedAt: statusRow.isClosedState ? now : null,
      updatedAt: now,
    })
    .where(
      closing
        ? and(
            eq(tickets.id, ticket.id),
            isNull(tickets.mergedIntoTicketId),
            notInArray(tickets.status, closedSlugs),
            atVersion(expectedUpdatedAt)
          )
        : and(
            eq(tickets.id, ticket.id),
            isNull(tickets.mergedIntoTicketId),
            atVersion(expectedUpdatedAt)
          )
    )
    .returning({ id: tickets.id });
  if (updated.length === 0 && expectedUpdatedAt) {
    // Lost the version check: no activity, no webhook.
    return { status: "conflict" };
  }
  if (closing && updated.length === 0) {
    return { status: "unchanged" };
  }

  const activityId = await insertActivity(
    snapshot,
    actor,
    now,
    statusRow.isClosedState ? "ticket_closed" : "status_changed",
    { ...activityMetadata, from: previousStatus, to: newStatus }
  );

  // Notify any configured outbound webhooks — routed through the same
  // helper the dedicated /close and /reopen routes use, so closing via
  // this generic PATCH (e.g. the sidebar status dropdown) still fires the
  // same ticket.closed/ticket.reopened event an integrator would expect.
  const webhook = await awaitWebhook(
    "[webhook.status_changed]",
    notifyTicketStatusChange(
      {
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        status: newStatus,
        priority: ticket.priority,
        category: ticket.category,
        customerName: customer.name,
        customerEmail: customer.email,
        createdAt: ticket.createdAt,
        updatedAt: now,
      },
      previousStatusRow?.isClosedState ?? false,
      statusRow.isClosedState
    )
  );
  return { status: "changed", activityId, webhook };
}

export async function setTicketCategory({
  snapshot,
  actor,
  value,
  now,
  activityMetadata,
  expectedUpdatedAt,
}: ConditionalFieldChangeInput<string>): Promise<ConditionalFieldChangeResult> {
  const { ticket, customer } = snapshot;
  if (value === ticket.category) {
    return { status: "unchanged" };
  }

  const validCategories = await getTicketCategories();
  if (!validCategories.some((c) => c.slug === value)) {
    return { status: "invalid" };
  }
  const previousCategory = ticket.category;
  const newCategory = value;

  const updated = await db
    .update(tickets)
    .set({ category: newCategory, updatedAt: now })
    .where(notMergedAndAt(ticket.id, expectedUpdatedAt))
    .returning({ id: tickets.id });
  if (expectedUpdatedAt && updated.length === 0) {
    // Lost the version check: no activity, no webhook.
    return { status: "conflict" };
  }

  const activityId = await insertActivity(
    snapshot,
    actor,
    now,
    "category_changed",
    { ...activityMetadata, from: previousCategory, to: newCategory }
  );

  const webhook = await awaitWebhook(
    "[webhook.category_changed]",
    dispatchWebhookEvent("ticket.category_changed", "ticket", ticket.id, {
      ticket: ticketPayloadData({
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        category: newCategory,
        customerName: customer.name,
        customerEmail: customer.email,
        createdAt: ticket.createdAt,
        updatedAt: now,
      }),
      previousCategory,
    })
  );
  return { status: "changed", activityId, webhook };
}

export async function setTicketPriority({
  snapshot,
  actor,
  value,
  now,
  activityMetadata,
  expectedUpdatedAt,
}: ConditionalFieldChangeInput<string>): Promise<ConditionalFieldChangeResult> {
  const { ticket, customer } = snapshot;
  if (value === ticket.priority) {
    return { status: "unchanged" };
  }

  const validPriorities = await getTicketPriorities();
  if (!validPriorities.some((p) => p.slug === value)) {
    return { status: "invalid" };
  }
  const previousPriority = ticket.priority;
  const newPriority = value;

  const updated = await db
    .update(tickets)
    .set({ priority: newPriority, updatedAt: now })
    .where(notMergedAndAt(ticket.id, expectedUpdatedAt))
    .returning({ id: tickets.id });
  if (expectedUpdatedAt && updated.length === 0) {
    // Lost the version check: no activity, no webhook.
    return { status: "conflict" };
  }

  const activityId = await insertActivity(
    snapshot,
    actor,
    now,
    "priority_changed",
    { ...activityMetadata, from: previousPriority, to: newPriority }
  );

  const webhook = await awaitWebhook(
    "[webhook.priority_changed]",
    dispatchWebhookEvent("ticket.priority_changed", "ticket", ticket.id, {
      ticket: ticketPayloadData({
        id: ticket.id,
        ticketNumber: ticket.ticketNumber,
        subject: ticket.subject,
        status: ticket.status,
        priority: newPriority,
        category: ticket.category,
        customerName: customer.name,
        customerEmail: customer.email,
        createdAt: ticket.createdAt,
        updatedAt: now,
      }),
      previousPriority,
    })
  );
  return { status: "changed", activityId, webhook };
}

/** Assigns (agent id) or unassigns (null) a ticket. Does NO validation of the
 * agent id: an unknown id surfaces as the foreign-key error, as it always did
 * from the PATCH route. `expectedUpdatedAt` (optional) makes it conflict
 * instead of overwriting a ticket that changed since it was read. */
export async function assignTicket({
  snapshot,
  actor,
  value,
  now,
  activityMetadata,
  expectedUpdatedAt,
}: ConditionalFieldChangeInput<
  string | null
>): Promise<ConditionalFieldChangeResult> {
  const { ticket, customer } = snapshot;
  const newAgentId = value;
  if (newAgentId === ticket.assignedAgentId) {
    return { status: "unchanged" };
  }

  const updated = await db
    .update(tickets)
    .set({ assignedAgentId: newAgentId, updatedAt: now })
    .where(notMergedAndAt(ticket.id, expectedUpdatedAt))
    .returning({ id: tickets.id });
  if (expectedUpdatedAt && updated.length === 0) {
    // Lost the version check: no activity, no webhook.
    return { status: "conflict" };
  }

  const activityId = await insertActivity(
    snapshot,
    actor,
    now,
    newAgentId ? "assigned" : "unassigned",
    newAgentId
      ? { ...activityMetadata, agentId: newAgentId }
      : activityMetadata
        ? { ...activityMetadata }
        : null
  );

  const webhook = await awaitWebhook(
    "[webhook.assignment_changed]",
    dispatchWebhookEvent(
      newAgentId ? "ticket.assigned" : "ticket.unassigned",
      "ticket",
      ticket.id,
      {
        ticket: ticketPayloadData({
          id: ticket.id,
          ticketNumber: ticket.ticketNumber,
          subject: ticket.subject,
          status: ticket.status,
          priority: ticket.priority,
          category: ticket.category,
          customerName: customer.name,
          customerEmail: customer.email,
          createdAt: ticket.createdAt,
          updatedAt: now,
        }),
        assignedAgentId: newAgentId,
      }
    )
  );
  return { status: "changed", activityId, webhook };
}
