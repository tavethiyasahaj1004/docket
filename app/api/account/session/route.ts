import { type NextRequest, NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/authz";

// Liveness probe for the caller's session, polled by SessionGuard to notice an
// expiry while a tab sits open. It does no work: the proxy already resolved the
// session and 401'd if absent, so reaching this handler *is* the "yes".
export const dynamic = "force-dynamic";

export function GET(request: NextRequest) {
  if (!getSessionUserFromRequest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  return new NextResponse(null, { status: 204 });
}
