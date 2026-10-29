import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { getSessionUserFromRequest } from "@/lib/authz";
import { db } from "@/lib/db";
import { grantRevokedAudit, revokeOAuthGrants } from "@/lib/mcp/oauth-grants";
import { cancelledActionAudit } from "@/lib/mcp/pending-actions-core";
import { isEligibleMcpRole } from "@/lib/mcp-tokens";

// DELETE /api/account/mcp/oauth-grants/:id — revoke one of the caller's own
// connected apps. The client's access tokens stop working on their next call
// and its refresh token is deleted. Someone else's grant looks the same as a
// missing one (404).
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
  const { revoked, cancelled } = await db.transaction((tx) =>
    revokeOAuthGrants(tx, { consentId: id, ownerId: me.id })
  );
  if (revoked.length === 0) {
    return NextResponse.json({ error: "Grant not found." }, { status: 404 });
  }

  for (const c of cancelled) {
    await audit(
      cancelledActionAudit(c, {
        actorEmail: me.email,
        actorId: me.id,
        reason: "token_revoked",
      })
    );
  }
  for (const g of revoked) {
    await audit(
      grantRevokedAudit(g, {
        actorEmail: me.email,
        actorId: me.id,
        reason: "revoked_by_user",
      })
    );
  }
  return NextResponse.json({ ok: true });
}
