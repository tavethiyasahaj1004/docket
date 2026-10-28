import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  approvePendingAction,
  type PendingActionFailure,
} from "@/lib/mcp/pending-actions";

// Not behind the proxy's session gate (/api/mcp/* is outside its matcher), so
// this route checks the session itself.
const NOT_FOUND = { error: "Request not found." };

const FAILURE_MESSAGES: Record<PendingActionFailure, string> = {
  ticket_merged:
    "The ticket was merged into another ticket, so this request wasn't carried out.",
  ticket_closed: "The ticket is closed, so the reply wasn't sent.",
  ticket_not_found: "The ticket no longer exists.",
  no_closed_status:
    "No closed status is configured, so the ticket wasn't closed.",
};

// POST /api/mcp/actions/:id/approve — the token owner approves a request their
// AI assistant made. Anyone else (another agent, an admin, no session) gets the
// same 404 as an unknown id.
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  // An admin impersonating the owner is not the owner (the same rule that keeps
  // an impersonated session from creating a token).
  if (!session?.user || session.session?.impersonatedBy) {
    return NextResponse.json(NOT_FOUND, { status: 404 });
  }

  const { id } = await params;
  try {
    const result = await approvePendingAction({
      actionId: id,
      userId: session.user.id,
    });
    switch (result.status) {
      case "approved":
        return NextResponse.json({
          status: "approved",
          outcome: result.outcome,
        });
      case "not_found":
        return NextResponse.json(NOT_FOUND, { status: 404 });
      case "not_pending":
        return NextResponse.json(
          { error: "This request is no longer pending." },
          { status: 409 }
        );
      case "failed":
        return NextResponse.json(
          { error: FAILURE_MESSAGES[result.reason] },
          { status: 409 }
        );
      default:
        return NextResponse.json(
          { error: "Something went wrong." },
          { status: 500 }
        );
    }
  } catch (err) {
    console.error("[POST /api/mcp/actions/[id]/approve]", err);
    return NextResponse.json(
      { error: "Something went wrong." },
      { status: 500 }
    );
  }
}
