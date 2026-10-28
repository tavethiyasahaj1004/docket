import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { audit } from "@/lib/audit";
import { getSessionUserFromRequest } from "@/lib/authz";
import { db } from "@/lib/db";
import {
  cancelledActionAudit,
  cancelPendingActionsForLiveTokens,
} from "@/lib/mcp/pending-actions-core";
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
  // Cancel the token's pending approval requests first (once it is revoked they
  // no longer match). `ownerId` keeps this to the caller's own token.
  const cancelled = await cancelPendingActionsForLiveTokens(db, {
    tokenId: id,
    ownerId: me.id,
  });
  for (const c of cancelled) {
    await audit(
      cancelledActionAudit(c, {
        actorEmail: me.email,
        actorId: me.id,
        reason: "token_revoked",
      })
    );
  }
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
