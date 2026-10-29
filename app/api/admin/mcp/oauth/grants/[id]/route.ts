import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { requireAdminFromRequest } from "@/lib/authz";
import { db } from "@/lib/db";
import { grantRevokedAudit, revokeOAuthGrants } from "@/lib/mcp/oauth-grants";
import { cancelledActionAudit } from "@/lib/mcp/pending-actions-core";

// DELETE /api/admin/mcp/oauth/grants/:id — revoke any user's grant.
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let admin;
  try {
    admin = requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  const { id } = await params;
  const { revoked, cancelled } = await db.transaction((tx) =>
    revokeOAuthGrants(tx, { consentId: id })
  );
  if (revoked.length === 0) {
    return NextResponse.json({ error: "Grant not found." }, { status: 404 });
  }

  for (const c of cancelled) {
    await audit(
      cancelledActionAudit(c, {
        actorEmail: admin.email,
        actorId: admin.id,
        reason: "token_revoked",
      })
    );
  }
  for (const g of revoked) {
    await audit(
      grantRevokedAudit(g, {
        actorEmail: admin.email,
        actorId: admin.id,
        reason: "revoked_by_admin",
      })
    );
  }
  return NextResponse.json({ ok: true });
}
