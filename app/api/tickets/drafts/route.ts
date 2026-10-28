import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { auth } from "@/lib/auth";
import { getDraftTicketIds } from "@/lib/tickets/reply-drafts";

// One list page's worth of ids is plenty; caps the IN (...) list.
const MAX_IDS = 200;

// GET /api/tickets/drafts?ids=a,b,c — which of these tickets the caller has an
// unsent reply draft on. The ticket list re-checks this on mount: a page
// restored by browser Back/Forward comes from Next's client router cache, not
// the server, so its server-rendered "Draft" markers predate any draft typed
// since. /api/tickets/* isn't covered by proxy.ts, so the session is checked
// here (same pattern as app/api/tickets/[id]/draft/route.ts).
export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (
    !session?.user ||
    (session.user.role !== AGENT_ROLE && session.user.role !== ADMIN_ROLE)
  ) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const ids = (request.nextUrl.searchParams.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .slice(0, MAX_IDS);
  const draftIds = await getDraftTicketIds(ids, session.user.id);
  return NextResponse.json(
    { ticketIds: [...draftIds] },
    { headers: { "Cache-Control": "no-store" } }
  );
}
