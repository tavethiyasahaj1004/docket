import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { ADMIN_ROLE } from "@/config/platform";

export class AdminCreationError extends Error {}

export interface CreateAdminInput {
  email: string;
  name: string;
  /** Omit to create a magic-link-only admin (requires SMTP to sign in). */
  password?: string;
}

export interface CreateAdminResult {
  email: string;
  hasPassword: boolean;
  name: string;
}

/** Creates an admin directly — with no self-service sign-up, the only way a
 * password account comes into existence. Called in-process by both the
 * `create:admin` and `setup` scripts, never shelled out, so a password with
 * shell-special characters can't be mangled by argument quoting. */
export async function createAdminUser({
  email,
  name,
  password,
}: CreateAdminInput): Promise<CreateAdminResult> {
  if (password && password.length < 8) {
    throw new AdminCreationError("Password must be at least 8 characters.");
  }

  const [{ db }, { user }] = await Promise.all([
    import("@/lib/db"),
    import("@/db/schema"),
  ]);

  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, email))
    .limit(1);

  if (existing) {
    throw new AdminCreationError(
      `A user with email ${email} already exists. Use pnpm make:admin to promote them.`
    );
  }

  if (password) {
    // Go through Better Auth's own sign-up so the password is hashed and
    // stored exactly the way sign-in later expects it.
    const { auth } = await import("@/lib/auth");
    const result = await auth.api.signUpEmail({
      body: { email, name, password },
    });

    await db
      .update(user)
      .set({ role: ADMIN_ROLE, emailVerified: true, updatedAt: new Date() })
      .where(eq(user.id, result.user.id));

    return { email, name, hasPassword: true };
  }

  const now = new Date();
  const [created] = await db
    .insert(user)
    .values({
      id: createId(),
      email,
      name,
      emailVerified: true,
      role: ADMIN_ROLE,
      banned: false,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ email: user.email, name: user.name });

  return { email: created.email, name: created.name, hasPassword: false };
}
