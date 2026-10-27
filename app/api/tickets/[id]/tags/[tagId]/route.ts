import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { resolveMergedTicketId } from "@/lib/tickets/merge";
import { removeTagFromTicket } from "@/lib/tickets/services/tags";
import type { ServiceActor } from "@/lib/tickets/services/types";

// DELETE /api/tickets/[id]/tags/[tagId] — agent/admin only. Unlinks the tag
// from this ticket; the tag itself stays in the shared pool for reuse.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; tagId: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (
    !session?.user ||
    (session.user.role !== "agent" && session.user.role !== "admin")
  ) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: requestedTicketId, tagId } = await params;
  // A merged ticket forwards to the ticket it was merged into (lib/tickets/merge.ts).
  const ticketId = await resolveMergedTicketId(requestedTicketId);

  const result = await removeTagFromTicket({
    ticketId,
    tagId,
    actor: {
      id: session.user.id,
      name: session.user.name ?? session.user.email,
      role: session.user.role as ServiceActor["role"],
    },
  });
  if (result.status === "not_linked") {
    return NextResponse.json(
      { error: "Tag not found on ticket." },
      { status: 404 }
    );
  }

  return NextResponse.json({ ok: true });
}
