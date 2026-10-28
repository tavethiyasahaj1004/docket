import { createId } from "@paralleldrive/cuid2";
import { verification } from "@/db/schema/auth";
import { db } from "@/lib/db";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Mints a token in the row shape Better Auth's `POST /reset-password` expects,
 * so a user with no `credential` account yet can have that endpoint create their
 * password — no second token system. Revisit if an upgrade changes the identifier
 * format. Expiry is 7 days, not the 1-hour default: this activates an account. */
export async function createPasswordSetupToken(
  userId: string
): Promise<string> {
  const token = createId();
  const now = new Date();

  await db.insert(verification).values({
    id: createId(),
    identifier: `reset-password:${token}`,
    value: userId,
    expiresAt: new Date(now.getTime() + SEVEN_DAYS_MS),
    createdAt: now,
    updatedAt: now,
  });

  return token;
}
