import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { user } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireAdminFromRequest } from "@/lib/authz";
import { db } from "@/lib/db";
import { getMcpToken, revokeMcpToken } from "@/lib/mcp-tokens";

// DELETE /api/admin/mcp/tokens/:id — revoke any user's token. Revoking an
// already-revoked token is a no-op that keeps the original revocation.
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
  const revoked = await revokeMcpToken({
    tokenId: id,
    reason: "revoked_by_admin",
  });

  if (!revoked) {
    const existing = await getMcpToken(id);
    if (!existing) {
      return NextResponse.json({ error: "Token not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  }

  const [owner] = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, revoked.userId))
    .limit(1);

  await audit({
    action: "mcp_token.revoked",
    actorEmail: admin.email,
    actorId: admin.id,
    description: `Revoked MCP token ${revoked.keyPrefix}… of ${owner?.email ?? revoked.userId}`,
    entityId: revoked.id,
    entityType: "mcp_token",
    metadata: {
      keyPrefix: revoked.keyPrefix,
      name: revoked.name,
      reason: "revoked_by_admin",
      targetUserId: revoked.userId,
      targetEmail: owner?.email ?? null,
    },
  });

  return NextResponse.json({ ok: true });
}
