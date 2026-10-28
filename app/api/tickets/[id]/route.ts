import { createId } from "@paralleldrive/cuid2";
import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_ROLE } from "@/config/platform";
import { customers, ticketActivity, tickets } from "@/db/schema";
import { audit } from "@/lib/audit";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  getTicketCategories,
  getTicketPriorities,
  getTicketStatuses,
} from "@/lib/ticket-config";
import {
  deleteTicketsWithMergedShells,
  MERGED_TICKET_CHANGE_MESSAGE,
} from "@/lib/tickets/merge";
import { notifyTicketStatusChange } from "@/lib/tickets/notify-status-change";
import { getTicketDetail } from "@/lib/tickets/queries";
import {
  dispatchWebhookEvent,
  ticketPayloadData,
} from "@/lib/webhooks/dispatch";

async function requireAgentSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return null;
  }
  if (session.user.role !== "agent" && session.user.role !== "admin") {
    return null;
  }
  return session;
}

// GET /api/tickets/[id] — agent view (no customerToken)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAgentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: requestedId } = await params;
  const ticket = await getTicketDetail(requestedId);
  if (!ticket) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  return NextResponse.json(ticket);
}

// PATCH /api/tickets/[id] — update status, category, or assignedAgentId
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await requireAgentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: ticketId } = await params;
  let body: {
    status?: string;
    category?: string;
    priority?: string;
    assignedAgentId?: string | null;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }

  const [ticket] = await db
    .select()
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!ticket) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // Not forwarded: see MERGED_TICKET_CHANGE_MESSAGE in lib/tickets/merge.ts.
  if (ticket.mergedIntoTicketId) {
    return NextResponse.json(
      { error: MERGED_TICKET_CHANGE_MESSAGE },
      { status: 409 }
    );
  }

  const [customer] = await db
    .select({ name: customers.name, email: customers.email })
    .from(customers)
    .where(eq(customers.id, ticket.customerId))
    .limit(1);
  if (!customer) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const actorId = session.user.id;
  const actorName = session.user.name ?? session.user.email;
  const actorRole = session.user.role!;
  const now = new Date();

  let changed = false;

  // Status change
  if (body.status !== undefined && body.status !== ticket.status) {
    const validStatuses = await getTicketStatuses();
    const statusRow = validStatuses.find((s) => s.slug === body.status);
    if (!statusRow) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    const previousStatus = ticket.status;
    const newStatus = body.status;

    await db
      .update(tickets)
      .set({
        status: newStatus,
        closedAt: statusRow.isClosedState ? now : null,
        updatedAt: now,
      })
      .where(and(eq(tickets.id, ticketId), isNull(tickets.mergedIntoTicketId)));

    await db.insert(ticketActivity).values({
      id: createId(),
      ticketId,
      actorId,
      actorName,
      actorRole,
      action: statusRow.isClosedState ? "ticket_closed" : "status_changed",
      metadata: { from: previousStatus, to: newStatus },
      createdAt: now,
    });
    changed = true;

    // Notify any configured outbound webhooks — routed through the same
    // helper the dedicated /close and /reopen routes use, so closing via
    // this generic PATCH (e.g. the sidebar status dropdown) still fires the
    // same ticket.closed/ticket.reopened event an integrator would expect.
    const previousStatusRow = validStatuses.find(
      (s) => s.slug === previousStatus
    );
    await notifyTicketStatusChange(
      {
        id: ticketId,
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
    ).catch((err) => console.error("[webhook.status_changed]", err));
  }

  // Category change
  if (body.category !== undefined && body.category !== ticket.category) {
    const validCategories = await getTicketCategories();
    if (!validCategories.some((c) => c.slug === body.category)) {
      return NextResponse.json({ error: "Invalid category." }, { status: 400 });
    }
    const previousCategory = ticket.category;
    const newCategory = body.category;

    await db
      .update(tickets)
      .set({ category: newCategory, updatedAt: now })
      .where(and(eq(tickets.id, ticketId), isNull(tickets.mergedIntoTicketId)));

    await db.insert(ticketActivity).values({
      id: createId(),
      ticketId,
      actorId,
      actorName,
      actorRole,
      action: "category_changed",
      metadata: { from: previousCategory, to: newCategory },
      createdAt: now,
    });
    changed = true;

    await dispatchWebhookEvent("ticket.category_changed", "ticket", ticketId, {
      ticket: ticketPayloadData({
        id: ticketId,
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
    }).catch((err) => console.error("[webhook.category_changed]", err));
  }

  // Priority change
  if (body.priority !== undefined && body.priority !== ticket.priority) {
    const validPriorities = await getTicketPriorities();
    if (!validPriorities.some((p) => p.slug === body.priority)) {
      return NextResponse.json({ error: "Invalid priority." }, { status: 400 });
    }
    const previousPriority = ticket.priority;
    const newPriority = body.priority;

    await db
      .update(tickets)
      .set({ priority: newPriority, updatedAt: now })
      .where(and(eq(tickets.id, ticketId), isNull(tickets.mergedIntoTicketId)));

    await db.insert(ticketActivity).values({
      id: createId(),
      ticketId,
      actorId,
      actorName,
      actorRole,
      action: "priority_changed",
      metadata: { from: previousPriority, to: newPriority },
      createdAt: now,
    });
    changed = true;

    await dispatchWebhookEvent("ticket.priority_changed", "ticket", ticketId, {
      ticket: ticketPayloadData({
        id: ticketId,
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
    }).catch((err) => console.error("[webhook.priority_changed]", err));
  }

  // Assignment change
  if ("assignedAgentId" in body) {
    const newAgentId = body.assignedAgentId ?? null;
    if (newAgentId !== ticket.assignedAgentId) {
      await db
        .update(tickets)
        .set({ assignedAgentId: newAgentId, updatedAt: now })
        .where(
          and(eq(tickets.id, ticketId), isNull(tickets.mergedIntoTicketId))
        );

      await db.insert(ticketActivity).values({
        id: createId(),
        ticketId,
        actorId,
        actorName,
        actorRole,
        action: newAgentId ? "assigned" : "unassigned",
        metadata: newAgentId ? { agentId: newAgentId } : null,
        createdAt: now,
      });
      changed = true;

      await dispatchWebhookEvent(
        newAgentId ? "ticket.assigned" : "ticket.unassigned",
        "ticket",
        ticketId,
        {
          ticket: ticketPayloadData({
            id: ticketId,
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
      ).catch((err) => console.error("[webhook.assignment_changed]", err));
    }
  }

  return NextResponse.json({ ok: true, changed });
}

// DELETE /api/tickets/[id] — hard delete ticket + storage cleanup (admin only)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user || session.user.role !== ADMIN_ROLE) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: ticketId } = await params;

  const [ticket] = await db
    .select({ id: tickets.id, ticketNumber: tickets.ticketNumber })
    .from(tickets)
    .where(eq(tickets.id, ticketId))
    .limit(1);
  if (!ticket) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Storage files first, then the ticket and every ticket merged into it.
  await deleteTicketsWithMergedShells([ticketId]);

  await audit({
    action: "ticket.deleted",
    actorEmail: session.user.email,
    actorId: session.user.id,
    description: `Deleted ticket #${ticket.ticketNumber}`,
    entityId: ticketId,
    entityType: "ticket",
    metadata: { ticketNumber: ticket.ticketNumber },
  });

  return NextResponse.json({ ok: true });
}
