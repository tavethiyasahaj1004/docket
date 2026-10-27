import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { getSessionUserFromRequest } from "@/lib/authz";
import {
  getMcpToken,
  isEligibleMcpRole,
  revokeMcpToken,
} from "@/lib/mcp-tokens";

// DELETE /api/account/mcp-tokens/:id — revoke one of the caller's own tokens.
// Someone else's token looks the same as a missing one (404). Revoking an
// already-revoked token is a no-op that keeps the original revocation.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const me = getSessionUserFromRequest(request);
  if (!me) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!isEligibleMcpRole(me.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;
  const revoked = await revokeMcpToken({
    tokenId: id,
    ownerId: me.id,
    reason: "revoked_by_user",
  });

  if (!revoked) {
    const existing = await getMcpToken(id, me.id);
    if (!existing) {
      return NextResponse.json({ error: "Token not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  }

  await audit({
    action: "mcp_token.revoked",
    actorEmail: me.email,
    actorId: me.id,
    description: `Revoked MCP token ${revoked.keyPrefix}…`,
    entityId: revoked.id,
    entityType: "mcp_token",
    metadata: {
      keyPrefix: revoked.keyPrefix,
      name: revoked.name,
      reason: "revoked_by_user",
    },
  });

  return NextResponse.json({ ok: true });
}
