// SLA is currently hidden from the UI (see docs/tickets.md § SLA) — this
// whole route is disabled to match, so it can't be reached even by a direct
// request while there's no UI path to it. Re-enable by restoring the code
// below alongside the other SLA re-enable steps in docs/tickets.md.
// import { createId } from "@paralleldrive/cuid2";
// import { asc, eq } from "drizzle-orm";
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
interface PolicyBody {
  category?: string | null;
  firstResponseMinutes?: number;
  isDefault?: boolean;
  name?: string;
  nextResponseMinutes?: number;
  priority?: string | null;
  resolutionMinutes?: number;
}

// Validates the shared fields of a create/update body. Returns either the
// normalized values or an error response to return as-is.
async function validatePolicyBody(body: PolicyBody): Promise<
  | {
      ok: true;
      name: string;
      priority: string | null;
      category: string | null;
      firstResponseMinutes: number;
      nextResponseMinutes: number;
      resolutionMinutes: number;
    }
  | { ok: false; error: string }
> {
  const name = body.name?.trim();
  if (!name) {
    return { ok: false, error: "Name is required." };
  }

  const priority = body.priority?.trim() || null;
  const category = body.category?.trim() || null;

  if (priority) {
    const priorities = await getTicketPriorities();
    if (!priorities.some((p) => p.slug === priority)) {
      return { ok: false, error: "Invalid priority." };
    }
  }
  if (category) {
    const categories = await getTicketCategories();
    if (!categories.some((c) => c.slug === category)) {
      return { ok: false, error: "Invalid category." };
    }
  }

  const minuteFields: Array<[string, number | undefined]> = [
    ["firstResponseMinutes", body.firstResponseMinutes],
    ["nextResponseMinutes", body.nextResponseMinutes],
    ["resolutionMinutes", body.resolutionMinutes],
  ];
  for (const [field, value] of minuteFields) {
    if (!Number.isInteger(value) || (value as number) <= 0) {
      return { ok: false, error: `${field} must be a positive integer.` };
    }
  }

  if (body.isDefault && (priority || category)) {
    return {
      ok: false,
      error:
        "Only an unscoped (Any priority / Any category) policy can be the default.",
    };
  }

  return {
    ok: true,
    name,
    priority,
    category,
    firstResponseMinutes: body.firstResponseMinutes as number,
    nextResponseMinutes: body.nextResponseMinutes as number,
    resolutionMinutes: body.resolutionMinutes as number,
  };
}

// GET — agent/admin can read (middleware already enforced access)
export async function GET(_request: NextRequest) {
  const policies = await db
    .select()
    .from(slaPolicies)
    .orderBy(asc(slaPolicies.sortOrder));

  return NextResponse.json(policies);
}

// POST — admin only
export async function POST(request: NextRequest) {
  let admin;
  try {
    admin = requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  let body: PolicyBody = {};
  try {
    body = (await request.json()) as PolicyBody;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }

  const validated = await validatePolicyBody(body);
  if (!validated.ok) {
    return NextResponse.json({ error: validated.error }, { status: 400 });
  }

  const existingPolicies = await db.select().from(slaPolicies);
  const scopeTaken = existingPolicies.some(
    (p) =>
      p.priority === validated.priority && p.category === validated.category
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
  const isDefault = body.isDefault ?? false;

  if (isDefault) {
    await db
      .update(slaPolicies)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(slaPolicies.isDefault, true));
  }

  const nextSort =
    existingPolicies.length > 0
      ? Math.max(...existingPolicies.map((p) => p.sortOrder)) + 1
      : 0;

  const [inserted] = await db
    .insert(slaPolicies)
    .values({
      id: createId(),
      name: validated.name,
      priority: validated.priority,
      category: validated.category,
      firstResponseMinutes: validated.firstResponseMinutes,
      nextResponseMinutes: validated.nextResponseMinutes,
      resolutionMinutes: validated.resolutionMinutes,
      isDefault,
      sortOrder: nextSort,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  await audit({
    action: "sla_policy.created",
    actorEmail: admin.email,
    actorId: admin.id,
    description: `Created SLA policy "${validated.name}"`,
    entityId: inserted.id,
    entityType: "sla_policy",
    metadata: {
      name: validated.name,
      priority: validated.priority,
      category: validated.category,
      isDefault,
    },
  });

  return NextResponse.json(inserted, { status: 201 });
}
*/
