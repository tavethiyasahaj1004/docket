import { APIError } from "better-auth/api";
import { count, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { ADMIN_ROLE, AGENT_ROLE } from "@/config/platform";
import { account, session, user } from "@/db/schema";
import { tickets } from "@/db/schema/tickets";
import { audit, auditOrThrow } from "@/lib/audit";
import { auth } from "@/lib/auth";
import { requireAdminFromRequest } from "@/lib/authz";
import { db } from "@/lib/db";
import { grantRevokedAudit, revokeOAuthGrants } from "@/lib/mcp/oauth-grants";
import {
  cancelledActionAudit,
  cancelPendingActionsForLiveTokens,
} from "@/lib/mcp/pending-actions-core";
import { revokeAllMcpTokensForUser } from "@/lib/mcp-tokens";
import { getPlatformSettings } from "@/lib/settings";
import { anonymizeUserContent } from "@/lib/user-deletion";

async function getAdminCount() {
  const [{ total }] = await db
    .select({ total: count() })
    .from(user)
    .where(eq(user.role, ADMIN_ROLE));
  return total;
}

// PATCH /api/users/[id] — update role or ban status (admin only)
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let adminUser;
  try {
    adminUser = requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  const { id } = await params;

  const [target] = await db.select().from(user).where(eq(user.id, id)).limit(1);
  if (!target) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  let body: {
    role?: string;
    banned?: boolean;
    banReason?: string;
    password?: string;
  } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 }
    );
  }

  const now = new Date();

  // Role change
  if (body.role !== undefined) {
    if (body.role !== AGENT_ROLE && body.role !== ADMIN_ROLE) {
      return NextResponse.json({ error: "Invalid role." }, { status: 400 });
    }

    // Last admin protection: cannot demote the only admin
    if (target.role === ADMIN_ROLE && body.role !== ADMIN_ROLE) {
      const adminCount = await getAdminCount();
      if (adminCount <= 1) {
        return NextResponse.json(
          {
            error: "Cannot demote the last admin. Promote another user first.",
          },
          { status: 422 }
        );
      }
    }

    await db
      .update(user)
      .set({ role: body.role, updatedAt: now })
      .where(eq(user.id, id));

    await audit({
      action: "user.role_updated",
      actorEmail: adminUser.email,
      actorId: adminUser.id,
      description: `Role changed for ${target.email}: ${target.role} → ${body.role}`,
      entityId: id,
      entityType: "user",
      metadata: { from: target.role, to: body.role, targetEmail: target.email },
    });

    return NextResponse.json({ ok: true });
  }

  // Ban / unban
  if (body.banned !== undefined) {
    // Cannot ban yourself
    if (id === adminUser.id && body.banned) {
      return NextResponse.json(
        { error: "You cannot ban yourself." },
        { status: 422 }
      );
    }

    // Order matters. Lock the user row first (this blocks a concurrent MCP token
    // creation, which takes FOR SHARE on it), revoke + audit the tokens with the
    // admin as actor, and only THEN set banned — so the database trigger that
    // revokes tokens on ban finds nothing left and the actor audit is never
    // skipped. An audit failure rolls the whole ban back.
    try {
      await db.transaction(async (tx) => {
        await tx
          .select({ id: user.id })
          .from(user)
          .where(eq(user.id, id))
          .for("update");

        // Pending approval requests are cancelled first: once the tokens are
        // revoked they no longer match.
        const cancelled = body.banned
          ? await cancelPendingActionsForLiveTokens(tx, { userId: id })
          : [];
        const revoked = body.banned
          ? await revokeAllMcpTokensForUser(tx, id, "user_banned")
          : [];
        // OAuth grants go the same way (the trigger would catch them, but not
        // with this admin as the audited actor).
        const oauth = body.banned
          ? await revokeOAuthGrants(tx, { userId: id })
          : { revoked: [], cancelled: [] };

        await tx
          .update(user)
          .set({
            banned: body.banned,
            banReason: body.banned ? (body.banReason ?? null) : null,
            updatedAt: now,
          })
          .where(eq(user.id, id));

        for (const t of revoked) {
          await auditOrThrow(tx, {
            action: "mcp_token.revoked",
            actorEmail: adminUser.email,
            actorId: adminUser.id,
            description: `Revoked MCP token ${t.keyPrefix}… for ${target.email} (user banned)`,
            entityId: t.id,
            entityType: "mcp_token",
            metadata: {
              keyPrefix: t.keyPrefix,
              name: t.name,
              reason: "user_banned",
              targetUserId: id,
              targetEmail: target.email,
            },
          });
        }
        for (const c of [...cancelled, ...oauth.cancelled]) {
          await auditOrThrow(
            tx,
            cancelledActionAudit(c, {
              actorEmail: adminUser.email,
              actorId: adminUser.id,
              reason: "token_revoked",
            })
          );
        }
        for (const g of oauth.revoked) {
          await auditOrThrow(
            tx,
            grantRevokedAudit(g, {
              actorEmail: adminUser.email,
              actorId: adminUser.id,
              reason: "user_banned",
            })
          );
        }
      });
    } catch (error) {
      console.error("[users] ban/unban failed", error);
      return NextResponse.json(
        { error: "Failed to update user." },
        { status: 500 }
      );
    }

    // Revoke all active sessions on ban
    if (body.banned) {
      await db.delete(session).where(eq(session.userId, id));
    }

    await audit({
      action: body.banned ? "user.banned" : "user.unbanned",
      actorEmail: adminUser.email,
      actorId: adminUser.id,
      description: body.banned
        ? `Banned ${target.email}${body.banReason ? `: ${body.banReason}` : ""}`
        : `Unbanned ${target.email}`,
      entityId: id,
      entityType: "user",
      metadata: {
        targetEmail: target.email,
        banReason: body.banned ? (body.banReason ?? null) : null,
      },
    });

    return NextResponse.json({ ok: true });
  }

  // Admin-set password (no old password required)
  if (body.password !== undefined) {
    const settings = await getPlatformSettings();
    if (!settings.passwordLoginEnabled) {
      return NextResponse.json(
        { error: "Password sign-in is disabled." },
        { status: 403 }
      );
    }

    try {
      await auth.api.setUserPassword({
        headers: request.headers,
        body: { userId: id, newPassword: body.password },
      });
    } catch (e) {
      if (e instanceof APIError) {
        return NextResponse.json(
          { error: e.message },
          { status: e.statusCode }
        );
      }
      return NextResponse.json(
        { error: "Failed to set password." },
        { status: 500 }
      );
    }

    await audit({
      action: "user.password_set_by_admin",
      actorEmail: adminUser.email,
      actorId: adminUser.id,
      description: `Password set for ${target.email} by ${adminUser.email}`,
      entityId: id,
      entityType: "user",
      metadata: { targetEmail: target.email },
    });

    return NextResponse.json({ ok: true });
  }

  return NextResponse.json(
    { error: "No valid field to update." },
    { status: 400 }
  );
}

// DELETE /api/users/[id] — hard delete user (admin only)
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  let adminUser;
  try {
    adminUser = requireAdminFromRequest(request);
  } catch (e) {
    return e as Response;
  }

  const { id } = await params;

  const [target] = await db.select().from(user).where(eq(user.id, id)).limit(1);
  if (!target) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  // Last admin protection
  if (target.role === ADMIN_ROLE) {
    const adminCount = await getAdminCount();
    if (adminCount <= 1) {
      return NextResponse.json(
        { error: "Cannot delete the last admin." },
        { status: 422 }
      );
    }
  }

  // Hard delete is the erasure path — deactivation (PATCH { banned: true })
  // is what off-boarding should use, since it keeps ticket history readable.
  // Anonymize first: the name snapshots are keyed on FKs that this delete
  // nulls out, so they're unreachable once the user row is gone.
  await db.transaction(async (tx) => {
    await anonymizeUserContent(tx, id);

    // Unassign tickets
    await tx
      .update(tickets)
      .set({ assignedAgentId: null, updatedAt: new Date() })
      .where(eq(tickets.assignedAgentId, id));

    // Delete sessions, accounts, then user (cascade handles sessions + accounts too, but explicit is clearer)
    await tx.delete(session).where(eq(session.userId, id));
    await tx.delete(account).where(eq(account.userId, id));
    await tx.delete(user).where(eq(user.id, id));
  });

  await audit({
    action: "user.deleted",
    actorEmail: adminUser.email,
    actorId: adminUser.id,
    description: `Deleted user ${target.email}`,
    entityId: id,
    entityType: "user",
    metadata: { email: target.email, role: target.role, anonymized: true },
  });

  return NextResponse.json({ ok: true });
}
