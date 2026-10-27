import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { normalizeTagName } from "@/lib/tags";
import { resolveMergedTicketId } from "@/lib/tickets/merge";
import { addTagToTicket } from "@/lib/tickets/services/tags";
import type { ServiceActor } from "@/lib/tickets/services/types";

const MAX_TAG_LENGTH = 50;

// POST /api/tickets/[id]/tags — agent/admin only. Body: { name: string }.
// Find-or-creates the tag in the shared pool, then links it to this ticket
// (idempotent — adding an already-linked tag is a no-op, not an error).
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (
    !session?.user ||
    (session.user.role !== "agent" && session.user.role !== "admin")
  ) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const { id: requestedTicketId } = await params;
  // A merged ticket forwards to the ticket it was merged into (lib/tickets/merge.ts).
  const ticketId = await resolveMergedTicketId(requestedTicketId);
  let body: { name?: string } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }

  const name = normalizeTagName(body.name ?? "");
  if (!name) {
    return NextResponse.json(
      { error: "Tag name is required." },
      { status: 400 }
    );
  }
  if (name.length > MAX_TAG_LENGTH) {
    return NextResponse.json(
      { error: `Tag name must be ${MAX_TAG_LENGTH} characters or fewer.` },
      { status: 400 }
    );
  }

  const result = await addTagToTicket({
    ticketId,
    actor: {
      id: session.user.id,
      name: session.user.name ?? session.user.email,
      role: session.user.role as ServiceActor["role"],
    },
    name,
  });
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  return NextResponse.json(result.tags);
}
