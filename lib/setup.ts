import { eq, isNotNull } from "drizzle-orm";
import { cache } from "react";
import { ADMIN_ROLE } from "@/config/platform";
import { user } from "@/db/schema";
import { platformSettings } from "@/db/schema/settings";
import { db } from "@/lib/db";

/** Whether any admin exists — the signal gating the unauthenticated bootstrap
 * paths, which self-disable the moment one does, so they can never mint a second
 * admin on a live install. Not the same as "the wizard is done" (see
 * isSetupComplete). Memoized per-request so every call site shares one query. */
export const hasAdminUser = cache(async (): Promise<boolean> => {
  const [existing] = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, ADMIN_ROLE))
    .limit(1);
  return Boolean(existing);
});

/** Whether the wizard actually finished — `setup_completed_at` stamped by its
 * last step. An admin existing isn't enough: the account is created a step
 * earlier, so reloading /setup mid-wizard must resume it, not bounce to /login. */
export const isSetupComplete = cache(async (): Promise<boolean> => {
  const [existing] = await db
    .select({ id: platformSettings.id })
    .from(platformSettings)
    .where(isNotNull(platformSettings.setupCompletedAt))
    .limit(1);
  return Boolean(existing);
});
