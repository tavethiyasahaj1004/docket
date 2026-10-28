import { and, count, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ticketStatuses, tickets } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAdminFromRequest } from "@/lib/authz";
import { db } from "@/lib/db";
import { moveMergedTicketsOffSlug } from "@/lib/tickets/merge";

// PATCH — admin only
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let admin;
  try {
    admin = requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  const { id } = await params;

  let body: {
    label?: string;
    color?: string;
    sortOrder?: number;
    isDefault?: boolean;
    isClosedState?: boolean;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }

  const [existing] = await db
    .select()
    .from(ticketStatuses)
    .where(eq(ticketStatuses.id, id))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const now = new Date();

  // If setting as default, unset current default first
  if (body.isDefault === true && !existing.isDefault) {
    await db
      .update(ticketStatuses)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(ticketStatuses.isDefault, true));
  }

  const updateData: Partial<typeof ticketStatuses.$inferInsert> & {
    updatedAt: Date;
  } = {
    updatedAt: now,
  };
  if (body.label !== undefined) {
    updateData.label = body.label.trim();
  }
  if (body.color !== undefined) {
    updateData.color = body.color;
  }
  if (body.sortOrder !== undefined) {
    updateData.sortOrder = body.sortOrder;
  }
  if (body.isDefault !== undefined) {
    updateData.isDefault = body.isDefault;
  }
  if (body.isClosedState !== undefined) {
    updateData.isClosedState = body.isClosedState;
  }

  const [updated] = await db
    .update(ticketStatuses)
    .set(updateData)
    .where(eq(ticketStatuses.id, id))
    .returning();

  await audit({
    action: "ticket_config.status_updated",
    actorEmail: admin.email,
    actorId: admin.id,
    description: `Updated status "${existing.label}"`,
    entityId: id,
    entityType: "ticket_status",
    metadata: { slug: existing.slug, changes: body },
  });

  return NextResponse.json(updated);
}

// DELETE — admin only
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let admin;
  try {
    admin = requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  const { id } = await params;

  const [existing] = await db
    .select()
    .from(ticketStatuses)
    .where(eq(ticketStatuses.id, id))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (existing.isDefault) {
    return NextResponse.json(
      {
        error:
          "Cannot delete the default status. Set another status as default first.",
      },
      { status: 400 }
    );
  }

  // Check ticket usage. Merged tickets are hidden and not counted — they're
  // moved off this status below, right before the delete.
  const [{ total: ticketCount }] = await db
    .select({ total: count() })
    .from(tickets)
    .where(
      and(eq(tickets.status, existing.slug), isNull(tickets.mergedIntoTicketId))
    );

  if (Number(ticketCount) > 0) {
    return NextResponse.json(
      { error: `Cannot delete: ${ticketCount} ticket(s) use this status.` },
      { status: 400 }
    );
  }

  // Check if it's the only status
  const [{ total: statusCount }] = await db
    .select({ total: count() })
    .from(ticketStatuses);
  if (Number(statusCount) <= 1) {
    return NextResponse.json(
      { error: "Cannot delete the only status." },
      { status: 400 }
    );
  }

  if (!(await moveMergedTicketsOffSlug("status", existing.slug))) {
    return NextResponse.json(
      {
        error:
          "Cannot delete: merged tickets use this status and there's no other closed status to move them to.",
      },
      { status: 400 }
    );
  }

  await db.delete(ticketStatuses).where(eq(ticketStatuses.id, id));

  await audit({
    action: "ticket_config.status_deleted",
    actorEmail: admin.email,
    actorId: admin.id,
    description: `Deleted status "${existing.label}"`,
    entityId: id,
    entityType: "ticket_status",
    metadata: { slug: existing.slug, label: existing.label },
  });

  return NextResponse.json({ ok: true });
}
