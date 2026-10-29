import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getSessionUserFromRequest } from "@/lib/authz";
import { listOAuthGrantsForUser } from "@/lib/mcp/oauth-grants";
import { isEligibleMcpRole } from "@/lib/mcp-tokens";

// GET /api/account/mcp/oauth-grants — the apps the caller has connected to MCP
// over OAuth ("Connected apps"). Only their own; no token material exists here.
export async function GET(request: NextRequest) {
  const me = getSessionUserFromRequest(request);
  if (!me) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEligibleMcpRole(me.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const grants = await listOAuthGrantsForUser(me.id);
  return NextResponse.json({
    grants: grants.map((g) => ({
      id: g.id,
      clientId: g.clientId,
      clientName: g.clientName,
      clientUri: g.clientUri,
      scopes: g.scopes,
      grantedAt: g.grantedAt.toISOString(),
    })),
  });
}
