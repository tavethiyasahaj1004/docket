"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { user } from "@/db/schema";
import { audit, auditOrThrow } from "@/lib/audit";
import { requireAdmin } from "@/lib/authz";
import { db } from "@/lib/db";
import { revokeAllMcpTokensForUser } from "@/lib/mcp-tokens";

export async function setUserRoleAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const role = String(formData.get("role") ?? AGENT_ROLE);

  if (![ADMIN_ROLE, AGENT_ROLE].includes(role)) {
    return;
  }
  if (userId === admin.id && role !== ADMIN_ROLE) {
    return;
  }

  await db
    .update(user)
    .set({ role, updatedAt: new Date() })
    .where(eq(user.id, userId));

  await audit({
    action: "orbit.user_role_updated",
    actorEmail: admin.email,
    actorId: admin.id,
    description: `Updated user role to ${role}`,
    entityId: userId,
    entityType: "user",
    metadata: { role },
  });

  revalidatePath("/orbit/users");
}

export async function toggleUserBanAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const userId = String(formData.get("userId") ?? "");
  const banned = String(formData.get("banned") ?? "false") === "true";

  if (userId === admin.id && banned) {
    return;
  }

  // Order matters: lock the user row first (blocks a concurrent MCP token
  // creation), revoke + audit the tokens with this admin as actor, and only THEN
  // set banned — so the trigger that revokes tokens on ban finds nothing left and
  // the actor audit is never skipped. An audit failure rolls the ban back.
  await db.transaction(async (tx) => {
    await tx
      .select({ id: user.id })
      .from(user)
      .where(eq(user.id, userId))
      .for("update");

    const revoked = banned
      ? await revokeAllMcpTokensForUser(tx, userId, "user_banned")
      : [];

    await tx
      .update(user)
      .set({
        banReason: banned ? "Disabled by Orbit admin" : null,
        banned,
        updatedAt: new Date(),
      })
      .where(eq(user.id, userId));

    for (const t of revoked) {
      await auditOrThrow(tx, {
        action: "mcp_token.revoked",
        actorEmail: admin.email,
        actorId: admin.id,
        description: `Revoked MCP token ${t.keyPrefix}… (user banned)`,
        entityId: t.id,
        entityType: "mcp_token",
        metadata: {
          keyPrefix: t.keyPrefix,
          name: t.name,
          reason: "user_banned",
          targetUserId: userId,
        },
      });
    }
  });

  await audit({
    action: banned ? "orbit.user_banned" : "orbit.user_unbanned",
    actorEmail: admin.email,
    actorId: admin.id,
    description: banned ? "Banned user" : "Unbanned user",
    entityId: userId,
    entityType: "user",
  });

  revalidatePath("/orbit/users");
}
