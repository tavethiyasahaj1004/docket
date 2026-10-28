import { and, eq, or } from "drizzle-orm";
import { user } from "@/db/schema/auth";
import { db } from "@/lib/db";

/** Non-banned agents and admins. */
export async function listActiveAgents() {
  return await db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
    })
    .from(user)
    .where(
      and(
        or(eq(user.role, "agent"), eq(user.role, "admin")),
        eq(user.banned, false)
      )
    );
}
