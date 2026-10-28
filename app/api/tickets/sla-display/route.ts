// SLA is currently hidden from the UI (see docs/tickets.md § SLA) — this
// whole route is disabled to match, so it can't be reached even by a direct
// request while there's no UI path to it (SlaDisplayPreferencesCard, the
// only caller, is itself commented out). Re-enable by restoring the code
// below alongside the other SLA re-enable steps in docs/tickets.md.
// import type { NextRequest } from "next/server";
// import { NextResponse } from "next/server";
// import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
// import { userTicketTablePrefs } from "@/db/schema/user-preferences";
// import { auth } from "@/lib/auth";
// import { db } from "@/lib/db";

// No handler exported while disabled — requests to this route 404.
export {};

/*
// /api/tickets/* is not covered by the proxy.ts middleware matcher, so we
// check the session directly here (same pattern as
// app/api/tickets/table-columns/route.ts) instead of the header-based
// requireAgentFromRequest helper, which only works for matcher-covered paths.
async function requireAgentSession(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return null;
  }
  if (session.user.role !== AGENT_ROLE && session.user.role !== ADMIN_ROLE) {
    return null;
  }
  return session;
}

// PATCH — save the caller's own "Show SLA & Overdue" ticket-list preference.
export async function PATCH(request: NextRequest) {
  const session = await requireAgentSession(request);
  if (!session) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: { showSlaAndOverdue?: unknown };
  try {
    body = (await request.json()) as { showSlaAndOverdue?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }

  if (typeof body.showSlaAndOverdue !== "boolean") {
    return NextResponse.json(
      { error: "Invalid preference value." },
      { status: 400 }
    );
  }

  const now = new Date();
  await db
    .insert(userTicketTablePrefs)
    .values({
      userId: session.user.id,
      showSlaAndOverdue: body.showSlaAndOverdue,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: userTicketTablePrefs.userId,
      set: { showSlaAndOverdue: body.showSlaAndOverdue, updatedAt: now },
    });

  return NextResponse.json({ showSlaAndOverdue: body.showSlaAndOverdue });
}
*/
