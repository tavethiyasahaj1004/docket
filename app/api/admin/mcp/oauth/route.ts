import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { requireAdminFromRequest } from "@/lib/authz";
import { listAllOAuthGrants, listOAuthClients } from "@/lib/mcp/oauth-grants";

// GET /api/admin/mcp/oauth — every known OAuth client and every user's grants
// (read-only; admins can revoke a grant but not create clients or grants).
export async function GET(request: NextRequest) {
  try {
    requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  const [clients, grants] = await Promise.all([
    listOAuthClients(),
    listAllOAuthGrants(),
  ]);
  return NextResponse.json({
    clients: clients.map((c) => ({
      clientId: c.clientId,
      name: c.name,
      uri: c.uri,
      disabled: c.disabled,
      createdAt: c.createdAt?.toISOString() ?? null,
      grantCount: c.grantCount,
    })),
    grants: grants.map((g) => ({
      id: g.id,
      clientId: g.clientId,
      clientName: g.clientName,
      scopes: g.scopes,
      grantedAt: g.grantedAt.toISOString(),
      owner: g.owner,
    })),
  });
}
