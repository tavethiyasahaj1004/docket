import { and, count, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ticketPriorities, tickets } from "@/db/schema";
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
    .from(ticketPriorities)
    .where(eq(ticketPriorities.id, id))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const now = new Date();

  // If setting as default, unset current default first
  if (body.isDefault === true && !existing.isDefault) {
    await db
      .update(ticketPriorities)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(ticketPriorities.isDefault, true));
  }

  const updateData: Partial<typeof ticketPriorities.$inferInsert> & {
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

  const [updated] = await db
    .update(ticketPriorities)
    .set(updateData)
    .where(eq(ticketPriorities.id, id))
    .returning();

  await audit({
    action: "ticket_config.priority_updated",
    actorEmail: admin.email,
    actorId: admin.id,
    description: `Updated priority "${existing.label}"`,
    entityId: id,
    entityType: "ticket_priority",
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
    .from(ticketPriorities)
    .where(eq(ticketPriorities.id, id))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (existing.isDefault) {
    return NextResponse.json(
      {
        error:
          "Cannot delete the default priority. Set another priority as default first.",
      },
      { status: 400 }
    );
  }

  // Check ticket usage. Merged tickets are hidden and not counted — they're
  // moved off this priority below, right before the delete.
  const [{ total: ticketCount }] = await db
    .select({ total: count() })
    .from(tickets)
    .where(
      and(
        eq(tickets.priority, existing.slug),
        isNull(tickets.mergedIntoTicketId)
      )
    );

  if (Number(ticketCount) > 0) {
    return NextResponse.json(
      { error: `Cannot delete: ${ticketCount} ticket(s) use this priority.` },
      { status: 400 }
    );
  }

  // Check if it's the only priority
  const [{ total: priorityCount }] = await db
    .select({ total: count() })
    .from(ticketPriorities);
  if (Number(priorityCount) <= 1) {
    return NextResponse.json(
      { error: "Cannot delete the only priority." },
      { status: 400 }
    );
  }

  await moveMergedTicketsOffSlug("priority", existing.slug);

  await db.delete(ticketPriorities).where(eq(ticketPriorities.id, id));

  await audit({
    action: "ticket_config.priority_deleted",
    actorEmail: admin.email,
    actorId: admin.id,
    description: `Deleted priority "${existing.label}"`,
    entityId: id,
    entityType: "ticket_priority",
    metadata: { slug: existing.slug, label: existing.label },
  });

  return NextResponse.json({ ok: true });
}
