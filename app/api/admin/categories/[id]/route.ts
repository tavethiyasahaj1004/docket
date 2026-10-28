import { and, count, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ticketCategories, tickets } from "@/db/schema";
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

  let body: { label?: string; color?: string; sortOrder?: number } = {};
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
    .from(ticketCategories)
    .where(eq(ticketCategories.id, id))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const now = new Date();
  const updateData: Partial<typeof ticketCategories.$inferInsert> & {
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

  const [updated] = await db
    .update(ticketCategories)
    .set(updateData)
    .where(eq(ticketCategories.id, id))
    .returning();

  await audit({
    action: "ticket_config.category_updated",
    actorEmail: admin.email,
    actorId: admin.id,
    description: `Updated category "${existing.label}"`,
    entityId: id,
    entityType: "ticket_category",
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
    .from(ticketCategories)
    .where(eq(ticketCategories.id, id))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  // Check ticket usage. Merged tickets are hidden and not counted — they're
  // moved off this category below, right before the delete.
  const [{ total: ticketCount }] = await db
    .select({ total: count() })
    .from(tickets)
    .where(
      and(
        eq(tickets.category, existing.slug),
        isNull(tickets.mergedIntoTicketId)
      )
    );

  if (Number(ticketCount) > 0) {
    return NextResponse.json(
      { error: `Cannot delete: ${ticketCount} ticket(s) use this category.` },
      { status: 400 }
    );
  }

  // Check if it's the last category
  const [{ total: catCount }] = await db
    .select({ total: count() })
    .from(ticketCategories);
  if (Number(catCount) <= 1) {
    return NextResponse.json(
      { error: "Cannot delete the only category." },
      { status: 400 }
    );
  }

  await moveMergedTicketsOffSlug("category", existing.slug);

  await db.delete(ticketCategories).where(eq(ticketCategories.id, id));

  await audit({
    action: "ticket_config.category_deleted",
    actorEmail: admin.email,
    actorId: admin.id,
    description: `Deleted category "${existing.label}"`,
    entityId: id,
    entityType: "ticket_category",
    metadata: { slug: existing.slug, label: existing.label },
  });

  return NextResponse.json({ ok: true });
}
