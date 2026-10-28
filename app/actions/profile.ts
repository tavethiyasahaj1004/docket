"use server";

import { and, count, eq, inArray, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ADMIN_ROLE } from "@/config/platform";
import { account, session as sessionTable, user } from "@/db/schema";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/authz";
import { db } from "@/lib/db";
import { createPasswordSetupToken } from "@/lib/password-setup-token";
import { anonymizeUserContent } from "@/lib/user-deletion";

export interface ActionState {
  error?: string;
  success?: string;
}

export async function updateNameAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const session = await requireSession();
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    return { error: "Name is required." };
  }
  if (name.length > 100) {
    return { error: "Name must be 100 characters or fewer." };
  }

  await db
    .update(user)
    .set({ name, updatedAt: new Date() })
    .where(eq(user.id, session.user.id));

  await audit({
    action: "profile.name_updated",
    actorEmail: session.user.email,
    actorId: session.user.id,
    description: "Updated profile name",
    entityId: session.user.id,
    entityType: "user",
    metadata: { name },
  });

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/profile");
  return { success: "Name updated." };
}

export async function changeEmailAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const current = await requireSession();
  const newEmail = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return { error: "Enter a valid email address." };
  }

  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, newEmail))
    .limit(1);

  if (existing && existing.id !== current.user.id) {
    return { error: "That email is already in use." };
  }

  await db
    .update(user)
    .set({
      email: newEmail,
      emailVerified: false,
      updatedAt: new Date(),
    })
    .where(eq(user.id, current.user.id));

  await audit({
    action: "profile.email_updated",
    actorEmail: current.user.email,
    actorId: current.user.id,
    description: "Updated account email",
    entityId: current.user.id,
    entityType: "user",
    metadata: { newEmail, oldEmail: current.user.email },
  });

  revalidatePath("/dashboard");
  revalidatePath("/dashboard/profile");
  return { success: "Email updated. Use the new email for future sign-ins." };
}

/** For a user with no `credential` account yet (magic link or Google only):
 * mints a password-setup token and sends them into Better Auth's reset-password
 * flow. No email round-trip — they're already authenticated, so redirect. */
export async function requestPasswordSetupAction(): Promise<never> {
  const session = await requireSession();
  const token = await createPasswordSetupToken(session.user.id);
  redirect(`/reset-password?token=${token}`);
}

export async function revokeSessionAction(formData: FormData): Promise<void> {
  const current = await requireSession();
  const sessionId = String(formData.get("sessionId") ?? "");

  const [row] = await db
    .select({
      id: sessionTable.id,
      token: sessionTable.token,
      userId: sessionTable.userId,
    })
    .from(sessionTable)
    .where(eq(sessionTable.id, sessionId))
    .limit(1);

  if (!row || row.userId !== current.user.id) {
    return;
  }
  if (row.token === current.session.token) {
    return;
  }

  await db.delete(sessionTable).where(eq(sessionTable.id, sessionId));
  await audit({
    action: "profile.session_revoked",
    actorEmail: current.user.email,
    actorId: current.user.id,
    description: "Revoked an active session",
    entityId: sessionId,
    entityType: "session",
  });

  revalidatePath("/dashboard/profile");
}

export async function signOutOtherSessionsAction(): Promise<void> {
  const current = await requireSession();
  const rows = await db
    .select({ id: sessionTable.id })
    .from(sessionTable)
    .where(
      and(
        eq(sessionTable.userId, current.user.id),
        ne(sessionTable.token, current.session.token)
      )
    );

  const ids = rows.map((row) => row.id);
  if (ids.length > 0) {
    await db.delete(sessionTable).where(inArray(sessionTable.id, ids));
  }

  await audit({
    action: "profile.other_sessions_revoked",
    actorEmail: current.user.email,
    actorId: current.user.id,
    description: `Signed out ${ids.length} other session(s)`,
    entityId: current.user.id,
    entityType: "user",
    metadata: { revokedCount: ids.length },
  });

  revalidatePath("/dashboard/profile");
}

export async function deleteAccountAction(
  _state: ActionState,
  formData: FormData
): Promise<ActionState> {
  const current = await requireSession();
  const confirmEmail = String(formData.get("confirmEmail") ?? "")
    .trim()
    .toLowerCase();

  const [freshUser] = await db
    .select({ email: user.email, id: user.id })
    .from(user)
    .where(eq(user.id, current.user.id))
    .limit(1);

  if (!freshUser) {
    return { error: "Account not found." };
  }

  if (confirmEmail !== freshUser.email.toLowerCase()) {
    return { error: "Type your email address to confirm deletion." };
  }

  // The sole admin deleting themselves would leave the instance with no one
  // able to reach /admin — mirrors the same guard on demoting the last admin.
  if (current.user.role === ADMIN_ROLE) {
    const [{ total: adminCount }] = await db
      .select({ total: count() })
      .from(user)
      .where(eq(user.role, ADMIN_ROLE));
    if (Number(adminCount) <= 1) {
      return {
        error:
          "You're the only admin — promote another user to admin before deleting your account.",
      };
    }
  }

  await audit({
    action: "profile.account_deleted",
    actorEmail: freshUser.email,
    actorId: freshUser.id,
    description: "Deleted account",
    entityId: freshUser.id,
    entityType: "user",
  });

  await db.transaction(async (tx) => {
    // Same erasure semantics as the admin delete route — scrub the name
    // snapshots while the FKs still resolve, then drop the account.
    await anonymizeUserContent(tx, freshUser.id);
    await tx.delete(sessionTable).where(eq(sessionTable.userId, freshUser.id));
    await tx.delete(account).where(eq(account.userId, freshUser.id));
    await tx.delete(user).where(eq(user.id, freshUser.id));
  });

  redirect("/login");
}
