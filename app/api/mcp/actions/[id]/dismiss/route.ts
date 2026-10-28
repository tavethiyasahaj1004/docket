import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { dismissPendingAction } from "@/lib/mcp/pending-actions";

// Not behind the proxy's session gate (/api/mcp/* is outside its matcher), so
// this route checks the session itself.
const NOT_FOUND = { error: "Request not found." };

// POST /api/mcp/actions/:id/dismiss — the token owner declines a request their
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
    const result = await dismissPendingAction({
      actionId: id,
      userId: session.user.id,
    });
    switch (result.status) {
      case "dismissed":
        return NextResponse.json({ status: "dismissed" });
      case "not_pending":
        return NextResponse.json(
          { error: "This request is no longer pending." },
          { status: 409 }
        );
      default:
        return NextResponse.json(NOT_FOUND, { status: 404 });
    }
  } catch (err) {
    console.error("[POST /api/mcp/actions/[id]/dismiss]", err);
    return NextResponse.json(
      { error: "Something went wrong." },
      { status: 500 }
    );
  }
}
