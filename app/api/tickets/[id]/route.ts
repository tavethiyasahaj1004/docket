import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_ROLE } from "@/config/platform";
import { tickets } from "@/db/schema";
import { audit } from "@/lib/audit";
import { auth } from "@/lib/auth";
import { db } from "@/lib/db";
import {
  deleteTicketsWithMergedShells,
  MERGED_TICKET_CHANGE_MESSAGE,
} from "@/lib/tickets/merge";
import { getTicketDetail } from "@/lib/tickets/queries";
import {
  assignTicket,
  changeTicketStatusGeneric,
  loadTicketForChange,
  setTicketCategory,
  setTicketPriority,
} from "@/lib/tickets/services/ticket-fields";
import type { ServiceActor } from "@/lib/tickets/services/types";

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

  const snapshot = await loadTicketForChange(ticketId);
  if (snapshot.status === "not_found") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  // Not forwarded: see MERGED_TICKET_CHANGE_MESSAGE in lib/tickets/merge.ts.
  if (snapshot.status === "merged") {
    return NextResponse.json(
      { error: MERGED_TICKET_CHANGE_MESSAGE },
      { status: 409 }
    );
  }

  const actor: ServiceActor = {
    id: session.user.id,
    name: session.user.name ?? session.user.email,
    role: session.user.role as ServiceActor["role"],
  };
  const now = new Date();

  let changed = false;

  // Status change
  if (body.status !== undefined) {
    const result = await changeTicketStatusGeneric({
      snapshot,
      actor,
      value: body.status,
      now,
    });
    if (result.status === "invalid") {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    changed ||= result.status === "changed";
  }

  // Category change
  if (body.category !== undefined) {
    const result = await setTicketCategory({
      snapshot,
      actor,
      value: body.category,
      now,
    });
    if (result.status === "invalid") {
      return NextResponse.json({ error: "Invalid category." }, { status: 400 });
    }
    changed ||= result.status === "changed";
  }

  // Priority change
  if (body.priority !== undefined) {
    const result = await setTicketPriority({
      snapshot,
      actor,
      value: body.priority,
      now,
    });
    if (result.status === "invalid") {
      return NextResponse.json({ error: "Invalid priority." }, { status: 400 });
    }
    changed ||= result.status === "changed";
  }

  // Assignment change
  if ("assignedAgentId" in body) {
    const result = await assignTicket({
      snapshot,
      actor,
      value: body.assignedAgentId ?? null,
      now,
    });
    changed ||= result.status === "changed";
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
