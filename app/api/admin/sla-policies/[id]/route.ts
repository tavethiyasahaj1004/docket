// SLA is currently hidden from the UI (see docs/tickets.md § SLA) — this
// whole route is disabled to match, so it can't be reached even by a direct
// request while there's no UI path to it. Re-enable by restoring the code
// below alongside the other SLA re-enable steps in docs/tickets.md.
// import { eq } from "drizzle-orm";
// import type { NextRequest } from "next/server";
// import { NextResponse } from "next/server";
// import { slaPolicies } from "@/db/schema";
// import { audit } from "@/lib/audit";
// import { requireAdminFromRequest } from "@/lib/authz";
// import { db } from "@/lib/db";
// import { getTicketCategories, getTicketPriorities } from "@/lib/ticket-config";

// No handlers exported while disabled — requests to this route 404.
export {};

/*
interface PolicyPatchBody {
  category?: string | null;
  firstResponseMinutes?: number;
  isDefault?: boolean;
  name?: string;
  nextResponseMinutes?: number;
  priority?: string | null;
  resolutionMinutes?: number;
  sortOrder?: number;
}

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

  let body: PolicyPatchBody = {};
  try {
    body = (await request.json()) as PolicyPatchBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }

  const [existing] = await db
    .select()
    .from(slaPolicies)
    .where(eq(slaPolicies.id, id))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const nextPriority =
    body.priority === undefined
      ? existing.priority
      : body.priority?.trim() || null;
  const nextCategory =
    body.category === undefined
      ? existing.category
      : body.category?.trim() || null;

  if (nextPriority) {
    const priorities = await getTicketPriorities();
    if (!priorities.some((p) => p.slug === nextPriority)) {
      return NextResponse.json({ error: "Invalid priority." }, { status: 400 });
    }
  }
  if (nextCategory) {
    const categories = await getTicketCategories();
    if (!categories.some((c) => c.slug === nextCategory)) {
      return NextResponse.json({ error: "Invalid category." }, { status: 400 });
    }
  }

  const nextIsDefault = body.isDefault ?? existing.isDefault;
  if (nextIsDefault && (nextPriority || nextCategory)) {
    return NextResponse.json(
      {
        error:
          "Only an unscoped (Any priority / Any category) policy can be the default.",
      },
      { status: 400 }
    );
  }

  for (const [field, value] of [
    ["firstResponseMinutes", body.firstResponseMinutes],
    ["nextResponseMinutes", body.nextResponseMinutes],
    ["resolutionMinutes", body.resolutionMinutes],
  ] as const) {
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      return NextResponse.json(
        { error: `${field} must be a positive integer.` },
        { status: 400 }
      );
    }
  }

  // If the (priority, category) scope is changing, make sure it doesn't
  // collide with another policy's scope.
  const allPolicies = await db.select().from(slaPolicies);
  const scopeTaken = allPolicies.some(
    (p) =>
      p.id !== id && p.priority === nextPriority && p.category === nextCategory
  );
  if (scopeTaken) {
    return NextResponse.json(
      {
        error:
          "A policy with this exact priority/category scope already exists.",
      },
      { status: 400 }
    );
  }

  const now = new Date();

  if (body.isDefault === true && !existing.isDefault) {
    await db
      .update(slaPolicies)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(slaPolicies.isDefault, true));
  }

  const updateData: Partial<typeof slaPolicies.$inferInsert> & {
    updatedAt: Date;
  } = { updatedAt: now };
  if (body.name !== undefined) {
    updateData.name = body.name.trim();
  }
  if (body.priority !== undefined) {
    updateData.priority = nextPriority;
  }
  if (body.category !== undefined) {
    updateData.category = nextCategory;
  }
  if (body.firstResponseMinutes !== undefined) {
    updateData.firstResponseMinutes = body.firstResponseMinutes;
  }
  if (body.nextResponseMinutes !== undefined) {
    updateData.nextResponseMinutes = body.nextResponseMinutes;
  }
  if (body.resolutionMinutes !== undefined) {
    updateData.resolutionMinutes = body.resolutionMinutes;
  }
  if (body.isDefault !== undefined) {
    updateData.isDefault = body.isDefault;
  }
  if (body.sortOrder !== undefined) {
    updateData.sortOrder = body.sortOrder;
  }

  const [updated] = await db
    .update(slaPolicies)
    .set(updateData)
    .where(eq(slaPolicies.id, id))
    .returning();

  await audit({
    action: "sla_policy.updated",
    actorEmail: admin.email,
    actorId: admin.id,
    description: `Updated SLA policy "${existing.name}"`,
    entityId: id,
    entityType: "sla_policy",
    metadata: { changes: body },
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
    .from(slaPolicies)
    .where(eq(slaPolicies.id, id))
    .limit(1);
  if (!existing) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  if (existing.isDefault) {
    return NextResponse.json(
      {
        error:
          "Cannot delete the default policy. Set another policy as default first.",
      },
      { status: 400 }
    );
  }

  await db.delete(slaPolicies).where(eq(slaPolicies.id, id));

  await audit({
    action: "sla_policy.deleted",
    actorEmail: admin.email,
    actorId: admin.id,
    description: `Deleted SLA policy "${existing.name}"`,
    entityId: id,
    entityType: "sla_policy",
    metadata: { name: existing.name },
  });

  return NextResponse.json({ ok: true });
}
*/
